import type { FastifyInstance } from 'fastify';
import { one, run } from '../db.ts';
import { healthReport, liveness, storageProbe } from '../health/status.ts';
import { syncManager } from '../imap/sync.ts';
import { broadcast } from '../ws.ts';
import { uid, isAdmin } from './util.ts';

export function register(app: FastifyInstance): void {
  app.get('/api/health', async (req) => healthReport(uid(req), isAdmin(req)));

  /** Public, for an uptime monitor: only "is it up". */
  app.get('/healthz', async (_req, reply) => {
    const r = await liveness();
    return reply.code(r.ok ? 200 : 503).send(r);
  });

  app.post('/api/health/storage-check', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admins only' });
    return storageProbe(Date.now(), true);
  });

  app.post('/api/accounts/:id/resync', async (req, reply) => {
    const id = Number((req.params as any).id);
    const a = await one('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [id, uid(req)]);
    if (!a) return reply.code(404).send({ error: 'not found' });
    await syncManager.restartAccount(id);
    return { ok: true };
  });

  app.post('/api/jobs/:id/retry', async (req, reply) => {
    const n = await run(`UPDATE jobs SET status = 'pending', attempts = 0, run_at = ?, last_error = NULL, finished_at = NULL, locked_until = NULL
                         WHERE id = ? AND user_id = ? AND status = 'failed'`, [Date.now(), Number((req.params as any).id), uid(req)]);
    if (!n) return reply.code(404).send({ error: 'not found' });
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const n = await run(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND user_id = ? AND status IN ('pending','failed')`,
      [Date.now(), Number((req.params as any).id), uid(req)]);
    if (!n) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });
}
