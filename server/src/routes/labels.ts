/** Labels (T1 F-11): counts, nesting, sidebar visibility, merge, bulk delete. */
import type { FastifyInstance } from 'fastify';
import { q, one, run, insertId, bumpState, withTransaction, clientQuery } from '../db.ts';
import { broadcast } from '../ws.ts';
import { recomputeDisposition } from '../classify/engine.ts';
import { scopeAccountIds } from '../mail/categories.ts';
import { uid } from './util.ts';
import { acceptedSharedLabels } from '../mail/sharedLabels.ts';

const VIS = new Set(['always', 'unread', 'hidden']);

/** A label may not become its own ancestor. */
async function wouldCycle(userId: number, id: number, parentId: number | null): Promise<boolean> {
  let cur = parentId;
  for (let i = 0; cur && i < 50; i++) {
    if (cur === id) return true;
    cur = (await one<{ parent_id: number | null }>('SELECT parent_id FROM labels WHERE id = ? AND user_id = ?', [cur, userId]))?.parent_id ?? null;
  }
  return false;
}

/** Labels nest one level only: the parent must be top level and the label itself must not have sub-labels. */
async function nestingError(userId: number, id: number | null, parentId: number | null): Promise<string | null> {
  if (!parentId) return null;
  const p = await one<{ parent_id: number | null; name: string }>('SELECT parent_id, name FROM labels WHERE id = ? AND user_id = ?', [parentId, userId]);
  if (p?.parent_id) return `"${p.name}" is already inside another label — labels can only be nested one level`;
  if (id && await one('SELECT 1 FROM labels WHERE parent_id = ? AND user_id = ?', [id, userId])) {
    return 'This label has sub-labels, so it cannot be put inside another label (only one level of nesting). Move its sub-labels out first.';
  }
  return null;
}

/** Names of labels in `ids` that still have sub-labels outside `ids` (those parents may not be deleted yet). */
async function parentsWithChildren(userId: number, ids: number[]): Promise<string[]> {
  const rows = await q<{ name: string }>(`SELECT DISTINCT p.name FROM labels p JOIN labels c ON c.parent_id = p.id AND c.user_id = p.user_id
    WHERE p.user_id = ? AND p.id = ANY(?::int[]) AND NOT (c.id = ANY(?::int[]))`, [userId, ids, ids]);
  return rows.map((r) => r.name);
}

async function validParent(userId: number, parentId: unknown): Promise<number | null> {
  const p = Number(parentId);
  if (!p) return null;
  return (await one('SELECT 1 FROM labels WHERE id = ? AND user_id = ?', [p, userId])) ? p : null;
}

/** Merge `sourceId` into `targetId`: messages, rules, routes, notes, memory all follow; source is deleted. */
export async function mergeLabels(userId: number, sourceId: number, targetId: number): Promise<number> {
  if (sourceId === targetId) throw new Error('pick two different labels');
  const both = await q('SELECT id FROM labels WHERE user_id = ? AND id = ANY(?::int[])', [userId, [sourceId, targetId]]);
  if (both.length !== 2) throw new Error('label not found');
  const tgt = await one<{ parent_id: number | null }>('SELECT parent_id FROM labels WHERE id = ? AND user_id = ?', [targetId, userId]);
  const srcKids = await one('SELECT 1 FROM labels WHERE parent_id = ? AND user_id = ?', [sourceId, userId]);
  if (srcKids && (tgt?.parent_id || false)) throw new Error('This label has sub-labels and the label you are merging into is itself nested — only one level of nesting is allowed. Move the sub-labels out first.');
  if (tgt?.parent_id === sourceId) throw new Error('Cannot merge a parent label into one of its own sub-labels. Move the sub-label out first.');
  return withTransaction(async (c) => {
    const moved = await clientQuery(c, `INSERT INTO message_labels(message_id, label_id)
      SELECT message_id, ? FROM message_labels WHERE label_id = ? ON CONFLICT DO NOTHING RETURNING message_id`, [targetId, sourceId]);
    for (const t of ['rules', 'routes', 'processor_notes', 'email_vectors']) {
      await clientQuery(c, `UPDATE ${t} SET label_id = ? WHERE label_id = ?`, [targetId, sourceId]);
    }
    await clientQuery(c, `DELETE FROM rule_suggestions s WHERE label_id = ? AND EXISTS (
      SELECT 1 FROM rule_suggestions t WHERE t.user_id = s.user_id AND t.match_field = s.match_field AND t.match_value = s.match_value AND t.label_id = ?)`, [sourceId, targetId]);
    await clientQuery(c, 'UPDATE rule_suggestions SET label_id = ? WHERE label_id = ?', [targetId, sourceId]);
    await clientQuery(c, 'UPDATE labels SET parent_id = ? WHERE parent_id = ? AND user_id = ?', [targetId, sourceId, userId]);
    // filter actions keep label ids as strings inside JSON
    const filters = await clientQuery<{ id: number; actions: string }>(c, 'SELECT id, actions FROM filters WHERE user_id = ?', [userId]);
    for (const f of filters) {
      const actions = JSON.parse(f.actions) as { type: string; value?: string }[];
      let changed = false;
      for (const a of actions) if (a.type === 'label' && String(a.value) === String(sourceId)) { a.value = String(targetId); changed = true; }
      if (changed) await clientQuery(c, 'UPDATE filters SET actions = ? WHERE id = ?', [JSON.stringify(actions), f.id]);
    }
    await clientQuery(c, 'DELETE FROM labels WHERE id = ? AND user_id = ?', [sourceId, userId]);
    return moved.length;
  });
}

export function register(app: FastifyInstance): void {
  const changed = async (userId: number) => { await bumpState(); broadcast({ type: 'stateChange' }, userId); };

  /** ?scope= limits the counts to the switcher's current scope. */
  app.get('/api/labels', async (req) => {
    const userId = uid(req);
    const inScope = await scopeAccountIds(userId, (req.query as any)?.scope);
    const counts = await q<{ label_id: number; total: number; unread: number }>(`
      SELECT ml.label_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE m.unread) AS unread
      FROM message_labels ml JOIN messages m ON m.id = ml.message_id
      JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE m.user_id = ? AND (mb.role IS NULL OR mb.role NOT IN ('trash','junk'))
        ${inScope ? 'AND m.account_id = ANY(?::int[])' : ''}
      GROUP BY ml.label_id`, inScope ? [userId, inScope] : [userId]);
    const byId = new Map(counts.map((c) => [c.label_id, c]));
    const own = (await q('SELECT * FROM labels WHERE user_id = ? ORDER BY sort, lower(name)', [userId])).map((l: any) => ({
      id: l.id, name: l.name, color: l.color, description: l.description, sort: l.sort,
      keepDefault: l.keep_default, retentionDays: l.retention_days, protected: l.protected, autoMarkRead: l.auto_mark_read,
      parentId: l.parent_id, sidebarVisibility: l.sidebar_visibility,
      total: byId.get(l.id)?.total ?? 0, unread: byId.get(l.id)?.unread ?? 0,
    }));
    // T8.2: labels other people shared with me (accepted): read-only, counted over the shared mailboxes they apply to
    const sharedMap = await acceptedSharedLabels(userId);
    if (!sharedMap.size) return own;
    const sc = await q<{ label_id: number; account_id: number; total: number; unread: number }>(`
      SELECT ml.label_id, m.account_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE m.unread) AS unread
      FROM message_labels ml JOIN messages m ON m.id = ml.message_id JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE ml.label_id = ANY(?::int[]) AND m.user_id <> ? AND (mb.role IS NULL OR mb.role NOT IN ('trash','junk'))
      GROUP BY ml.label_id, m.account_id`, [[...sharedMap.keys()], userId]);
    const shared = [...sharedMap.entries()].map(([id, l]) => {
      const rows = sc.filter((r) => r.label_id === id && l.accountIds.includes(r.account_id) && (!inScope || inScope.includes(r.account_id)));
      return {
        id, name: l.name, color: l.color, description: l.description, sort: 0, keepDefault: false, retentionDays: null, protected: false, autoMarkRead: false,
        parentId: null, sidebarVisibility: 'always', total: rows.reduce((n, r) => n + Number(r.total), 0), unread: rows.reduce((n, r) => n + Number(r.unread), 0),
        shared: true, sharedBy: l.ownerName, sharedAccountIds: l.accountIds,
      };
    });
    return [...own, ...shared];
  });

  app.post('/api/labels', async (req, reply) => {
    const b = req.body as any;
    const userId = uid(req);
    if (!String(b.name ?? '').trim()) return reply.code(400).send({ error: 'name required' });
    if (await one('SELECT 1 FROM labels WHERE user_id = ? AND name = ?', [userId, String(b.name).trim()])) {
      return reply.code(400).send({ error: 'a label with that name already exists' });
    }
    { const bad = await nestingError(userId, null, await validParent(userId, b.parentId)); if (bad) return reply.code(400).send({ error: bad }); }
    const id = await insertId(`INSERT INTO labels(user_id, name, color, description, sort, keep_default, retention_days, protected, auto_mark_read, parent_id, sidebar_visibility)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [userId, String(b.name).trim(), b.color ?? '#e05656', b.description ?? '', b.sort ?? 0,
       !!b.keepDefault, b.retentionDays ?? null, !!b.protected, !!b.autoMarkRead,
       await validParent(userId, b.parentId), VIS.has(b.sidebarVisibility) ? b.sidebarVisibility : 'always']);
    await changed(userId);
    return { id };
  });

  // registered before /:id
  app.put('/api/labels/order', async (req) => {
    const ids = ((req.body as any)?.ids ?? []) as number[];
    let i = 1;
    for (const id of ids) await run('UPDATE labels SET sort = ? WHERE id = ? AND user_id = ?', [i++ * 10, Number(id), uid(req)]);
    await changed(uid(req));
    return { ok: true };
  });

  app.post('/api/labels/merge', async (req, reply) => {
    const b = req.body as { sourceId: number; targetId: number };
    try {
      const moved = await mergeLabels(uid(req), Number(b.sourceId), Number(b.targetId));
      await changed(uid(req));
      return { ok: true, moved };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'merge failed' });
    }
  });

  app.post('/api/labels/delete', async (req, reply) => {
    const ids = (((req.body as any)?.ids ?? []) as number[]).map(Number).filter(Boolean);
    const blocked = ids.length ? await parentsWithChildren(uid(req), ids) : [];
    if (blocked.length) return reply.code(409).send({ error: `${blocked.map((n) => `"${n}"`).join(', ')} still ha${blocked.length === 1 ? 's' : 've'} sub-labels. Delete or move the sub-labels first.`, blocked });
    const n = ids.length ? await run('DELETE FROM labels WHERE user_id = ? AND id = ANY(?::int[])', [uid(req), ids]) : 0;
    await changed(uid(req));
    return { deleted: n };
  });

  app.put('/api/labels/:id', async (req, reply) => {
    const b = req.body as any;
    const userId = uid(req);
    const id = Number((req.params as any).id);
    const cur = await one<any>('SELECT * FROM labels WHERE id = ? AND user_id = ?', [id, userId]);
    if (!cur) return reply.code(404).send({ error: 'not found' });
    const parentId = b.parentId === undefined ? cur.parent_id : await validParent(userId, b.parentId);
    if (await wouldCycle(userId, id, parentId)) return reply.code(400).send({ error: 'a label cannot be nested inside itself' });
    if (parentId !== cur.parent_id) { const bad = await nestingError(userId, id, parentId); if (bad) return reply.code(400).send({ error: bad }); }
    await run(`UPDATE labels SET name=?, color=?, description=?, sort=?, keep_default=?, retention_days=?, protected=?, auto_mark_read=?,
               parent_id=?, sidebar_visibility=? WHERE id=? AND user_id=?`,
      [b.name ?? cur.name, b.color ?? cur.color, b.description ?? cur.description ?? '', b.sort ?? cur.sort ?? 0,
       b.keepDefault ?? cur.keep_default, b.retentionDays === undefined ? cur.retention_days : b.retentionDays,
       b.protected ?? cur.protected, b.autoMarkRead ?? cur.auto_mark_read,
       parentId, VIS.has(b.sidebarVisibility) ? b.sidebarVisibility : cur.sidebar_visibility, id, userId]);
    // retention semantics may have changed: recompute dispositions of everything carrying this label
    const affected = await q<{ message_id: number }>('SELECT message_id FROM message_labels WHERE label_id = ?', [id]);
    for (const a of affected) await recomputeDisposition(a.message_id);
    await changed(userId);
    return { ok: true };
  });

  app.delete('/api/labels/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const blocked = await parentsWithChildren(uid(req), [id]);
    if (blocked.length) return reply.code(409).send({ error: `"${blocked[0]}" still has sub-labels. Delete or move the sub-labels first.`, blocked });
    await run('DELETE FROM labels WHERE id = ? AND user_id = ?', [id, uid(req)]);
    await changed(uid(req));
    return { ok: true };
  });
}
