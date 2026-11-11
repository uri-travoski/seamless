import type { FastifyInstance } from 'fastify';
import { snoozeThread, unsnoozeThread } from '../mail/snooze.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  app.post('/api/snooze', async (req, reply) => {
    const b = (req.body ?? {}) as { emailId?: string; until?: number };
    try {
      const n = await snoozeThread(uid(req), String(b.emailId ?? ''), Number(b.until));
      return { ok: true, snoozed: n };
    } catch (err: any) {
      return reply.code(err?.message === 'not found' ? 404 : 400).send({ error: err?.message ?? 'could not snooze' });
    }
  });

  app.delete('/api/snooze/:threadId', async (req) => {
    const ok = await unsnoozeThread(uid(req), decodeURIComponent((req.params as any).threadId), { wake: false });
    return { ok };
  });
}
