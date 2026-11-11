/** Upload, send, draft, schedule, reply identity. */
import type { FastifyInstance } from 'fastify';
import type { ComposePayload } from '@seamless/shared';
import { q } from '../db.ts';
import { randomToken } from '../crypto.ts';
import { sendEmail, saveDraft, saveUpload, scheduleEmail } from '../mail/send.ts';
import { matchReplyIdentity } from '../mail/replyfrom.ts';
import { getMsgRow } from '../mail/store.ts';
import { listIdentities } from '../jmap/api.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';

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
    try {
      const result = await sendEmail(uid(req), req.body as ComposePayload);
      broadcast({ type: 'stateChange' }, uid(req));
      return { ok: true, ...result };
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message ?? 'send failed' });
    }
  });

  app.post('/api/draft', async (req, reply) => {
    try {
      await saveDraft(uid(req), req.body as ComposePayload);
      broadcast({ type: 'stateChange' }, uid(req));
      return { ok: true };
    } catch (err: any) {
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
      return reply.code(400).send({ error: err?.message ?? 'could not schedule' });
    }
  });

  app.post('/api/identity/match', async (req, reply) => {
    const { emailId } = req.body as { emailId: string };
    const row = await getMsgRow(uid(req), emailId);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const accounts = (await q<any>('SELECT id, name, email, aliases FROM accounts WHERE user_id = ? AND enabled = true', [uid(req)])).map((a) => ({
      accountId: a.id, email: a.email, name: a.name, aliases: JSON.parse(a.aliases),
    }));
    if (accounts.length === 0) return reply.code(400).send({ error: 'no accounts' });
    return matchReplyIdentity({
      deliveredTo: row.delivered_to,
      to: JSON.parse(row.to_json),
      cc: JSON.parse(row.cc_json),
      owningAccountId: row.account_id,
      accounts,
    });
  });

  app.get('/api/identities', async (req) => listIdentities(uid(req)));
}
