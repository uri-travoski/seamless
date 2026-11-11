/** Mail accounts (to become "mailboxes" in T1) + manual sync kick + safe delete. */
import type { FastifyInstance } from 'fastify';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { encrypt } from '../crypto.ts';
import { syncManager, type AccountRow } from '../imap/sync.ts';
import { broadcast } from '../ws.ts';
import { sweepSafeDelete, safeDeletePreview } from '../classify/safedelete.ts';
import { uid, accountToApi } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- accounts ----
  app.get('/api/accounts', async (req) => {
    const rows = await q<AccountRow>('SELECT * FROM accounts WHERE user_id = ? ORDER BY id', [uid(req)]);
    return rows.map(accountToApi);
  });

  app.post('/api/accounts', async (req) => {
    const b = req.body as any;
    const id = await insertId(`
      INSERT INTO accounts(user_id, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc,
        smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, color, signature, sent_copy, ai_categorize, enabled, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      uid(req), b.name ?? '', b.email, JSON.stringify(b.aliases ?? []),
      b.imapHost, b.imapPort, !!b.imapSecure, b.imapUser, encrypt(b.imapPass),
      b.smtpHost, b.smtpPort, !!b.smtpSecure, b.smtpUser, encrypt(b.smtpPass),
      b.color ?? '#2f7ed8', b.signature ?? '', b.sentCopy !== false,
      !!b.aiCategorize, true, Date.now(),
    ]);
    await syncManager.restartAccount(id);
    await bumpState();
    return { id };
  });

  app.put('/api/accounts/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const existing = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND user_id = ?', [id, uid(req)]);
    if (!existing) return reply.code(404).send({ error: 'not found' });
    await run(`
      UPDATE accounts SET name=?, email=?, aliases=?, imap_host=?, imap_port=?, imap_secure=?, imap_user=?, imap_pass_enc=?,
        smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?, smtp_pass_enc=?, color=?, signature=?, sent_copy=?, ai_categorize=?, enabled=?
      WHERE id=?
    `, [
      b.name ?? '', b.email, JSON.stringify(b.aliases ?? []),
      b.imapHost, b.imapPort, !!b.imapSecure, b.imapUser, b.imapPass ? encrypt(b.imapPass) : existing.imap_pass_enc,
      b.smtpHost, b.smtpPort, !!b.smtpSecure, b.smtpUser, b.smtpPass ? encrypt(b.smtpPass) : existing.smtp_pass_enc,
      b.color ?? existing.color, b.signature ?? '', b.sentCopy !== false,
      !!b.aiCategorize, b.enabled !== false, id,
    ]);
    await syncManager.restartAccount(id);
    await bumpState();
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

  // ---- labels ----
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
