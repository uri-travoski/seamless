import { currentMode } from '../mode.ts';
import type { FastifyInstance } from 'fastify';
import { one, run } from '../db.ts';
import { healthReport, mailboxHealth, liveness, storageProbe } from '../health/status.ts';
import { syncManager } from '../imap/sync.ts';
import { broadcast } from '../ws.ts';
import { uid, isAdmin } from './util.ts';
import { startBackfill, backfillStatus } from '../mail/attachmentText.ts';

export function register(app: FastifyInstance): void {
  app.get('/api/health', async (req) => healthReport(uid(req), isAdmin(req)));

  // the status dot in the top bar: only the mailboxes that matter (not the ones set to "ignore")
  app.get('/api/health/mailboxes', async (req) => {
    const rows = (await mailboxHealth(uid(req))).filter((m) => !m.ignored);
    const status = rows.some((m) => m.status === 'red') ? 'red' : rows.some((m) => m.status === 'warn') ? 'warn' : 'ok';
    return { status, problems: rows.filter((m) => m.status !== 'ok').map((m) => ({ email: m.email, status: m.status, error: m.lastError, paused: !m.enabled })) };
  });

  /** Public, for an uptime monitor: only "is it up". */
  app.get('/healthz', async (_req, reply) => {
    const r = await liveness();
    return reply.code(r.ok ? 200 : 503).send({ ...r, mode: currentMode() });
  });

  app.post('/api/health/storage-check', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admins only' });
    return storageProbe(Date.now(), true);
  });

  // T6.2: "Index attachments of existing mail" — resumable backfill of the signed-in admin's mail
  app.post('/api/health/attachment-index', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admins only' });
    await startBackfill(uid(req), !!(req.body as any)?.restart);
    return backfillStatus(uid(req));
  });

  app.post('/api/accounts/:id/health-ignore', async (req, reply) => {
    const id = Number((req.params as any).id);
    const ignored = !!(req.body as any)?.ignored;
    const a = await one('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [id, uid(req)]);
    if (!a) return reply.code(404).send({ error: 'not found' });
    await run('UPDATE accounts SET health_ignored = ? WHERE id = ?', [ignored, id]);
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true, ignored };
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
