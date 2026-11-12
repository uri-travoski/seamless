/** Live / Viewing mode (T8.7): read by everyone logged in (also in /api/me), switched by admins only. */
import type { FastifyInstance } from 'fastify';
import { describeMode, switchMode, ModeError } from '../modeSwitch.ts';
import { isAdmin } from './util.ts';

export function register(app: FastifyInstance): void {
  app.get('/api/mode', async () => describeMode());

  app.put('/api/mode', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admins only' });
    const b = (req.body ?? {}) as { mode?: string; confirm?: string; stale?: string };
    try {
      const r = await switchMode(b.mode as any, { confirm: b.confirm, stale: b.stale === 'keep' ? 'keep' : 'discard' });
      return { ok: true, ...r, ...(await describeMode()) };
    } catch (e: any) {
      if (e instanceof ModeError) return reply.code(e.status).send({ error: e.code ?? e.message, message: e.message });
      throw e;
    }
  });
}
