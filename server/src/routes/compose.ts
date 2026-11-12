/** Upload, send, draft, schedule, reply identity. */
import type { FastifyInstance } from 'fastify';
import type { ComposePayload } from '@seamless/shared';
import { q } from '../db.ts';
import { randomToken } from '../crypto.ts';
import { queueSend, undoSend, pendingSends } from '../mail/undoSend.ts';
import { saveDraft, saveUpload, scheduleEmail } from '../mail/send.ts';
import { matchReplyIdentity } from '../mail/replyfrom.ts';
import { getMsgRow } from '../mail/store.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';
import { checkWrongBusiness } from '../business/guard.ts';
import { renderSignature, signatureBlock } from '../business/signature.ts';
import { getBusiness, cleanSigHtml } from '../business/businesses.ts';
import { one } from '../db.ts';
import { checkQuickReplySend } from '../templates/render.ts';
import { emitEvent } from '../events/emit.ts';
import { PgpError } from '../mail/pgp.ts';
import { SmimeError } from '../mail/smime.ts';

export function register(app: FastifyInstance): void {
  // ---- compose ----
  app.post('/api/upload', async (req, reply) => {
    const part = await (req as any).file();
    if (!part) return reply.code(400).send({ error: 'no file' });
    const data = await part.toBuffer();
    const meta = saveUpload(randomToken(16), part.filename ?? 'attachment', part.mimetype ?? 'application/octet-stream', data);
    return meta;
  });

  app.post('/api/send', async (req, reply) => {
    const qr = (req.body as ComposePayload)?.quickReplyId;
    if (qr != null) {
      const bad = await checkQuickReplySend(uid(req), Number(qr), req.body as ComposePayload);
      if (bad) return reply.code(400).send({ error: bad });
    }
    try {
      const result = await queueSend(uid(req), req.body as ComposePayload);
      broadcast({ type: 'stateChange' }, uid(req));
      if (result.queued) return { ok: true, queued: true, jobId: result.jobId, releaseAt: result.releaseAt };
      return { ok: true, queued: false, trackingToken: result.sent.trackingToken };
    } catch (err: any) {
      if (err?.statusCode === 403) return reply.code(403).send({ error: err.message });
      if (err instanceof PgpError || err instanceof SmimeError) return reply.code(err.status).send({ error: err.message });
      const p = req.body as ComposePayload;
      await emitEvent(uid(req), 'send.failed', null, { subject: p?.subject ?? '', accountId: p?.accountId ?? null, error: err?.message ?? 'send failed' }).catch(() => {});
      return reply.code(502).send({ error: err?.message ?? 'send failed' });
    }
  });

  app.post('/api/send/undo', async (req, reply) => {
    const { jobId } = (req.body ?? {}) as { jobId?: number };
    const payload = await undoSend(uid(req), Number(jobId));
    if (!payload) return reply.code(409).send({ error: 'already sent' });
    broadcast({ type: 'stateChange' }, uid(req));
    return { payload };
  });

  app.get('/api/send/pending', async (req) => pendingSends(uid(req)));

  app.post('/api/draft', async (req, reply) => {
    try {
      await saveDraft(uid(req), req.body as ComposePayload);
      broadcast({ type: 'stateChange' }, uid(req));
      return { ok: true };
    } catch (err: any) {
      if (err?.statusCode === 403) return reply.code(403).send({ error: err.message });
      return reply.code(502).send({ error: err?.message ?? 'draft save failed' });
    }
  });

  app.post('/api/schedule', async (req, reply) => {
    try {
      const { sendAt, ...payload } = req.body as ComposePayload & { sendAt: number };
      const result = await scheduleEmail(uid(req), payload, Number(sendAt));
      broadcast({ type: 'stateChange' }, uid(req));
      return { ok: true, ...result };
    } catch (err: any) {
      if (err?.statusCode === 403) return reply.code(403).send({ error: err.message });
      return reply.code(400).send({ error: err?.message ?? 'could not schedule' });
    }
  });

  /** Pre-send checks (wrong-business guard). */
  app.post('/api/compose/check', async (req) => {
    const b = (req.body ?? {}) as { identityId?: number; to?: { email: string }[]; cc?: { email: string }[]; bcc?: { email: string }[] };
    const rcpts = [...(b.to ?? []), ...(b.cc ?? []), ...(b.bcc ?? [])].map((a) => String(a?.email ?? ''));
    return { warnings: await checkWrongBusiness(uid(req), b.identityId, rcpts) };
  });

  /** The identity's rendered signature as a replaceable block (logo shown through our logo URL; the server turns it into a CID on send). */
  app.get('/api/identities/:id/signature', async (req, reply) => {
    const ident = await one<any>('SELECT * FROM identities WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    if (!ident) return reply.code(404).send({ error: 'not found' });
    const business = ident.business_id ? (await getBusiness(uid(req), ident.business_id)) ?? null : null;
    let html = cleanSigHtml(renderSignature({ email: ident.email, display_name: ident.display_name, signature_html: ident.signature_html }, business));
    if (business) html = html.replace(new RegExp(`cid:logo-${business.id}`, 'g'), `/api/businesses/${business.id}/logo`);
    return { html: signatureBlock(html) };
  });

  app.post('/api/identity/match', async (req, reply) => {
    const { emailId } = req.body as { emailId: string };
    const row = await getMsgRow(uid(req), emailId);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const disposables = await q<{ account_id: number; address: string }>(
      "SELECT account_id, address FROM disposable_addresses WHERE user_id = ? AND status = 'active'", [uid(req)]);
    const accounts = (await q<any>('SELECT id, name, email, aliases FROM accounts WHERE user_id = ? AND enabled = true', [uid(req)])).map((a) => ({
      accountId: a.id, email: a.email, name: a.name,
      aliases: [...JSON.parse(a.aliases), ...disposables.filter((d) => d.account_id === a.id).map((d) => d.address)] as string[],
    }));
    if (accounts.length === 0) return reply.code(400).send({ error: 'no accounts' });
    const match = matchReplyIdentity({
      deliveredTo: row.delivered_to,
      to: JSON.parse(row.to_json),
      cc: JSON.parse(row.cc_json),
      owningAccountId: row.account_id,
      accounts,
    });
    // attach the identity record (business, signature, reply-to …); disposable addresses have none
    const ident = await one<any>('SELECT * FROM identities WHERE user_id = ? AND account_id = ? AND lower(email) = lower(?)', [uid(req), match.accountId, match.email]);
    if (!ident) return match;
    return { ...match, name: ident.display_name, id: ident.id, businessId: ident.business_id, isDefault: ident.is_default,
      signatureHtml: ident.signature_html, replyTo: ident.reply_to, bccSelf: ident.bcc_self, transportId: ident.transport_id };
  });

}
