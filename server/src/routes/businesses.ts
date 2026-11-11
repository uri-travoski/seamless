/** Businesses + identities (T4 F-30). */
import type { FastifyInstance } from 'fastify';
import { bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';
import { listIdentities } from '../jmap/api.ts';
import * as biz from '../business/businesses.ts';
import { renderSignature } from '../business/signature.ts';
import { updateIdentity, type IdentityInput } from '../business/identities.ts';
import { one } from '../db.ts';

export function register(app: FastifyInstance): void {
  const changed = async (userId: number) => { await bumpState(); broadcast({ type: 'stateChange' }, userId); };

  app.get('/api/businesses', async (req) => (await biz.listBusinesses(uid(req))).map(biz.toApi));

  app.post('/api/businesses', async (req, reply) => {
    const b = (req.body ?? {}) as biz.BusinessInput;
    const err = biz.validate(b, true);
    if (err) return reply.code(400).send({ error: err });
    const id = await biz.createBusiness(uid(req), b);
    await changed(uid(req));
    return biz.toApi((await biz.getBusiness(uid(req), id))!);
  });

  app.put('/api/businesses/:id', async (req, reply) => {
    const b = (req.body ?? {}) as biz.BusinessInput;
    const err = biz.validate(b, false);
    if (err) return reply.code(400).send({ error: err });
    const id = Number((req.params as any).id);
    if (!(await biz.updateBusiness(uid(req), id, b))) return reply.code(404).send({ error: 'not found' });
    await changed(uid(req));
    return biz.toApi((await biz.getBusiness(uid(req), id))!);
  });

  app.delete('/api/businesses/:id', async (req, reply) => {
    if (!(await biz.deleteBusiness(uid(req), Number((req.params as any).id)))) return reply.code(404).send({ error: 'not found' });
    await changed(uid(req));
    return { ok: true };
  });

  app.post('/api/businesses/:id/logo', async (req, reply) => {
    const id = Number((req.params as any).id);
    const file = await (req as any).file();
    if (!file) return reply.code(400).send({ error: 'file required' });
    const data: Buffer = await file.toBuffer();
    if (file.file?.truncated) return reply.code(413).send({ error: 'logo must be 512 KB or smaller' });
    const res = await biz.setLogo(uid(req), id, data);
    if (!res.ok) return reply.code(res.code).send({ error: res.error });
    await changed(uid(req));
    return { ok: true };
  });

  app.get('/api/businesses/:id/logo', async (req, reply) => {
    const logo = await biz.getLogo(uid(req), Number((req.params as any).id));
    if (!logo) return reply.code(404).send({ error: 'not found' });
    return reply.header('content-type', logo.type).header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .header('cache-control', 'private, max-age=300').send(logo.data);
  });

  /** Rendered signature for the settings preview (identityId + optional draft business/signature overrides). */
  app.post('/api/businesses/:id/signature-preview', async (req, reply) => {
    const b = await biz.getBusiness(uid(req), Number((req.params as any).id));
    if (!b) return reply.code(404).send({ error: 'not found' });
    const body = (req.body ?? {}) as { identityId?: number; signatureHtml?: string | null; business?: biz.BusinessInput };
    const ident = body.identityId ? await one<any>('SELECT * FROM identities WHERE id = ? AND user_id = ?', [body.identityId, uid(req)]) : null;
    const merged = { ...b, default_signature_html: body.business?.defaultSignatureHtml ?? b.default_signature_html, disclaimer_html: body.business?.disclaimerHtml ?? b.disclaimer_html };
    return { html: biz.cleanSigHtml(renderSignature({ email: ident?.email ?? 'you@example.com', display_name: ident?.display_name ?? 'Your Name', signature_html: body.signatureHtml ?? ident?.signature_html ?? null }, merged)) };
  });

  app.get('/api/identities', async (req) => listIdentities(uid(req)));

  app.put('/api/identities/:id', async (req, reply) => {
    const err = await updateIdentity(uid(req), Number((req.params as any).id), (req.body ?? {}) as IdentityInput);
    if (err === 'not found') return reply.code(404).send({ error: err });
    if (err) return reply.code(400).send({ error: err });
    await changed(uid(req));
    return { ok: true };
  });
}
