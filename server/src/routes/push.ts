/** Web push subscriptions. */
import type { FastifyInstance } from 'fastify';
import { vapidPublicKey, saveSubscription, removeSubscription } from '../push.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- web push ----
  app.get('/api/push/key', async () => ({ key: vapidPublicKey() }));
  app.post('/api/push/subscribe', async (req) => { await saveSubscription(uid(req), req.body as any); return { ok: true }; });
  app.post('/api/push/unsubscribe', async (req) => { await removeSubscription((req.body as any).endpoint); return { ok: true }; });
}
