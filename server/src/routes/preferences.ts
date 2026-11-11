/** Plain-English AI guidance (versioned). */
import type { FastifyInstance } from 'fastify';
import { q, run, insertId } from '../db.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- preferences (plain-English AI guidance, versioned) ----
  app.get('/api/preferences', async (req) =>
    (await q('SELECT id, enabled, guidance, version FROM preferences WHERE user_id = ? AND active = true ORDER BY id', [uid(req)]))
      .map((p: any) => ({ id: p.id, enabled: p.enabled, guidance: p.guidance, version: p.version })));

  app.post('/api/preferences', async (req) => {
    const b = req.body as any;
    const id = await insertId('INSERT INTO preferences(user_id, enabled, guidance, version, active, created_at) VALUES (?,?,?,1,true,?)',
      [uid(req), b.enabled !== false, b.guidance ?? '', Date.now()]);
    return { id };
  });

  app.put('/api/preferences/:id', async (req) => {
    const b = req.body as any;
    // editing bumps the version (audit trail for phase-3 ai_decisions)
    await run('UPDATE preferences SET enabled=?, guidance=?, version = version + 1 WHERE id=? AND user_id=?',
      [b.enabled !== false, b.guidance ?? '', Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.delete('/api/preferences/:id', async (req) => {
    await run('UPDATE preferences SET active = false WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });
}
