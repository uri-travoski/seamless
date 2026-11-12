/** OpenPGP keys, contact-key lookup, compose check (T6.4 F-39). */
import type { FastifyInstance } from 'fastify';
import { uid } from './util.ts';
import { getParsed } from '../mail/body.ts';
import { getMsgRow } from '../mail/store.ts';
import { PgpError, listKeys, generateKey, importKey, deleteKey, exportPublic, lookupKey, composeCheck, getSettings, putSettings, importKeyFromParts } from '../mail/pgp.ts';

export function register(app: FastifyInstance): void {
  const guard = async (reply: any, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) { if (e instanceof PgpError) return reply.code(e.status).send({ error: e.message }); throw e; }
  };
  const body = (req: any) => (req.body ?? {}) as any;

  app.get('/api/pgp/keys', async (req) => ({ items: await listKeys(uid(req)) }));
  app.post('/api/pgp/keys/generate', async (req, reply) => guard(reply, () => {
    const b = body(req);
    return generateKey(uid(req), { identityId: b.identityId ?? null, email: b.email, name: b.name, passphrase: b.passphrase });
  }));
  app.post('/api/pgp/keys/import', async (req, reply) => guard(reply, () => {
    const b = body(req);
    return importKey(uid(req), String(b.armored ?? ''), { identityId: b.identityId ?? null });
  }));
  app.delete('/api/pgp/keys/:id', async (req, reply) => guard(reply, async () => { await deleteKey(uid(req), Number((req.params as any).id)); return { ok: true }; }));
  app.get('/api/pgp/keys/:id/public', async (req, reply) => guard(reply, async () => {
    const k = await exportPublic(uid(req), Number((req.params as any).id));
    reply.header('Content-Type', 'application/pgp-keys');
    reply.header('Content-Disposition', `attachment; filename="${k.filename.replace(/[^\w.@-]/g, '_')}"`);
    return reply.send(k.armored);
  }));
  app.post('/api/pgp/lookup', async (req, reply) => guard(reply, () => lookupKey(uid(req), String(body(req).email ?? ''))));
  app.post('/api/pgp/check', async (req) => {
    const b = body(req);
    const list = (v: any) => (Array.isArray(v) ? v : []).map((a: any) => String(a?.email ?? a ?? ''));
    return composeCheck(uid(req), { fromEmail: String(b.fromEmail ?? ''), identityId: b.identityId ?? null, to: list(b.to), cc: list(b.cc), bcc: list(b.bcc) });
  });
  app.post('/api/pgp/import-from-message', async (req, reply) => guard(reply, async () => {
    const b = body(req);
    const row = await getMsgRow(uid(req), String(b.emailId ?? ''));
    if (!row) throw new PgpError(404, 'Message not found');
    const parsed = await getParsed(row.id, uid(req));
    if (!parsed) throw new PgpError(404, 'Message not found');
    return importKeyFromParts(uid(req), parsed, Number(b.partId));
  }));
  app.get('/api/pgp/settings', async (req) => getSettings(uid(req)));
  app.put('/api/pgp/settings', async (req) => putSettings(uid(req), body(req)));
}
