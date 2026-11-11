import type { FastifyInstance } from 'fastify';
import { createFollowup, cancelFollowup, listFollowups } from '../mail/followups.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  app.post('/api/followups', async (req, reply) => {
    const b = (req.body ?? {}) as { emailId?: string; dueAt?: number };
    try {
      const id = await createFollowup(uid(req), String(b.emailId ?? ''), Number(b.dueAt));
      broadcast({ type: 'stateChange' }, uid(req));
      return { ok: true, id };
    } catch (err: any) {
      return reply.code(err?.message === 'not found' ? 404 : 400).send({ error: err?.message ?? 'could not create reminder' });
    }
  });

  app.delete('/api/followups/:id', async (req, reply) => {
    const ok = await cancelFollowup(uid(req), Number((req.params as any).id));
    return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  app.get('/api/followups', async (req) => listFollowups(uid(req), (req.query as any)?.status ? String((req.query as any).status) : undefined));
}
