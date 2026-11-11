/** Managing push inboxes ("Own domain (Cloudflare Email Routing)" mailboxes). Secrets are shown once. */
import { syncAccountIdentities } from '../business/identities.ts';
import type { FastifyInstance } from 'fastify';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { encrypt } from '../crypto.ts';
import { config } from '../config.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';
import { ensureLocalMailboxes } from '../mail/localbox.ts';
import { syncManager, type AccountRow } from '../imap/sync.ts';
import { createInbox, rotateSecret, sign, inboxSecret, type PushInboxRow } from '../transport/inbound/push.ts';

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

function view(r: PushInboxRow & { email: string; name: string }) {
  return {
    token: r.token, accountId: r.account_id, email: r.email, name: r.name, domains: r.domains,
    catchAll: r.catch_all, unknownPolicy: r.unknown_policy, createdAt: Number(r.created_at),
    endpoint: `${config.publicUrl}/api/ingest/${r.token}`,
  };
}

export function register(app: FastifyInstance): void {
  const mine = (userId: number, token: string) => one<PushInboxRow & { email: string; name: string; user_id: number }>(
    `SELECT p.*, a.email, a.name, a.user_id FROM push_inboxes p JOIN accounts a ON a.id = p.account_id
     WHERE p.token = ? AND a.user_id = ?`, [token, userId]);

  app.get('/api/push-inboxes', async (req) =>
    (await q<PushInboxRow & { email: string; name: string }>(
      `SELECT p.*, a.email, a.name FROM push_inboxes p JOIN accounts a ON a.id = p.account_id
       WHERE a.user_id = ? ORDER BY p.created_at`, [uid(req)])).map(view));

  app.post('/api/push-inboxes', async (req, reply) => {
    const userId = uid(req);
    const b = (req.body ?? {}) as { name?: string; email?: string; domains?: string[]; transportId?: number | null };
    const domains = [...new Set((b.domains ?? []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
    if (domains.length === 0 || !domains.every((d) => DOMAIN_RE.test(d))) return reply.code(400).send({ error: 'at least one valid domain is required' });
    const email = String(b.email ?? '').trim().toLowerCase() || `me@${domains[0]}`;
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'valid email required' });
    let transportId: number | null = null;
    if (b.transportId != null) {
      if (!(await one('SELECT id FROM transports WHERE id = ? AND user_id = ?', [Number(b.transportId), userId]))) return reply.code(400).send({ error: 'unknown transport' });
      transportId = Number(b.transportId);
    }
    const id = await insertId(`
      INSERT INTO accounts(user_id, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc,
        smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, color, signature, sent_copy, ai_categorize, enabled, created_at,
        inbound_kind, outbound_transport_id)
      VALUES (?,?,?,?,'',0,false,'',?,'',0,false,'',?,?,'',true,false,true,?,'push',?)
    `, [userId, String(b.name ?? '').trim() || email, email, '[]', encrypt(''), encrypt(''), '#2f7ed8', Date.now(), transportId]);
    await syncAccountIdentities(id);
    await ensureLocalMailboxes(id);
    const { token, secret } = await createInbox(id, domains);
    const acct = await one<AccountRow>('SELECT * FROM accounts WHERE id = ?', [id]);
    if (acct) syncManager.startAccount(acct);
    await bumpState(); broadcast({ type: 'stateChange' }, userId);
    const row = (await mine(userId, token))!;
    return { ...view(row), secret };
  });

  app.put('/api/push-inboxes/:token', async (req, reply) => {
    const row = await mine(uid(req), String((req.params as any).token));
    if (!row) return reply.code(404).send({ error: 'not found' });
    const policy = (req.body as any)?.unknownPolicy;
    if (policy !== 'deliver' && policy !== 'reject') return reply.code(400).send({ error: 'unknownPolicy must be deliver or reject' });
    await run('UPDATE push_inboxes SET unknown_policy = ? WHERE token = ?', [policy, row.token]);
    return view((await mine(uid(req), row.token))!);
  });

  app.post('/api/push-inboxes/:token/rotate', async (req, reply) => {
    const userId = uid(req);
    const row = await mine(userId, String((req.params as any).token));
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { secret: await rotateSecret(row.token) };
  });

  /** Posts a signed test message to this inbox's own endpoint (in-process): proves route + signature + storage. */
  app.post('/api/push-inboxes/:token/test', async (req, reply) => {
    const userId = uid(req);
    const row = await mine(userId, String((req.params as any).token));
    if (!row) return reply.code(404).send({ error: 'not found' });
    const rcpt = `test@${row.domains[0] ?? 'example.com'}`;
    const raw = Buffer.from([
      'From: Seamless test <seamless-test@localhost>', `To: ${rcpt}`, 'Subject: Seamless push inbound test',
      `Message-ID: <push-test-${Date.now()}@seamless.local>`, `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
      'This message proves the ingest endpoint and signature work. It did not travel through Cloudflare.', ''].join('\r\n'));
    const ts = String(Date.now());
    const res = await app.inject({
      method: 'POST', url: `/api/ingest/${row.token}`, payload: raw,
      headers: {
        'content-type': 'message/rfc822', 'x-seamless-timestamp': ts, 'x-seamless-rcpt': rcpt,
        'x-seamless-signature': sign(inboxSecret(row), ts, raw),
      },
    });
    return { ok: res.statusCode === 202 || res.statusCode === 200, status: res.statusCode, body: safeJson(res.body) };
  });
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }
