/** Filter engine CRUD + run-over-existing. */
import type { FastifyInstance } from 'fastify';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { moveEmail } from '../mail/store.ts';
import { loadFilters, filterMatches, type FilterableMessage } from '../mail/filters.ts';
import { applyLocalFilterActions } from '../mail/ingest.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- filters ----
  app.get('/api/filters', async (req) => loadFilters(uid(req)));

  app.post('/api/filters', async (req) => {
    const b = req.body as any;
    const id = await insertId('INSERT INTO filters(user_id, name, enabled, sort, match, conditions, actions, stop) VALUES (?,?,?,?,?,?,?,?)',
      [uid(req), b.name, b.enabled !== false, b.sort ?? 0, b.match ?? 'all', JSON.stringify(b.conditions ?? []), JSON.stringify(b.actions ?? []), !!b.stop]);
    return { id };
  });

  app.put('/api/filters/:id', async (req) => {
    const b = req.body as any;
    await run('UPDATE filters SET name=?, enabled=?, sort=?, match=?, conditions=?, actions=?, stop=? WHERE id=? AND user_id=?',
      [b.name, b.enabled !== false, b.sort ?? 0, b.match ?? 'all', JSON.stringify(b.conditions ?? []), JSON.stringify(b.actions ?? []), !!b.stop, Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.delete('/api/filters/:id', async (req) => {
    await run('DELETE FROM filters WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  /** Apply one filter to all existing inbox mail. */
  app.post('/api/filters/:id/run', async (req) => {
    const userId = uid(req);
    const filter = (await loadFilters(userId)).find((f) => f.id === Number((req.params as any).id));
    if (!filter) return { applied: 0 };
    const rows = await q<any>(`
      SELECT m.id, m.subject, m.from_name, m.from_addr, m.to_json, m.cc_json, m.has_attachments, a.email AS account_email
      FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id JOIN accounts a ON a.id = m.account_id
      WHERE mb.role = 'inbox' AND m.user_id = ?
    `, [userId]);
    let applied = 0;
    for (const r of rows) {
      const body = (await one<{ body: string }>('SELECT body FROM message_fts WHERE message_id = ?', [r.id]))?.body ?? '';
      const fmsg: FilterableMessage = {
        from: `${r.from_name} <${r.from_addr}>`,
        to: (JSON.parse(r.to_json) as any[]).map((a) => `${a.name} <${a.email}>`).join(', '),
        cc: (JSON.parse(r.cc_json) as any[]).map((a) => `${a.name} <${a.email}>`).join(', '),
        subject: r.subject, body,
        hasAttachment: !!r.has_attachments,
        accountEmail: r.account_email,
      };
      if (filterMatches(fmsg, filter)) {
        applied++;
        await applyLocalFilterActions(r.id, filter.actions);
        const move = filter.actions.find((a) => a.type === 'move' || a.type === 'delete');
        if (move) await moveEmail(userId, `m${r.id}`, move.type === 'delete' ? 'u:trash' : (move.value?.startsWith('mb:') || move.value?.startsWith('u:') ? move.value : `u:${move.value}`));
      }
    }
    await bumpState(); broadcast({ type: 'stateChange' }, userId);
    return { applied };
  });
}
