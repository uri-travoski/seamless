/** Settings → Integrations → Webhooks (T5 F-36), the admin allow-list, and the public signed-blob download. */
import type { FastifyInstance } from 'fastify';
import { uid, isAdmin } from './util.ts';
import {
  WebhookError, WEBHOOK_EVENT_TYPES, INCLUDE_LEVELS, initWebhooks, listWebhooks, createWebhook, updateWebhook, deleteWebhook, rotateSecret,
  sendTestEvent, redeliver, listDeliveries, listAllowlist, addAllow, removeAllow, readBlob,
} from '../integrations/webhooks.ts';

export function register(app: FastifyInstance): void {
  initWebhooks();
  const guard = async (reply: any, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) { if (e instanceof WebhookError) return reply.code(e.status).send({ error: e.message }); throw e; }
  };
  const idOf = (req: any) => Number(req.params.id);

  app.get('/api/webhooks', async (req) => ({ items: await listWebhooks(uid(req)), eventTypes: WEBHOOK_EVENT_TYPES, includeLevels: INCLUDE_LEVELS }));
  app.post('/api/webhooks', async (req, reply) => guard(reply, () => createWebhook(uid(req), (req.body ?? {}) as any)));
  app.put('/api/webhooks/:id', async (req, reply) => guard(reply, () => updateWebhook(uid(req), idOf(req), (req.body ?? {}) as any)));
  app.delete('/api/webhooks/:id', async (req, reply) => guard(reply, async () => { await deleteWebhook(uid(req), idOf(req)); return { ok: true }; }));
  app.post('/api/webhooks/:id/rotate', async (req, reply) => guard(reply, async () => ({ secret: await rotateSecret(uid(req), idOf(req)) })));
  app.post('/api/webhooks/:id/test', async (req, reply) => guard(reply, () => sendTestEvent(uid(req), idOf(req))));
  app.get('/api/webhooks/:id/deliveries', async (req, reply) => guard(reply, async () => {
    if (!(await listWebhooks(uid(req))).some((w) => w.id === idOf(req))) throw new WebhookError(404, 'not found');
    return { items: await listDeliveries(uid(req), idOf(req), Number((req.query as any).limit) || 50) };
  }));
  app.post('/api/webhook-deliveries/:id/redeliver', async (req, reply) => guard(reply, async () => { await redeliver(uid(req), idOf(req)); return { ok: true }; }));

  // admin-managed: local apps on the same host (DMS, BizBooks) need an entry here
  const admin = async (req: any, reply: any, fn: () => Promise<unknown>) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    return guard(reply, fn);
  };
  app.get('/api/webhook-allowlist', async (req, reply) => admin(req, reply, async () => ({ items: await listAllowlist() })));
  app.post('/api/webhook-allowlist', async (req, reply) => admin(req, reply, async () => { await addAllow(uid(req), String(((req.body ?? {}) as any).value ?? '')); return { items: await listAllowlist() }; }));
  app.delete('/api/webhook-allowlist/:id', async (req, reply) => admin(req, reply, async () => { await removeAllow(idOf(req)); return { ok: true }; }));

  // public: the signed token is the credential (1 h)
  app.get('/api/hooks/blob/:token', async (req, reply) => {
    const b = await readBlob((req.params as any).token);
    if (!b) return reply.code(404).send({ error: 'not found or expired' });
    reply.header('Content-Type', b.contentType);
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(b.filename)}"`);
    reply.header('Cache-Control', 'private, no-store');
    return reply.send(b.content);
  });
}
