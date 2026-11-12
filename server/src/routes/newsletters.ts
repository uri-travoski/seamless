import type { FastifyInstance } from 'fastify';
import { uid } from './util.ts';
import { listSenders, setSenderChoice, removeSender, unsubscribe, getSettings, putSettings, NewsletterError } from '../mail/newsletters.ts';

export function register(app: FastifyInstance): void {
  const guard = async (reply: any, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) { if (e instanceof NewsletterError) return reply.code(e.status).send({ error: e.message }); throw e; }
  };
  app.get('/api/newsletters/senders', async (req) => ({ items: await listSenders(uid(req)) }));
  app.put('/api/newsletters/senders', async (req, reply) => guard(reply, () => {
    const b = (req.body ?? {}) as any;
    return setSenderChoice(uid(req), String(b.sender ?? ''), b.choice, b.emailId ? String(b.emailId) : undefined);
  }));
  app.delete('/api/newsletters/senders/:id', async (req, reply) => guard(reply, async () => { await removeSender(uid(req), Number((req.params as any).id)); return { ok: true }; }));
  app.post('/api/newsletters/unsubscribe', async (req, reply) => guard(reply, () => unsubscribe(uid(req), String(((req.body ?? {}) as any).emailId ?? ''))));
  app.get('/api/newsletters/settings', async (req) => getSettings(uid(req)));
  app.put('/api/newsletters/settings', async (req, reply) => guard(reply, () => putSettings(uid(req), (req.body ?? {}) as any)));
}
