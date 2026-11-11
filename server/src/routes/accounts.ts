/** Mailboxes (connected accounts; "Accounts" in the API for compatibility) + tests + sync kick + safe delete. */
import type { FastifyInstance } from 'fastify';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { encrypt, decrypt } from '../crypto.ts';
import { accountAuth } from '../oauth.ts';
import { setAccountCategories, ensureBuiltinCategories } from '../mail/categories.ts';
import { testIncoming, testOutgoing, type ServerSpec } from '../mail/connTest.ts';
import { syncManager, type AccountRow } from '../imap/sync.ts';
import { broadcast } from '../ws.ts';
import { sweepSafeDelete, safeDeletePreview } from '../classify/safedelete.ts';
import { uid, accountToApi } from './util.ts';
import { ensureLocalMailboxes } from '../mail/localbox.ts';
import '../transport/inbound/pop3.ts'; // registers the POP3 poller with the sync manager
import { testPop3Incoming } from '../mail/connTest.ts';

export function register(app: FastifyInstance): void {
  // ---- accounts ----
  app.get('/api/accounts', async (req) => {
    const userId = uid(req);
    await ensureBuiltinCategories(userId);
    const rows = await q<AccountRow>('SELECT * FROM accounts WHERE user_id = ? ORDER BY id', [userId]);
    const members = await q<{ account_id: number; category_id: number }>(`
      SELECT m.account_id, m.category_id FROM mailbox_category_members m
      JOIN mailbox_categories c ON c.id = m.category_id WHERE c.user_id = ?`, [userId]);
    return rows.map((r) => {
      const st = syncManager.status(r.id);
      return {
        ...accountToApi(r),
        categoryIds: members.filter((m) => m.account_id === r.id).map((m) => m.category_id),
        status: r.enabled ? (st.state === 'paused' ? 'connecting' : st.state) : 'paused',
        lastSyncAt: st.lastSyncAt,
        lastError: st.lastError,
      };
    });
  });

  app.post('/api/accounts', async (req, reply) => {
    const b = req.body as any;
    if (!b.email || !/^[^@\s]+@[^@\s]+$/.test(b.email)) return reply.code(400).send({ error: 'valid email required' });
    const pop3 = b.inboundKind === 'pop3';
    if (pop3 && (!b.pop3Host || !b.pop3User)) return reply.code(400).send({ error: 'POP3 host and user required' });
    const id = await insertId(`
      INSERT INTO accounts(user_id, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc,
        smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, color, signature, sent_copy, ai_categorize, enabled, created_at,
        inbound_kind, pop3_host, pop3_port, pop3_secure, pop3_user, pop3_pass_enc, pop3_interval_min, pop3_leave_on_server, pop3_delete_after_days)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      uid(req), b.name ?? '', b.email, JSON.stringify(b.aliases ?? []),
      pop3 ? '' : b.imapHost, pop3 ? 0 : b.imapPort, !!b.imapSecure, pop3 ? '' : b.imapUser, encrypt(pop3 ? '' : b.imapPass),
      b.smtpHost ?? '', b.smtpPort ?? 0, !!b.smtpSecure, b.smtpUser ?? '', encrypt(b.smtpPass ?? ''),
      b.color ?? '#2f7ed8', b.signature ?? '', b.sentCopy !== false,
      !!b.aiCategorize, true, Date.now(),
      pop3 ? 'pop3' : 'imap', b.pop3Host ?? '', Number(b.pop3Port) || 995, b.pop3Secure !== false, b.pop3User ?? '', encrypt(b.pop3Pass ?? ''),
      Math.max(1, Number(b.pop3IntervalMin) || 5), b.pop3LeaveOnServer !== false,
      b.pop3DeleteAfterDays ? Math.max(1, Number(b.pop3DeleteAfterDays)) : null,
    ]);
    if (pop3) await ensureLocalMailboxes(id);
    if (Array.isArray(b.categoryIds)) await setAccountCategories(uid(req), id, b.categoryIds);
    await syncManager.restartAccount(id);
    await bumpState();
    broadcast({ type: 'stateChange' }, uid(req));
    return { id };
  });

  app.put('/api/accounts/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const existing = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND user_id = ?', [id, uid(req)]);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    if (existing.inbound_kind === 'pop3') {
      await run(`UPDATE accounts SET pop3_host=?, pop3_port=?, pop3_secure=?, pop3_user=?, pop3_pass_enc=?, pop3_interval_min=?, pop3_leave_on_server=?, pop3_delete_after_days=? WHERE id=?`, [
        b.pop3Host ?? existing.pop3_host, Number(b.pop3Port) || existing.pop3_port, b.pop3Secure === undefined ? !!existing.pop3_secure : !!b.pop3Secure,
        b.pop3User ?? existing.pop3_user, b.pop3Pass ? encrypt(b.pop3Pass) : existing.pop3_pass_enc,
        Math.max(1, Number(b.pop3IntervalMin) || existing.pop3_interval_min || 5), b.pop3LeaveOnServer === undefined ? !!existing.pop3_leave_on_server : !!b.pop3LeaveOnServer,
        b.pop3DeleteAfterDays ? Math.max(1, Number(b.pop3DeleteAfterDays)) : null, id]);
      b.imapHost = existing.imap_host; b.imapPort = existing.imap_port; b.imapUser = existing.imap_user; b.imapSecure = existing.imap_secure;
    }
    await run(`
      UPDATE accounts SET name=?, email=?, aliases=?, imap_host=?, imap_port=?, imap_secure=?, imap_user=?, imap_pass_enc=?,
        smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?, smtp_pass_enc=?, color=?, signature=?, sent_copy=?, ai_categorize=?, enabled=?, health_ignored=?
      WHERE id=?
    `, [
      b.name ?? '', b.email, JSON.stringify(b.aliases ?? []),
      b.imapHost, b.imapPort, !!b.imapSecure, b.imapUser, b.imapPass ? encrypt(b.imapPass) : existing.imap_pass_enc,
      b.smtpHost, b.smtpPort, !!b.smtpSecure, b.smtpUser, b.smtpPass ? encrypt(b.smtpPass) : existing.smtp_pass_enc,
      b.color ?? existing.color, b.signature ?? '', b.sentCopy !== false,
      !!b.aiCategorize, b.enabled !== false, b.healthIgnored === undefined ? !!existing.health_ignored : !!b.healthIgnored, id,
    ]);
    if (Array.isArray(b.categoryIds)) await setAccountCategories(uid(req), id, b.categoryIds);
    await syncManager.restartAccount(id);
    await bumpState();
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const existing = await one('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [id, uid(req)]);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    syncManager.stopAccount(id);
    await run('DELETE FROM accounts WHERE id = ?', [id]);
    await bumpState();
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  app.post('/api/accounts/test', async (req, reply) => {
    const b = req.body as any;
    const errors: string[] = [];
    const imap = new ImapFlow({
      host: b.imapHost, port: b.imapPort, secure: !!b.imapSecure,
      auth: { user: b.imapUser, pass: b.imapPass }, logger: false,
    });
    try { await imap.connect(); await imap.logout(); } catch (err: any) { errors.push(`IMAP: ${err?.message}`); }
    const smtp = nodemailer.createTransport({
      host: b.smtpHost, port: b.smtpPort, secure: !!b.smtpSecure,
      auth: { user: b.smtpUser, pass: b.smtpPass },
      tls: { rejectUnauthorized: false },
    });
    try { await smtp.verify(); } catch (err: any) { errors.push(`SMTP: ${err?.message}`); }
    if (errors.length) return reply.code(400).send({ ok: false, errors });
    return { ok: true };
  });

  /** Settings → Mailboxes wizard: incoming and outgoing tested separately, step by step.
   *  Editing an existing mailbox may leave the password blank: the stored one is used. */
  const specFrom = async (req: any, dir: 'imap' | 'smtp'): Promise<ServerSpec | null> => {
    const b = req.body as any;
    let pass: string | undefined = dir === 'imap' ? b.imapPass : b.smtpPass;
    let accessToken: string | undefined;
    if (b.accountId) {
      const acct = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND user_id = ?', [Number(b.accountId), uid(req)]);
      if (!acct) return null;
      if (acct.kind === 'gmail' || acct.kind === 'microsoft') {
        accessToken = (await accountAuth(acct)).accessToken;
      } else if (!pass) {
        pass = decrypt(dir === 'imap' ? acct.imap_pass_enc : acct.smtp_pass_enc);
      }
    }
    return dir === 'imap'
      ? { host: b.imapHost, port: Number(b.imapPort), secure: !!b.imapSecure, user: b.imapUser, pass, accessToken }
      : { host: b.smtpHost, port: Number(b.smtpPort), secure: !!b.smtpSecure, user: b.smtpUser, pass, accessToken };
  };

  app.post('/api/accounts/test/incoming', async (req, reply) => {
    const spec = await specFrom(req, 'imap');
    if (!spec) return reply.code(404).send({ error: 'not found' });
    return testIncoming(spec);
  });

  /** POP3 incoming test: DNS → TCP → TLS → sign-in → message count. Blank password = the stored one. */
  app.post('/api/accounts/test/pop3', async (req, reply) => {
    const b = req.body as any;
    let pass: string | undefined = b.pop3Pass;
    if (b.accountId) {
      const acct = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND user_id = ?', [Number(b.accountId), uid(req)]);
      if (!acct) return reply.code(404).send({ error: 'not found' });
      if (!pass) pass = decrypt(acct.pop3_pass_enc ?? '');
    }
    return testPop3Incoming({ host: b.pop3Host, port: Number(b.pop3Port), secure: !!b.pop3Secure, user: b.pop3User, pass });
  });

  app.post('/api/accounts/:id/pop3/poll', async (req, reply) => {
    const id = Number((req.params as any).id);
    const acct = await one('SELECT id FROM accounts WHERE id = ? AND user_id = ? AND inbound_kind = ?', [id, uid(req), 'pop3']);
    if (!acct) return reply.code(404).send({ error: 'not found' });
    const { pollPop3 } = await import('../transport/inbound/pop3.ts');
    return pollPop3(id);
  });

  app.post('/api/accounts/test/outgoing', async (req, reply) => {
    const spec = await specFrom(req, 'smtp');
    if (!spec) return reply.code(404).send({ error: 'not found' });
    const b = req.body as any;
    return testOutgoing(spec, b.sendTest ? { sendTo: b.email, from: b.email } : {});
  });

  app.post('/api/sync', async (req) => {
    const n = syncManager.kickUser(uid(req));
    return { ok: true, accounts: n };
  });

  // ---- safe delete ----
  app.put('/api/accounts/:id/safe-delete', async (req, reply) => {
    const id = Number((req.params as any).id);
    const existing = await one('SELECT id FROM accounts WHERE id = ? AND user_id = ?', [id, uid(req)]);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    const b = req.body as { enabled: boolean; mode?: string; graceDays?: number };
    await run('UPDATE accounts SET safe_delete_enabled = ?, safe_delete_mode = ?, safe_delete_grace_days = ? WHERE id = ?',
      [!!b.enabled, b.mode === 'expunge' ? 'expunge' : 'trash', Math.max(1, Number(b.graceDays) || 30), id]);
    return { ok: true };
  });

  app.get('/api/accounts/:id/safe-delete/preview', async (req) =>
    safeDeletePreview(uid(req), Number((req.params as any).id)));

  app.post('/api/safe-delete/run', async () => sweepSafeDelete());
}
