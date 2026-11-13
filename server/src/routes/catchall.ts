/** Catch-all mailbox for disposable addresses (T10.1) and the unknown-address list. All per-user. */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { encrypt } from '../crypto.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';
import { ensureLocalMailboxes } from '../mail/localbox.ts';
import { syncManager, type AccountRow } from '../imap/sync.ts';
import { createInbox, ingestPush, type PushInboxRow } from '../transport/inbound/push.ts';
import { checkNow, testResults, destInboxFor } from '../transport/inbound/catchall.ts';
import { createDisposable } from '../mail/disposable.ts';
import { listUnknown, getUnknown, heldRaw, blockUnknown, removeUnknown, POLICIES, normalizePolicy } from '../mail/unknown.ts';
import { sendEmail } from '../mail/send.ts';
import { audit } from '../audit/log.ts';
import '../transport/inbound/catchall.ts';   // registers the catch-all driver with the sync manager

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const AFTER = ['move', 'delete', 'leave'];

async function changed(userId: number) { await bumpState(); broadcast({ type: 'stateChange' }, userId); }

export function register(app: FastifyInstance): void {
  const mineAcct = (userId: number, id: number) => one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND user_id = ?', [id, userId]);

  app.get('/api/catchall', async (req) => {
    const userId = uid(req);
    const accts = await q<AccountRow>('SELECT * FROM accounts WHERE user_id = ? AND catchall = true ORDER BY id', [userId]);
    const mailboxes = [];
    for (const a of accts) {
      const dest = await destInboxFor(a.id);
      const st = syncManager.status(a.id);
      mailboxes.push({
        accountId: a.id, email: a.email, kind: a.inbound_kind ?? 'imap', after: a.catchall_after ?? 'move', cleanDays: a.catchall_clean_days ?? 14,
        destAccountId: dest?.account_id ?? null, token: dest?.token ?? null,
        domains: (dest?.domains ?? []).map((d) => ({ domain: d, policy: normalizePolicy(dest?.domain_policies?.[d] ?? dest?.unknown_policy) })),
        state: st.state, lastSyncAt: st.lastSyncAt, lastError: st.lastError, failures: st.failures,
      });
    }
    // every domain that can host disposable addresses (Cloudflare route and catch-all mailboxes) with its unknown-address policy
    const inboxes = await q<PushInboxRow & { email: string }>(
      `SELECT p.*, a.email FROM push_inboxes p JOIN accounts a ON a.id = p.account_id WHERE a.user_id = ? ORDER BY p.created_at`, [userId]);
    const domains = inboxes.flatMap((p) => p.domains.map((d) => ({
      domain: d, token: p.token, via: p.source_account_id != null ? 'catchall' : 'cloudflare',
      policy: normalizePolicy(p.domain_policies?.[d] ?? p.unknown_policy),
    })));
    const unknown = (await listUnknown(userId)).map((u) => ({
      id: u.id, address: u.address, domain: u.domain, status: u.status, receivedCount: u.received_count, droppedCount: u.dropped_count,
      held: u.held, lastFrom: u.last_from, lastSubject: u.last_subject, firstAt: Number(u.first_at), lastAt: Number(u.last_at),
    }));
    // mailboxes that could become a catch-all (IMAP / POP3, not already one)
    const candidates = (await q<AccountRow>("SELECT * FROM accounts WHERE user_id = ? AND catchall = false AND inbound_kind IN ('imap','pop3') AND archived = false ORDER BY id", [userId]))
      .filter((a) => (a.kind ?? 'imap') === 'imap')
      .map((a) => ({ accountId: a.id, email: a.email, kind: a.inbound_kind ?? 'imap' }));
    return { mailboxes, domains, unknown, candidates };
  });

  /** Turn an IMAP/POP3 mailbox into a catch-all for `domains`, or add domains to one that already is. */
  app.post('/api/catchall', async (req, reply) => {
    const userId = uid(req);
    const b = (req.body ?? {}) as { accountId?: number; domains?: string[]; after?: string; cleanDays?: number; policy?: string };
    const acct = await mineAcct(userId, Number(b.accountId));
    if (!acct) return reply.code(404).send({ error: 'mailbox not found' });
    if (!['imap', 'pop3'].includes(acct.inbound_kind ?? 'imap') || (acct.kind ?? 'imap') !== 'imap') return reply.code(400).send({ error: 'only an IMAP or POP3 mailbox can be a catch-all' });
    const domains = [...new Set((b.domains ?? []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
    if (domains.length === 0 || !domains.every((d) => DOMAIN_RE.test(d))) return reply.code(400).send({ error: 'at least one valid domain is required' });
    const clash = await one<{ d: string }>(
      `SELECT d FROM push_inboxes p, unnest(p.domains) AS d WHERE d = ANY(?::text[]) AND p.source_account_id IS DISTINCT FROM ? LIMIT 1`, [domains, acct.id]);
    if (clash) return reply.code(409).send({ error: `${clash.d} is already used by another inbox` });
    const pop3 = acct.inbound_kind === 'pop3';
    let after = AFTER.includes(String(b.after)) ? String(b.after) : (acct.catchall ? acct.catchall_after! : pop3 ? 'leave' : 'move');
    if (pop3 && after === 'move') after = 'leave';   // POP3 has no folders
    const clean = Math.min(365, Math.max(1, Number(b.cleanDays) || acct.catchall_clean_days || 14));
    const policy = POLICIES.includes(b.policy as any) ? String(b.policy) : 'quarantine';

    let dest = await destInboxFor(acct.id);
    if (!dest) {
      const email = `catch-all@${domains[0]}`;
      const destId = await insertId(`
        INSERT INTO accounts(user_id, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc,
          smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, color, signature, sent_copy, ai_categorize, enabled, created_at, inbound_kind)
        VALUES (?,?,?,?,'',0,false,'',?,'',0,false,'',?,?,'',true,false,true,?,'push')
      `, [userId, `Disposable (${acct.email})`, email, '[]', encrypt(''), encrypt(''), '#8a6fd1', Date.now()]);
      await ensureLocalMailboxes(destId);
      const { token } = await createInbox(destId, domains);
      await run('UPDATE push_inboxes SET source_account_id = ?, unknown_policy = ? WHERE token = ?', [acct.id, policy, token]);
      await run('UPDATE accounts SET catchall_dest_account_id = ? WHERE id = ?', [destId, acct.id]);
      dest = (await destInboxFor(acct.id))!;
    } else {
      const merged = [...new Set([...dest.domains, ...domains])];
      await run('UPDATE push_inboxes SET domains = ? WHERE token = ?', [merged, dest.token]);
      const dp = { ...(dest.domain_policies ?? {}) };
      for (const d of domains) if (!dest.domains.includes(d)) dp[d] = policy;
      await run('UPDATE push_inboxes SET domain_policies = ? WHERE token = ?', [JSON.stringify(dp), dest.token]);
    }
    await run('UPDATE accounts SET catchall = true, catchall_after = ?, catchall_clean_days = ? WHERE id = ?', [after, clean, acct.id]);
    await audit(req, 'catchall.enable', { type: 'account', id: acct.id }, { domains });
    await syncManager.restartAccount(acct.id);
    await changed(userId);
    return { ok: true, accountId: acct.id, destAccountId: dest.account_id };
  });

  app.put('/api/catchall/:accountId', async (req, reply) => {
    const userId = uid(req);
    const acct = await mineAcct(userId, Number((req.params as any).accountId));
    if (!acct?.catchall) return reply.code(404).send({ error: 'not a catch-all mailbox' });
    const b = (req.body ?? {}) as { after?: string; cleanDays?: number; removeDomain?: string };
    if (b.after !== undefined) {
      if (!AFTER.includes(b.after) || (acct.inbound_kind === 'pop3' && b.after === 'move')) return reply.code(400).send({ error: 'after must be move, delete or leave (POP3: leave or delete)' });
      await run('UPDATE accounts SET catchall_after = ? WHERE id = ?', [b.after, acct.id]);
    }
    if (b.cleanDays !== undefined) await run('UPDATE accounts SET catchall_clean_days = ? WHERE id = ?', [Math.min(365, Math.max(1, Number(b.cleanDays) || 14)), acct.id]);
    if (b.removeDomain) {
      const dest = await destInboxFor(acct.id);
      if (dest && dest.domains.includes(b.removeDomain)) {
        if (await one(`SELECT 1 FROM disposable_addresses WHERE account_id = ? AND address LIKE ?`, [dest.account_id, `%@${b.removeDomain}`])) return reply.code(409).send({ error: 'that domain still has disposable addresses' });
        await run('UPDATE push_inboxes SET domains = array_remove(domains, ?) WHERE token = ?', [b.removeDomain, dest.token]);
      }
    }
    await syncManager.restartAccount(acct.id);
    await changed(userId);
    return { ok: true };
  });

  app.delete('/api/catchall/:accountId', async (req, reply) => {
    const userId = uid(req);
    const acct = await mineAcct(userId, Number((req.params as any).accountId));
    if (!acct?.catchall) return reply.code(404).send({ error: 'not a catch-all mailbox' });
    await run('UPDATE push_inboxes SET source_account_id = NULL WHERE source_account_id = ?', [acct.id]);   // addresses and mail stay
    await run('UPDATE accounts SET catchall = false WHERE id = ?', [acct.id]);
    await audit(req, 'catchall.disable', { type: 'account', id: acct.id }, {});
    await syncManager.restartAccount(acct.id);
    await changed(userId);
    return { ok: true };
  });

  /** Fetch and route right now; reports what happened. */
  app.post('/api/catchall/:accountId/check', async (req, reply) => {
    const acct = await mineAcct(uid(req), Number((req.params as any).accountId));
    if (!acct?.catchall) return reply.code(404).send({ error: 'not a catch-all mailbox' });
    const r = await checkNow(acct.id);
    return { ok: !r.error, ...r };
  });

  /** Send a mail from one of your normal mailboxes to a random address on the domain; GET …/test/:token tells whether it was routed. */
  app.post('/api/catchall/:accountId/test-mail', async (req, reply) => {
    const userId = uid(req);
    const acct = await mineAcct(userId, Number((req.params as any).accountId));
    if (!acct?.catchall) return reply.code(404).send({ error: 'not a catch-all mailbox' });
    const dest = await destInboxFor(acct.id);
    const domain = String((req.body as any)?.domain ?? dest?.domains[0] ?? '').toLowerCase();
    if (!dest || !dest.domains.includes(domain)) return reply.code(400).send({ error: 'pick one of the catch-all domains' });
    const sender = await one<AccountRow>(
      `SELECT * FROM accounts WHERE user_id = ? AND catchall = false AND inbound_kind <> 'push' AND smtp_host <> '' AND enabled = true ORDER BY id LIMIT 1`, [userId]);
    if (!sender) return reply.code(400).send({ error: 'add a mailbox that can send mail first (the test mail is sent from it)' });
    const token = randomBytes(6).toString('hex').slice(0, 8);
    const address = `seamless-test-${token}@${domain}`;
    try {
      await sendEmail(userId, {
        accountId: sender.id, fromEmail: sender.email, to: [{ name: '', email: address }], cc: [], bcc: [],
        subject: 'Seamless catch-all test', html: '<p>This mail checks that the catch-all mailbox routes mail to Seamless. It is not stored.</p>',
        attachmentIds: [], track: false,
      });
    } catch (err: any) { return reply.code(502).send({ error: `could not send the test mail: ${err?.message ?? err}` }); }
    return { token, address };
  });

  app.get('/api/catchall/test/:token', async (req) => {
    const t = testResults.get(String((req.params as any).token));
    if (!t) return { state: 'waiting' };
    const owner = await one<{ user_id: number }>('SELECT user_id FROM accounts WHERE id = ?', [t.accountId]);
    if (owner?.user_id !== uid(req)) return { state: 'waiting' };
    return { state: 'routed', address: t.address, via: t.source };
  });

  // ---- unknown addresses ----
  /** Turn a quarantined address into a real disposable address and deliver the mail that was held. */
  app.post('/api/catchall/unknown/:id/create', async (req, reply) => {
    const userId = uid(req);
    const u = await getUnknown(userId, Number((req.params as any).id));
    if (!u) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as { label?: string };
    try {
      const d = await createDisposable(userId, { domain: u.domain, address: u.address, label: String(b.label ?? '') || u.last_from.replace(/<.*$/, '').trim() });
      const inbox = await one<PushInboxRow>('SELECT * FROM push_inboxes WHERE account_id = ?', [u.account_id]);
      let delivered = 0;
      if (inbox) for (const raw of await heldRaw(u.id)) if ((await ingestPush(inbox, raw, u.address)).status !== 500) delivered++;
      await removeUnknown(userId, u.id);
      return { id: d.id, address: d.address, delivered };
    } catch (err: any) { return reply.code(400).send({ error: err?.message ?? 'could not create' }); }
  });

  app.post('/api/catchall/unknown/:id/block', async (req, reply) => {
    const r = await blockUnknown(uid(req), Number((req.params as any).id));
    return r ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  app.delete('/api/catchall/unknown/:id', async (req, reply) =>
    (await removeUnknown(uid(req), Number((req.params as any).id))) ? { ok: true } : reply.code(404).send({ error: 'not found' }));
}
