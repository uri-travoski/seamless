/** Templates (T1 F-12): CRUD, use counter. Rendering happens in the compose window (shared/templates.ts). */
import type { FastifyInstance } from 'fastify';
import type { ApiTemplate } from '@seamless/shared';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';

function toApi(r: any): ApiTemplate {
  return {
    id: r.id, name: r.name, category: r.category, subject: r.subject, bodyHtml: r.body_html,
    accountId: r.account_id, shortcut: r.shortcut, useCount: r.use_count, updatedAt: Number(r.updated_at),
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
    const now = Date.now();
    if (id === null) {
      const newId = await insertId(`INSERT INTO templates(user_id, name, category, subject, body_html, account_id, shortcut, created_at, updated_at)
                                    VALUES (?,?,?,?,?,?,?,?,?)`,
        [userId, name, String(b.category ?? '').trim(), String(b.subject ?? ''), String(b.bodyHtml ?? ''), accountId, shortcut, now, now]);
      await changed(userId);
      return { id: newId };
    }
    const n = await run(`UPDATE templates SET name=?, category=?, subject=?, body_html=?, account_id=?, shortcut=?, updated_at=? WHERE id=? AND user_id=?`,
      [name, String(b.category ?? '').trim(), String(b.subject ?? ''), String(b.bodyHtml ?? ''), accountId, shortcut, now, id, userId]);
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
    await run('UPDATE templates SET use_count = use_count + 1 WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });
}
