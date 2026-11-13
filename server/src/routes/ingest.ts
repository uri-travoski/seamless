/** Public push-inbound endpoint (F-24). Authenticated by HMAC signature, not a session. */
import type { FastifyInstance } from 'fastify';
import { getInbox, inboxSecret, ingestPush, signatureValid, MAX_INGEST_BYTES } from '../transport/inbound/push.ts';
import { disposedAddressesFor } from '../mail/disposable.ts';
import { ingestFailLimiter, ingestLimiter } from '../security/ratelimit.ts';

export function register(app: FastifyInstance): void {
  app.addContentTypeParser('message/rfc822', { parseAs: 'buffer', bodyLimit: MAX_INGEST_BYTES }, (_req, body, done) => done(null, body));

  app.post('/api/ingest/:token', { bodyLimit: MAX_INGEST_BYTES }, async (req, reply) => {
    const token = String((req.params as any).token);
    const failKey = `${req.ip}:${token}`;
    if (ingestFailLimiter.blocked(failKey)) return reply.code(429).send({ error: 'too many failed attempts' });
    const inbox = await getInbox(token);
    if (!inbox) { ingestFailLimiter.hit(failKey); return reply.code(404).send({ error: 'unknown inbox' }); }
    const body = Buffer.isBuffer(req.body) ? req.body : null;
    const ts = String(req.headers['x-seamless-timestamp'] ?? '');
    const sig = String(req.headers['x-seamless-signature'] ?? '');
    if (!body || !signatureValid(inboxSecret(inbox), ts, sig, body)) {
      ingestFailLimiter.hit(failKey);
      return reply.code(401).send({ error: 'bad signature' });
    }
    if (!ingestLimiter.hit(`tok:${token}`)) return reply.code(429).send({ error: 'rate limited' });
    const rcptHeader = req.headers['x-seamless-rcpt'];
    const rcpt = (Array.isArray(rcptHeader) ? rcptHeader[0] : rcptHeader)?.trim() || null;
    const out = await ingestPush(inbox, body, rcpt);
    if ('dropped' in out) return reply.code(200).send({ dropped: true, reason: out.reason });
    if ('quarantined' in out) return reply.code(200).send({ quarantined: true });
    if (out.status === 202) return reply.code(202).send({ id: out.id });
    if (out.status === 200) return reply.code(200).send({ id: out.id, duplicate: true });
    return reply.code(500).send({ error: out.error });
  });

  /** Disposed addresses for the Worker to reject at SMTP time (signed like a POST, body = empty). */
  app.get('/api/ingest/:token/disposed', async (req, reply) => {
    const token = String((req.params as any).token);
    const failKey = `${req.ip}:${token}`;
    if (ingestFailLimiter.blocked(failKey)) return reply.code(429).send({ error: 'too many failed attempts' });
    const inbox = await getInbox(token);
    if (!inbox) { ingestFailLimiter.hit(failKey); return reply.code(404).send({ error: 'unknown inbox' }); }
    const ts = String(req.headers['x-seamless-timestamp'] ?? '');
    const sig = String(req.headers['x-seamless-signature'] ?? '');
    if (!signatureValid(inboxSecret(inbox), ts, sig, Buffer.alloc(0))) { ingestFailLimiter.hit(failKey); return reply.code(401).send({ error: 'bad signature' }); }
    return { addresses: await disposedAddressesFor(inbox.account_id) };
  });
}
