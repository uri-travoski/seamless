/** Templates (T1 F-12): CRUD, use counter. Rendering happens in the compose window (shared/templates.ts). */
import type { FastifyInstance } from 'fastify';
import type { ApiTemplate } from '@seamless/shared';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';
import { hasAiPlaceholders } from '@seamless/shared';
import { renderServerTemplate, markUsed } from '../templates/render.ts';

function toApi(r: any): ApiTemplate {
  return {
    id: r.id, name: r.name, category: r.category, subject: r.subject, bodyHtml: r.body_html,
    accountId: r.account_id, shortcut: r.shortcut, useCount: r.use_count, updatedAt: Number(r.updated_at),
    businessId: r.business_id, pinned: r.pinned, pinOrder: r.pin_order, sendDirect: r.send_direct,
    lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at), kind: r.kind === 'marketing' ? 'marketing' : 'reply',
    hasAi: hasAiPlaceholders(r.subject, r.body_html),
  };
}

/** ';quote' style: a leading ';' then letters/digits/-/_ (stored without spaces, lowercase). */
function cleanShortcut(s: unknown): string | null {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v) return null;
  const withSemi = v.startsWith(';') ? v : `;${v}`;
  return /^;[a-z0-9_-]{1,30}$/.test(withSemi) ? withSemi : null;
}

export function register(app: FastifyInstance): void {
  const changed = async (userId: number) => { await bumpState(); broadcast({ type: 'stateChange' }, userId); };

  app.get('/api/templates', async (req) =>
    (await q('SELECT * FROM templates WHERE user_id = ? ORDER BY lower(category), lower(name)', [uid(req)])).map(toApi));

  const save = async (req: any, reply: any, id: number | null) => {
    const userId = uid(req);
    const b = req.body as Partial<ApiTemplate>;
    const name = String(b.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    const shortcut = b.shortcut ? cleanShortcut(b.shortcut) : null;
    if (b.shortcut && !shortcut) return reply.code(400).send({ error: 'shortcuts are ; followed by letters or digits, e.g. ;quote' });
    if (shortcut) {
      const clash = await one<{ id: number }>('SELECT id FROM templates WHERE user_id = ? AND shortcut = ?', [userId, shortcut]);
      if (clash && clash.id !== id) return reply.code(400).send({ error: `${shortcut} is already used by another template` });
    }
    const accountId = b.accountId ? ((await one('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?', [b.accountId, userId])) ? b.accountId : null) : null;
    let businessId: number | null = null;
    if (b.businessId) {
      if (!(await one('SELECT 1 FROM businesses WHERE id = ? AND user_id = ?', [b.businessId, userId]))) return reply.code(400).send({ error: 'unknown business' });
      businessId = b.businessId;
    }
    const kind = b.kind === 'marketing' ? 'marketing' : 'reply';
    const pinned = !!b.pinned;
    const pinOrder = Number.isFinite(Number(b.pinOrder)) ? Math.trunc(Number(b.pinOrder)) : 0;
    // AI-filled text always needs a human look: never "safe to send directly"
    const sendDirect = !!b.sendDirect && !hasAiPlaceholders(String(b.subject ?? ''), String(b.bodyHtml ?? ''));
    const now = Date.now();
    if (id === null) {
      const newId = await insertId(`INSERT INTO templates(user_id, name, category, subject, body_html, account_id, shortcut, created_at, updated_at, business_id, pinned, pin_order, send_direct, kind)
                                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [userId, name, String(b.category ?? '').trim(), String(b.subject ?? ''), String(b.bodyHtml ?? ''), accountId, shortcut, now, now, businessId, pinned, pinOrder, sendDirect, kind]);
      await changed(userId);
      return { id: newId };
    }
    const n = await run(`UPDATE templates SET name=?, category=?, subject=?, body_html=?, account_id=?, shortcut=?, updated_at=?, business_id=?, pinned=?, pin_order=?, send_direct=?, kind=? WHERE id=? AND user_id=?`,
      [name, String(b.category ?? '').trim(), String(b.subject ?? ''), String(b.bodyHtml ?? ''), accountId, shortcut, now, businessId, pinned, pinOrder, sendDirect, kind, id, userId]);
    if (!n) return reply.code(404).send({ error: 'not found' });
    await changed(userId);
    return { ok: true };
  };

  app.post('/api/templates', async (req, reply) => save(req, reply, null));
  app.put('/api/templates/:id', async (req, reply) => save(req, reply, Number((req.params as any).id)));

  app.delete('/api/templates/:id', async (req) => {
    await run('DELETE FROM templates WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    await changed(uid(req));
    return { ok: true };
  });

  app.post('/api/templates/:id/use', async (req) => {
    await markUsed(uid(req), Number((req.params as any).id));
    return { ok: true };
  });

  /** Variables + {{ai:}} filled server-side. Counts as a use. */
  app.post('/api/templates/:id/render', async (req, reply) => {
    const b = (req.body ?? {}) as { emailId?: string; identityId?: number };
    const id = Number((req.params as any).id);
    const out = await renderServerTemplate(uid(req), id, b.emailId, b.identityId);
    if (!out) return reply.code(404).send({ error: 'not found' });
    await markUsed(uid(req), id);
    return out;
  });
}
