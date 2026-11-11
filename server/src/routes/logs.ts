/** Processing logs. */
import type { FastifyInstance } from 'fastify';
import { q, one, run } from '../db.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- processing logs ----
  app.get('/api/logs', async (req) => {
    const kind = (req.query as any).kind as string | undefined;
    const limit = Math.min(Number((req.query as any).limit) || 200, 1000);
    // user_id IS NULL covers instance-level entries (backup) that belong to no one user
    const rows = kind
      ? await q('SELECT id, email_id, kind, level, message, created_at FROM processing_logs WHERE (user_id = ? OR user_id IS NULL) AND kind = ? ORDER BY id DESC LIMIT ?', [uid(req), kind, limit])
      : await q('SELECT id, email_id, kind, level, message, created_at FROM processing_logs WHERE (user_id = ? OR user_id IS NULL) ORDER BY id DESC LIMIT ?', [uid(req), limit]);
    return rows.map((r: any) => ({ id: r.id, emailId: r.email_id, kind: r.kind, level: r.level, message: r.message, createdAt: new Date(r.created_at).toISOString() }));
  });

  app.delete('/api/logs', async (req) => {
    await run('DELETE FROM processing_logs WHERE user_id = ?', [uid(req)]);
    return { ok: true };
  });
}
