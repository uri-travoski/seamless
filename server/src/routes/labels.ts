/** Labels. */
import type { FastifyInstance } from 'fastify';
import { q, run, insertId, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { recomputeDisposition } from '../classify/engine.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  app.get('/api/labels', async (req) =>
    (await q('SELECT id, name, color, description, sort, keep_default, retention_days, protected, auto_mark_read FROM labels WHERE user_id = ? ORDER BY sort, name', [uid(req)]))
      .map((l: any) => ({
        id: l.id, name: l.name, color: l.color, description: l.description, sort: l.sort,
        keepDefault: l.keep_default, retentionDays: l.retention_days, protected: l.protected, autoMarkRead: l.auto_mark_read,
      })));

  app.post('/api/labels', async (req) => {
    const b = req.body as any;
    const id = await insertId('INSERT INTO labels(user_id, name, color, description, sort, keep_default, retention_days, protected, auto_mark_read) VALUES (?,?,?,?,?,?,?,?,?)',
      [uid(req), b.name, b.color ?? '#e05656', b.description ?? '', b.sort ?? 0,
       !!b.keepDefault, b.retentionDays ?? null, !!b.protected, !!b.autoMarkRead]);
    await bumpState(); broadcast({ type: 'stateChange' }, uid(req));
    return { id };
  });

  app.put('/api/labels/:id', async (req) => {
    const b = req.body as any;
    const id = Number((req.params as any).id);
    await run('UPDATE labels SET name=?, color=?, description=?, sort=?, keep_default=?, retention_days=?, protected=?, auto_mark_read=? WHERE id=? AND user_id=?',
      [b.name, b.color, b.description ?? '', b.sort ?? 0,
       !!b.keepDefault, b.retentionDays ?? null, !!b.protected, !!b.autoMarkRead, id, uid(req)]);
    // retention semantics may have changed: recompute dispositions of everything carrying this label
    const affected = await q<{ message_id: number }>('SELECT message_id FROM message_labels WHERE label_id = ?', [id]);
    for (const a of affected) await recomputeDisposition(a.message_id);
    await bumpState(); broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  app.delete('/api/labels/:id', async (req) => {
    await run('DELETE FROM labels WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    await bumpState(); broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });
}
