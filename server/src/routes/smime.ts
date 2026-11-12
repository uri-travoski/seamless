/** S/MIME certificates and compose check (T6.5 F-39). */
import type { FastifyInstance } from 'fastify';
import { uid } from './util.ts';
import { SmimeError, listCerts, importPkcs12, importCert, deleteCert, exportCert, composeCheck } from '../mail/smime.ts';

export function register(app: FastifyInstance): void {
  const guard = async (reply: any, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) { if (e instanceof SmimeError) return reply.code(e.status).send({ error: e.message }); throw e; }
  };
  const body = (req: any) => (req.body ?? {}) as any;

  app.get('/api/smime/certs', async (req) => ({ items: await listCerts(uid(req)) }));
  // the .p12 travels as base64 in JSON (small files; no multipart plumbing needed)
  app.post('/api/smime/certs/import-p12', { bodyLimit: 1024 * 1024 }, async (req, reply) => guard(reply, () => {
    const b = body(req);
    return importPkcs12(uid(req), { identityId: b.identityId ?? null, data: Buffer.from(String(b.data ?? ''), 'base64'), password: String(b.password ?? '') });
  }));
  app.post('/api/smime/certs/import', async (req, reply) => guard(reply, () => {
    const b = body(req);
    return importCert(uid(req), Buffer.from(String(b.pem ?? b.data ?? ''), b.pem ? 'utf8' : 'base64'));
  }));
  app.delete('/api/smime/certs/:id', async (req, reply) => guard(reply, async () => { await deleteCert(uid(req), Number((req.params as any).id)); return { ok: true }; }));
  app.get('/api/smime/certs/:id/pem', async (req, reply) => guard(reply, async () => {
    const c = await exportCert(uid(req), Number((req.params as any).id));
    reply.header('Content-Type', 'application/x-pem-file');
    reply.header('Content-Disposition', `attachment; filename="${c.filename.replace(/[^\w.@-]/g, '_')}"`);
    return reply.send(c.pem);
  }));
  app.post('/api/smime/check', async (req) => {
    const b = body(req);
    const list = (v: any) => (Array.isArray(v) ? v : []).map((a: any) => String(a?.email ?? a ?? ''));
    return composeCheck(uid(req), { fromEmail: String(b.fromEmail ?? ''), identityId: b.identityId ?? null, to: list(b.to), cc: list(b.cc), bcc: list(b.bcc) });
  });
}
