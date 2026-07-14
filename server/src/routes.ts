import type { FastifyInstance, FastifyRequest } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { ComposePayload } from '@seamless/shared';
import { q, one, run, insertId, bumpState } from './db.ts';
import { encrypt, hashPassword, verifyPassword, randomToken } from './crypto.ts';
import { getBlob } from './s3.ts';
import { syncManager, type AccountRow } from './imap/sync.ts';
import { getEmailBody, getParsed, getTracking } from './mail/body.ts';
import { buildOriginalPage } from './mail/original.ts';
import { sendEmail, saveDraft, saveUpload, scheduleEmail } from './mail/send.ts';
import { matchReplyIdentity } from './mail/replyfrom.ts';
import { getMsgRow, setNote, moveEmail, setLabels } from './mail/store.ts';
import { loadFilters, filterMatches, type FilterableMessage } from './mail/filters.ts';
import { applyLocalFilterActions } from './mail/ingest.ts';
import { summarizeThread, draftReply, parseTeachNote } from './ai/tasks.ts';
import { chatComplete, getProvider, getTaskProvider } from './ai/client.ts';
import { embedText, embeddingInput } from './classify/ai.ts';
import { handleJmapRequest, jmapSession, listIdentities } from './jmap/api.ts';
import { vapidPublicKey, saveSubscription, removeSubscription } from './push.ts';
import { broadcast } from './ws.ts';
import { importWorkbook } from './import/xlsx.ts';
import { reclassifyUser, recomputeDisposition, kickClassifier } from './classify/engine.ts';
import { sweepRetention } from './classify/retention.ts';
import { allUserSettings, setUserSetting, plog, SETTING_DEFAULTS } from './classify/settings.ts';
import { saveOauthApp, startAuthUrl, handleCallback, redirectUri } from './oauth.ts';
import { sweepSafeDelete, safeDeletePreview } from './classify/safedelete.ts';
import { runGmailLearn, acceptProposals } from './import/gmailLearn.ts';
import { createAppPassword } from './facade/auth.ts';
import { listContacts, contactToVcf, importVcf, harvestContacts } from './contacts.ts';
import { config } from './config.ts';
import { listBackups, verifyBackup, restoreBackup, databaseIsEmpty } from './backup/engine.ts';
import {
  getBackupConfig, setBackupConfig, getBackupStatus, runBackup, acknowledgeFailure, listBackupsForUi, normalizePrefix,
} from './backup/schedule.ts';
import { makeStore } from './s3.ts';

const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// /api/setup/{backups,restore} are public on purpose: after a total loss the database
// is empty, so there is no account to authenticate with. Both refuse once a user exists.
const PUBLIC_PATHS = [/^\/t\//, /^\/api\/(login|setup|me)$/, /^\/api\/setup\/(backups|restore)$/, /^\/(?!api|jmap)/];

const pkgVersion = (() => {
  try {
    return (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

export interface SessionUser { userId: number; role: 'admin' | 'member' }

export async function sessionUser(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await one<{ user_id: number; role: 'admin' | 'member' }>(
    'SELECT s.user_id, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', [token]);
  return row ? { userId: row.user_id, role: row.role } : null;
}

function uid(req: FastifyRequest): number {
  return (req as any).sessionUser.userId as number;
}

function isAdmin(req: FastifyRequest): boolean {
  return (req as any).sessionUser?.role === 'admin';
}

function accountToApi(r: AccountRow) {
  return {
    id: r.id, kind: r.kind ?? 'imap', name: r.name, email: r.email, aliases: JSON.parse(r.aliases),
    imapHost: r.imap_host, imapPort: r.imap_port, imapSecure: !!r.imap_secure, imapUser: r.imap_user,
    smtpHost: r.smtp_host, smtpPort: r.smtp_port, smtpSecure: !!r.smtp_secure, smtpUser: r.smtp_user,
    color: r.color, signature: r.signature, sentCopy: !!r.sent_copy,
    aiCategorize: !!r.ai_categorize, enabled: !!r.enabled,
    safeDeleteEnabled: !!r.safe_delete_enabled, safeDeleteMode: r.safe_delete_mode ?? 'trash',
    safeDeleteGraceDays: r.safe_delete_grace_days ?? 30,
  };
}

async function makeSession(reply: any, userId: number): Promise<void> {
  const token = randomToken(24);
  await run('INSERT INTO sessions(token, user_id, created_at) VALUES (?,?,?)', [token, userId, Date.now()]);
  reply.setCookie('smsession', token, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 90 });
}

export function registerRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    const su = await sessionUser(req.cookies.smsession);
    (req as any).sessionUser = su;
    if (PUBLIC_PATHS.some((re) => re.test(req.url))) return;
    if (!su) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // ---- auth ----
  app.get('/api/me', async (req) => {
    const anyUser = await one('SELECT 1 FROM users LIMIT 1');
    const su = (req as any).sessionUser as SessionUser | null;
    if (!su) return { needsSetup: !anyUser, loggedIn: false, settings: {} };
    const user = await one<{ id: number; email: string; name: string; role: string; settings_json: string }>(
      'SELECT id, email, name, role, settings_json FROM users WHERE id = ?', [su.userId]);
    return {
      needsSetup: false,
      loggedIn: true,
      user: user ? { id: user.id, email: user.email, name: user.name, role: user.role } : null,
      settings: JSON.parse(user?.settings_json ?? '{}'),
    };
  });

  app.post('/api/setup', async (req, reply) => {
    if (await one('SELECT 1 FROM users LIMIT 1')) return reply.code(400).send({ error: 'already set up' });
    const { email, name, password } = req.body as { email: string; name?: string; password: string };
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'valid email required' });
    if (!password || password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    const userId = await insertId(
      'INSERT INTO users(email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)',
      [email.toLowerCase(), name ?? '', hashPassword(password), 'admin', Date.now()]);
    await makeSession(reply, userId);
    return { ok: true };
  });

  app.post('/api/login', async (req, reply) => {
    const ip = req.ip;
    const attempt = loginAttempts.get(ip) ?? { count: 0, resetAt: Date.now() + 15 * 60_000 };
    if (Date.now() > attempt.resetAt) { attempt.count = 0; attempt.resetAt = Date.now() + 15 * 60_000; }
    if (attempt.count >= 10) return reply.code(429).send({ error: 'too many attempts, try later' });

    const { email, password } = req.body as { email: string; password: string };
    const user = await one<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = ?', [(email ?? '').toLowerCase()]);
    if (!user || !verifyPassword(password ?? '', user.password_hash)) {
      attempt.count++;
      loginAttempts.set(ip, attempt);
      return reply.code(401).send({ error: 'wrong email or password' });
    }
    loginAttempts.delete(ip);
    await makeSession(reply, user.id);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    if (req.cookies.smsession) await run('DELETE FROM sessions WHERE token = ?', [req.cookies.smsession]);
    reply.clearCookie('smsession', { path: '/' });
    return { ok: true };
  });

  // ---- users (admin manages; anyone can change own password) ----
  app.get('/api/users', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    return q('SELECT id, email, name, role, created_at FROM users ORDER BY id');
  });

  app.post('/api/users', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const b = req.body as { email: string; name?: string; password: string; role?: string };
    if (!b.email || !/^[^@\s]+@[^@\s]+$/.test(b.email)) return reply.code(400).send({ error: 'valid email required' });
    if (!b.password || b.password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    if (await one('SELECT 1 FROM users WHERE email = ?', [b.email.toLowerCase()])) {
      return reply.code(400).send({ error: 'email already exists' });
    }
    const id = await insertId('INSERT INTO users(email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)',
      [b.email.toLowerCase(), b.name ?? '', hashPassword(b.password), b.role === 'admin' ? 'admin' : 'member', Date.now()]);
    return { id };
  });

  app.delete('/api/users/:id', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const id = Number((req.params as any).id);
    if (id === uid(req)) return reply.code(400).send({ error: 'cannot delete yourself' });
    const accounts = await q<{ id: number }>('SELECT id FROM accounts WHERE user_id = ?', [id]);
    for (const a of accounts) syncManager.stopAccount(a.id);
    await run('DELETE FROM users WHERE id = ?', [id]);
    return { ok: true };
  });

  app.put('/api/users/password', async (req, reply) => {
    const { current, password } = req.body as { current: string; password: string };
    if (!password || password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    const user = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [uid(req)]);
    if (!user || !verifyPassword(current ?? '', user.password_hash)) return reply.code(401).send({ error: 'wrong current password' });
    await run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), uid(req)]);
    return { ok: true };
  });

  // ---- client settings (per user) ----
  app.put('/api/settings', async (req) => {
    await run('UPDATE users SET settings_json = ? WHERE id = ?', [JSON.stringify(req.body ?? {}), uid(req)]);
    return { ok: true };
  });

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

  app.get('/api/labels', async (req) =>
    (await q('SELECT id, name, color, description, sort, keep_default, retention_days, protected, auto_mark_read FROM labels WHERE user_id = ? ORDER BY sort, name', [uid(req)]))
      .map((l: any) => ({
        id: l.id, name: l.name, color: l.color, description: l.description, sort: l.sort,
        keepDefault: l.keep_default, retentionDays: l.retention_days, protected: l.protected, autoMarkRead: l.auto_mark_read,
      })));

  app.post('/api/labels', async (req) => {
    const b = req.body as any;
    const id = await insertId('INSERT INTO labels(user_id, name, color, description, sort, keep_default, retention_days, protected, auto_mark_read) VALUES (?,?,?,?,?,?,?,?,?)',
      [uid(req), b.name, b.color ?? '#e05656', b.description ?? '', b.sort ?? 0,
       !!b.keepDefault, b.retentionDays ?? null, !!b.protected, !!b.autoMarkRead]);
    await bumpState(); broadcast({ type: 'stateChange' }, uid(req));
    return { id };
  });

  app.put('/api/labels/:id', async (req) => {
    const b = req.body as any;
    const id = Number((req.params as any).id);
    await run('UPDATE labels SET name=?, color=?, description=?, sort=?, keep_default=?, retention_days=?, protected=?, auto_mark_read=? WHERE id=? AND user_id=?',
      [b.name, b.color, b.description ?? '', b.sort ?? 0,
       !!b.keepDefault, b.retentionDays ?? null, !!b.protected, !!b.autoMarkRead, id, uid(req)]);
    // retention semantics may have changed: recompute dispositions of everything carrying this label
    const affected = await q<{ message_id: number }>('SELECT message_id FROM message_labels WHERE label_id = ?', [id]);
    for (const a of affected) await recomputeDisposition(a.message_id);
    await bumpState(); broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  app.delete('/api/labels/:id', async (req) => {
    await run('DELETE FROM labels WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    await bumpState(); broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  // ---- filters ----
  app.get('/api/filters', async (req) => loadFilters(uid(req)));

  app.post('/api/filters', async (req) => {
    const b = req.body as any;
    const id = await insertId('INSERT INTO filters(user_id, name, enabled, sort, match, conditions, actions, stop) VALUES (?,?,?,?,?,?,?,?)',
      [uid(req), b.name, b.enabled !== false, b.sort ?? 0, b.match ?? 'all', JSON.stringify(b.conditions ?? []), JSON.stringify(b.actions ?? []), !!b.stop]);
    return { id };
  });

  app.put('/api/filters/:id', async (req) => {
    const b = req.body as any;
    await run('UPDATE filters SET name=?, enabled=?, sort=?, match=?, conditions=?, actions=?, stop=? WHERE id=? AND user_id=?',
      [b.name, b.enabled !== false, b.sort ?? 0, b.match ?? 'all', JSON.stringify(b.conditions ?? []), JSON.stringify(b.actions ?? []), !!b.stop, Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.delete('/api/filters/:id', async (req) => {
    await run('DELETE FROM filters WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  /** Apply one filter to all existing inbox mail. */
  app.post('/api/filters/:id/run', async (req) => {
    const userId = uid(req);
    const filter = (await loadFilters(userId)).find((f) => f.id === Number((req.params as any).id));
    if (!filter) return { applied: 0 };
    const rows = await q<any>(`
      SELECT m.id, m.subject, m.from_name, m.from_addr, m.to_json, m.cc_json, m.has_attachments, a.email AS account_email
      FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id JOIN accounts a ON a.id = m.account_id
      WHERE mb.role = 'inbox' AND m.user_id = ?
    `, [userId]);
    let applied = 0;
    for (const r of rows) {
      const body = (await one<{ body: string }>('SELECT body FROM message_fts WHERE message_id = ?', [r.id]))?.body ?? '';
      const fmsg: FilterableMessage = {
        from: `${r.from_name} <${r.from_addr}>`,
        to: (JSON.parse(r.to_json) as any[]).map((a) => `${a.name} <${a.email}>`).join(', '),
        cc: (JSON.parse(r.cc_json) as any[]).map((a) => `${a.name} <${a.email}>`).join(', '),
        subject: r.subject, body,
        hasAttachment: !!r.has_attachments,
        accountEmail: r.account_email,
      };
      if (filterMatches(fmsg, filter)) {
        applied++;
        await applyLocalFilterActions(r.id, filter.actions);
        const move = filter.actions.find((a) => a.type === 'move' || a.type === 'delete');
        if (move) await moveEmail(userId, `m${r.id}`, move.type === 'delete' ? 'u:trash' : (move.value?.startsWith('mb:') || move.value?.startsWith('u:') ? move.value : `u:${move.value}`));
      }
    }
    await bumpState(); broadcast({ type: 'stateChange' }, userId);
    return { applied };
  });

  // ---- message body / blobs ----
  app.get('/api/message/:id/body', async (req, reply) => {
    const allowRemote = (req.query as any).remote === '1';
    const body = await getEmailBody(uid(req), (req.params as any).id, allowRemote);
    if (!body) return reply.code(404).send({ error: 'not found' });
    return body;
  });

  app.get('/api/message/:id/tracking', async (req, reply) => {
    const t = await getTracking(uid(req), (req.params as any).id);
    if (!t) return reply.code(404).send({ error: 'not tracked' });
    return t;
  });

  app.get('/api/blob/:id/:partId', async (req, reply) => {
    const { id, partId } = req.params as any;
    const parsed = await getParsed(Number(String(id).replace(/^m/, '')) || 0, uid(req));
    const att = parsed?.attachments[Number(partId)];
    if (!att) return reply.code(404).send({ error: 'not found' });
    const download = (req.query as any).download === '1';
    reply.header('Content-Type', att.contentType || 'application/octet-stream');
    reply.header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(att.filename ?? 'attachment')}"`);
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(att.content);
  });

  app.put('/api/message/:id/note', async (req) => {
    await setNote(uid(req), (req.params as any).id, String((req.body as any)?.body ?? ''));
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  app.get('/api/message/:id/original', async (req, reply) => {
    const html = await buildOriginalPage(uid(req), (req.params as any).id);
    if (!html) return reply.code(404).send({ error: 'not found' });
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(html);
  });

  app.get('/api/raw/:id', async (req, reply) => {
    const row = await getMsgRow(uid(req), (req.params as any).id);
    if (!row || !row.s3_key) return reply.code(404).send({ error: 'not found' });
    const raw = await getBlob(row.s3_key);
    reply.header('Content-Type', 'message/rfc822');
    reply.header('Content-Disposition', `attachment; filename="${row.id}.eml"`);
    return reply.send(raw);
  });

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

  // ---- AI ----
  app.get('/api/ai/providers', async (req) =>
    (await q<any>('SELECT id, name, base_url, model, api_key_enc FROM ai_providers WHERE user_id = ? ORDER BY id', [uid(req)]))
      .map((r) => ({ id: r.id, name: r.name, baseUrl: r.base_url, model: r.model, hasKey: !!r.api_key_enc })));

  app.post('/api/ai/providers', async (req) => {
    const b = req.body as any;
    const id = await insertId('INSERT INTO ai_providers(user_id, name, base_url, api_key_enc, model) VALUES (?,?,?,?,?)',
      [uid(req), b.name, b.baseUrl.replace(/\/$/, ''), b.apiKey ? encrypt(b.apiKey) : '', b.model ?? '']);
    return { id };
  });

  app.put('/api/ai/providers/:id', async (req) => {
    const b = req.body as any;
    const id = Number((req.params as any).id);
    const existing = await one<any>('SELECT api_key_enc FROM ai_providers WHERE id = ? AND user_id = ?', [id, uid(req)]);
    await run('UPDATE ai_providers SET name=?, base_url=?, api_key_enc=?, model=? WHERE id=? AND user_id=?',
      [b.name, b.baseUrl.replace(/\/$/, ''), b.apiKey ? encrypt(b.apiKey) : existing?.api_key_enc ?? '', b.model ?? '', id, uid(req)]);
    return { ok: true };
  });

  app.delete('/api/ai/providers/:id', async (req) => {
    await run('DELETE FROM ai_providers WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.get('/api/ai/tasks', async (req) => q('SELECT task, provider_id, model, enabled FROM ai_tasks WHERE user_id = ?', [uid(req)]));

  app.put('/api/ai/tasks', async (req) => {
    const tasks = req.body as { task: string; providerId: number | null; model: string; enabled: boolean }[];
    for (const t of tasks) {
      await run(`
        INSERT INTO ai_tasks(user_id, task, provider_id, model, enabled) VALUES (?,?,?,?,?)
        ON CONFLICT(user_id, task) DO UPDATE SET provider_id=excluded.provider_id, model=excluded.model, enabled=excluded.enabled
      `, [uid(req), t.task, t.providerId, t.model ?? '', !!t.enabled]);
    }
    return { ok: true };
  });

  app.post('/api/ai/test/:id', async (req, reply) => {
    const provider = await getProvider(uid(req), Number((req.params as any).id));
    if (!provider) return reply.code(404).send({ error: 'not found' });
    try {
      const out = await chatComplete(provider, [{ role: 'user', content: 'Reply with the single word: ok' }], { maxTokens: 10 });
      return { ok: true, reply: out.trim().slice(0, 100) };
    } catch (err: any) {
      return reply.code(502).send({ ok: false, error: err?.message });
    }
  });

  app.post('/api/ai/summarize', async (req, reply) => {
    try { return { summary: await summarizeThread(uid(req), (req.body as any).threadId) }; }
    catch (err: any) { return reply.code(400).send({ error: err?.message }); }
  });

  app.post('/api/ai/draft', async (req, reply) => {
    try { return { draft: await draftReply(uid(req), (req.body as any).emailId, (req.body as any).instruction ?? '') }; }
    catch (err: any) { return reply.code(400).send({ error: err?.message }); }
  });

  // ---- classification rules ----
  app.get('/api/rules', async (req) =>
    (await q('SELECT * FROM rules WHERE user_id = ? ORDER BY ord, id', [uid(req)])).map((r: any) => ({
      id: r.id, enabled: r.enabled, ord: r.ord, matchField: r.match_field, matchValue: r.match_value,
      excludeContains: r.exclude_contains, action: r.action, labelId: r.label_id, stop: r.stop,
      note: r.note, source: r.source, hitCount: r.hit_count,
    })));

  app.post('/api/rules', async (req) => {
    const b = req.body as any;
    const id = await insertId(`
      INSERT INTO rules(user_id, enabled, ord, match_field, match_value, exclude_contains, action, label_id, stop, note, source, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [uid(req), b.enabled !== false, b.ord ?? 0, b.matchField, b.matchValue, b.excludeContains ?? '',
        b.action === 'ai' ? 'ai' : 'label', b.action === 'ai' ? null : b.labelId, b.stop !== false, b.note ?? '', 'manual', Date.now()]);
    return { id };
  });

  app.put('/api/rules/:id', async (req) => {
    const b = req.body as any;
    await run(`
      UPDATE rules SET enabled=?, ord=?, match_field=?, match_value=?, exclude_contains=?, action=?, label_id=?, stop=?, note=?
      WHERE id=? AND user_id=?
    `, [b.enabled !== false, b.ord ?? 0, b.matchField, b.matchValue, b.excludeContains ?? '',
        b.action === 'ai' ? 'ai' : 'label', b.action === 'ai' ? null : b.labelId, b.stop !== false, b.note ?? '',
        Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.delete('/api/rules/:id', async (req) => {
    await run('DELETE FROM rules WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  // ---- preferences (plain-English AI guidance, versioned) ----
  app.get('/api/preferences', async (req) =>
    (await q('SELECT id, enabled, guidance, version FROM preferences WHERE user_id = ? AND active = true ORDER BY id', [uid(req)]))
      .map((p: any) => ({ id: p.id, enabled: p.enabled, guidance: p.guidance, version: p.version })));

  app.post('/api/preferences', async (req) => {
    const b = req.body as any;
    const id = await insertId('INSERT INTO preferences(user_id, enabled, guidance, version, active, created_at) VALUES (?,?,?,1,true,?)',
      [uid(req), b.enabled !== false, b.guidance ?? '', Date.now()]);
    return { id };
  });

  app.put('/api/preferences/:id', async (req) => {
    const b = req.body as any;
    // editing bumps the version (audit trail for phase-3 ai_decisions)
    await run('UPDATE preferences SET enabled=?, guidance=?, version = version + 1 WHERE id=? AND user_id=?',
      [b.enabled !== false, b.guidance ?? '', Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.delete('/api/preferences/:id', async (req) => {
    await run('UPDATE preferences SET active = false WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  // ---- spreadsheet import ----
  app.post('/api/import/xlsx', async (req, reply) => {
    const part = await (req as any).file();
    if (!part) return reply.code(400).send({ error: 'no file' });
    const buf = await part.toBuffer();
    const commit = (req.query as any).commit === '1';
    try {
      const preview = await importWorkbook(uid(req), buf, commit);
      if (commit) {
        await reclassifyUser(uid(req));
        broadcast({ type: 'stateChange' }, uid(req));
      }
      return preview;
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'import failed' });
    }
  });

  // ---- classification / retention ops ----
  app.post('/api/classify/run', async (req) => {
    const n = await reclassifyUser(uid(req));
    return { queued: n };
  });

  app.post('/api/retention/sweep', async () => {
    const stats = await sweepRetention();
    kickClassifier();
    return stats;
  });

  app.get('/api/retention/settings', async (req) => {
    const all = await allUserSettings(uid(req));
    return { dryRun: all.dry_run !== 'false', trashDays: Number(all.trash_days) || 30, logRetentionDays: Number(all.log_retention_days) || 90 };
  });

  app.put('/api/retention/settings', async (req) => {
    const b = req.body as any;
    if (b.dryRun !== undefined) await setUserSetting(uid(req), 'dry_run', b.dryRun ? 'true' : 'false');
    if (b.trashDays !== undefined) await setUserSetting(uid(req), 'trash_days', String(Number(b.trashDays) || 30));
    if (b.logRetentionDays !== undefined) await setUserSetting(uid(req), 'log_retention_days', String(Number(b.logRetentionDays) || 90));
    return { ok: true };
  });

  // ---- OAuth (Google / Microsoft) ----
  app.get('/api/oauth/apps', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const rows = await q<any>('SELECT provider, client_id FROM oauth_apps');
    return rows.map((r) => ({ provider: r.provider, clientId: r.client_id }));
  });

  app.put('/api/oauth/apps/:provider', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const provider = String((req.params as any).provider);
    if (provider !== 'google' && provider !== 'microsoft') return reply.code(400).send({ error: 'unknown provider' });
    const b = req.body as { clientId: string; clientSecret: string };
    if (!b.clientId || !b.clientSecret) return reply.code(400).send({ error: 'clientId and clientSecret required' });
    await saveOauthApp(provider, b.clientId.trim(), b.clientSecret.trim());
    return { ok: true, redirectUri: redirectUri(provider) };
  });

  app.get('/api/oauth/:provider/start', async (req, reply) => {
    const provider = String((req.params as any).provider) as 'google' | 'microsoft';
    if (provider !== 'google' && provider !== 'microsoft') return reply.code(400).send({ error: 'unknown provider' });
    const url = await startAuthUrl(uid(req), provider);
    if (!url) return reply.code(400).send({ error: `${provider} OAuth app not configured (Settings > Accounts)` });
    return { url };
  });

  app.get('/api/oauth/:provider/callback', async (req, reply) => {
    const provider = String((req.params as any).provider) as 'google' | 'microsoft';
    const { code, state, error } = req.query as any;
    const back = (msg: string) => reply.type('text/html').send(
      `<script>window.opener?.postMessage(${JSON.stringify({ seamlessOauth: msg })}, '*'); window.close();</script>` +
      `<p>${msg} — you can close this window.</p>`);
    if (error) return back(`Connection cancelled: ${error}`);
    try {
      const result = await handleCallback(provider, String(code), String(state));
      await syncManager.restartAccount(result.accountId);
      await bumpState();
      broadcast({ type: 'stateChange' }, uid(req));
      return back(`Connected ${result.email}`);
    } catch (err: any) {
      return back(`Connection failed: ${err?.message ?? err}`);
    }
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

  // ---- learn from Gmail ----
  app.post('/api/gmail-learn/:accountId', async (req, reply) => {
    try {
      const importId = await runGmailLearn(uid(req), Number((req.params as any).accountId));
      return { importId };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'could not start' });
    }
  });

  app.get('/api/gmail-learn/:importId/status', async (req, reply) => {
    const imp = await one<any>('SELECT * FROM gmail_imports WHERE id = ? AND user_id = ?', [Number((req.params as any).importId), uid(req)]);
    if (!imp) return reply.code(404).send({ error: 'not found' });
    return { status: imp.status, stats: JSON.parse(imp.stats), proposals: JSON.parse(imp.proposals) };
  });

  app.post('/api/gmail-learn/:importId/accept', async (req, reply) => {
    try {
      const created = await acceptProposals(uid(req), Number((req.params as any).importId), (req.body as any)?.indexes ?? []);
      await reclassifyUser(uid(req));
      return { created };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'accept failed' });
    }
  });

  // ---- review lane ----
  app.get('/api/review/count', async (req) => {
    const row = await one<{ c: number }>("SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND classify_state = 'needs_review'", [uid(req)]);
    return { count: row?.c ?? 0 };
  });

  /** One-tap review decision: set labels (or none) and mark the message decided. */
  app.post('/api/review/:id/resolve', async (req) => {
    const emailId = String((req.params as any).id);
    const b = (req.body ?? {}) as { labelIds?: number[] };
    const row = await getMsgRow(uid(req), emailId);
    if (!row) return { ok: false };
    if (Array.isArray(b.labelIds)) await setLabels(uid(req), emailId, b.labelIds);
    await run("UPDATE messages SET classify_state = 'classified', review_reason = NULL WHERE id = ?", [row.id]);
    await bumpState();
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  // ---- ai decisions ("why this label?") ----
  app.get('/api/message/:id/decisions', async (req) => {
    const row = await getMsgRow(uid(req), (req.params as any).id);
    if (!row) return [];
    const rows = await q<any>('SELECT tier, model, output, confidence, reason, created_at FROM ai_decisions WHERE email_id = ? ORDER BY id DESC LIMIT 5', [row.id]);
    return rows.map((r) => ({
      tier: r.tier, model: r.model, output: JSON.parse(r.output), confidence: r.confidence,
      reason: r.reason, createdAt: new Date(r.created_at).toISOString(),
    }));
  });

  // ---- processor notes ("teach the AI about this sender") ----
  app.get('/api/processor-notes', async (req) =>
    (await q<any>('SELECT * FROM processor_notes WHERE user_id = ? AND active = true ORDER BY id DESC', [uid(req)])).map((n) => ({
      id: n.id, scope: n.scope, scopeValue: n.scope_value, note: n.note, labelId: n.label_id,
      autoRead: n.auto_read, retentionDays: n.retention_days, deleteIfUnread: n.delete_if_unread, active: n.active,
    })));

  // parse a plain-English instruction into directives + candidate labels (no save yet)
  app.post('/api/processor-notes/parse', async (req) => {
    const b = req.body as any;
    const d = await parseTeachNote(uid(req), String(b.emailId ?? ''), String(b.note ?? ''));
    let existingMatches: { id: number; name: string }[] = [];
    if (d.label) {
      const want = d.label.toLowerCase();
      const words = new Set(want.split(/\W+/).filter(Boolean));
      const labels = await q<{ id: number; name: string }>('SELECT id, name FROM labels WHERE user_id = ? ORDER BY sort, id', [uid(req)]);
      existingMatches = labels
        .map((l) => {
          const ln = l.name.toLowerCase();
          let score = ln === want ? 1 : (ln.includes(want) || want.includes(ln)) ? 0.7 : 0;
          if (!score) {
            const lw = ln.split(/\W+/).filter(Boolean);
            const overlap = lw.filter((w) => words.has(w)).length;
            score = overlap / Math.max(1, words.size + lw.length - overlap);
          }
          return { id: l.id, name: l.name, score };
        })
        .filter((x) => x.score > 0.2)
        .sort((a, b2) => b2.score - a.score).slice(0, 3)
        .map(({ id, name }) => ({ id, name }));
    }
    return { ...d, existingMatches };
  });

  app.post('/api/processor-notes', async (req) => {
    const b = req.body as any;
    // "Teach the AI" content-similarity note (from the reading pane)
    if (b.emailId) {
      const userId = uid(req);
      let labelId: number | null = null;
      if (b.label?.kind === 'existing' && b.label.id) labelId = Number(b.label.id);
      else if (b.label?.kind === 'new' && b.label.name) {
        labelId = await insertId(
          `INSERT INTO labels(user_id, name, color, description, sort, retention_days, auto_mark_read)
           VALUES (?,?,?, '', 0, ?, ?)
           ON CONFLICT (user_id, name) DO UPDATE SET retention_days = excluded.retention_days, auto_mark_read = excluded.auto_mark_read`,
          [userId, String(b.label.name).trim(), b.color ?? '#2f8ed8', b.retentionDays ?? null, !!b.autoRead]);
      }
      const vecLit = (v: number[]) => '[' + v.map((x) => Number.isFinite(x) ? x.toFixed(6) : '0').join(',') + ']';
      let embedLit: string | null = null; let dim: number | null = null;
      const provider = await getTaskProvider(userId, 'embed');
      const row = await getMsgRow(userId, String(b.emailId));
      if (provider && row) {
        try { const vec = await embedText(provider, embeddingInput(row)); embedLit = vecLit(vec); dim = vec.length; } catch { /* store without anchor */ }
      }
      const id = await insertId(`
        INSERT INTO processor_notes(user_id, scope, scope_value, note, summary, label_id, auto_read, retention_days, delete_if_unread, embedding, embed_dim, active, created_at, updated_at)
        VALUES (?, 'similar', ?, ?, ?, ?, ?, ?, ?, ?::vector, ?, true, ?, ?)
        ON CONFLICT (user_id, scope, scope_value) DO UPDATE SET
          note=excluded.note, summary=excluded.summary, label_id=excluded.label_id, auto_read=excluded.auto_read,
          retention_days=excluded.retention_days, delete_if_unread=excluded.delete_if_unread,
          embedding=excluded.embedding, embed_dim=excluded.embed_dim, active=true, updated_at=excluded.updated_at
      `, [userId, String(b.emailId), b.note ?? '', b.summary ?? '', labelId, !!b.autoRead, b.retentionDays ?? null, !!b.deleteIfUnread, embedLit, dim, Date.now(), Date.now()]);
      await bumpState();
      return { id, labelId };
    }
    // legacy per-sender/domain note
    const scope = b.scope === 'domain' ? 'domain' : 'sender';
    const id = await insertId(`
      INSERT INTO processor_notes(user_id, scope, scope_value, note, label_id, auto_read, retention_days, delete_if_unread, active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,true,?,?)
      ON CONFLICT (user_id, scope, scope_value) DO UPDATE SET
        note = excluded.note, label_id = excluded.label_id, auto_read = excluded.auto_read,
        retention_days = excluded.retention_days, delete_if_unread = excluded.delete_if_unread,
        active = true, updated_at = excluded.updated_at
    `, [uid(req), scope, String(b.scopeValue ?? '').trim().toLowerCase(), b.note ?? '',
        b.labelId ?? null, !!b.autoRead, b.retentionDays ?? null, !!b.deleteIfUnread, Date.now(), Date.now()]);
    return { id };
  });

  app.delete('/api/processor-notes/:id', async (req) => {
    await run('UPDATE processor_notes SET active = false WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  // ---- rule suggestions (promoted from corrections) ----
  app.get('/api/suggestions', async (req) =>
    (await q<any>("SELECT * FROM rule_suggestions WHERE user_id = ? AND status = 'pending' ORDER BY evidence DESC", [uid(req)])).map((s) => ({
      id: s.id, matchField: s.match_field, matchValue: s.match_value, labelId: s.label_id, evidence: s.evidence,
    })));

  app.post('/api/suggestions/:id/accept', async (req) => {
    const s = await one<any>('SELECT * FROM rule_suggestions WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    if (!s) return { ok: false };
    const maxOrd = (await one<{ m: number }>('SELECT COALESCE(MAX(ord),0) AS m FROM rules WHERE user_id = ?', [uid(req)]))?.m ?? 0;
    await insertId(`
      INSERT INTO rules(user_id, enabled, ord, match_field, match_value, exclude_contains, action, label_id, stop, note, source, created_at)
      VALUES (?,true,?,?,?,'','label',?,true,'promoted from your corrections','promoted',?)
    `, [uid(req), maxOrd + 10, s.match_field, s.match_value, s.label_id, Date.now()]);
    await run("UPDATE rule_suggestions SET status = 'accepted' WHERE id = ?", [s.id]);
    return { ok: true };
  });

  app.post('/api/suggestions/:id/dismiss', async (req) => {
    await run("UPDATE rule_suggestions SET status = 'dismissed' WHERE id = ? AND user_id = ?", [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  // ---- devices (app passwords for the IMAP/SMTP/CardDAV facades) ----
  app.get('/api/devices', async (req) =>
    (await q<any>('SELECT id, label, scopes, created_at, last_used_at FROM app_passwords WHERE user_id = ? ORDER BY id DESC', [uid(req)])).map((d) => ({
      id: d.id, label: d.label, scopes: d.scopes.split(','),
      createdAt: new Date(d.created_at).toISOString(),
      lastUsedAt: d.last_used_at ? new Date(d.last_used_at).toISOString() : null,
    })));

  app.post('/api/devices', async (req) => {
    const b = req.body as { label: string; scopes?: string[] };
    const scopes = (b.scopes?.length ? b.scopes : ['imap', 'smtp', 'carddav']).filter((s) => ['imap', 'smtp', 'carddav'].includes(s));
    return createAppPassword(uid(req), b.label || 'Device', scopes);
  });

  app.delete('/api/devices/:id', async (req) => {
    await run('DELETE FROM app_passwords WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.get('/api/devices/server-info', async () => {
    const host = new URL(config.publicUrl).hostname;
    return {
      imap: { host, port: config.facade.imapPort, tls: !!(config.facade.tlsKeyFile && config.facade.tlsCertFile) },
      smtp: { host, port: config.facade.smtpPort, tls: false },
      carddav: `${config.publicUrl}/dav/`,
    };
  });

  // ---- contacts ----
  app.get('/api/contacts', async (req) => {
    const includeHidden = (req.query as any).hidden === '1';
    return (await listContacts(uid(req), includeHidden)).map((c) => ({
      id: c.id, displayName: c.display_name, org: c.org, notes: c.notes, emails: c.emails,
      sentCount: c.sent_count, receivedCount: c.received_count,
      lastInteractionAt: c.last_interaction_at ? new Date(c.last_interaction_at).toISOString() : null,
      autoCreated: c.auto_created, hidden: c.hidden,
    }));
  });

  app.put('/api/contacts/:id', async (req) => {
    const b = req.body as any;
    await run('UPDATE contacts SET display_name = ?, org = ?, notes = ?, hidden = ?, auto_created = false, updated_at = ? WHERE id = ? AND user_id = ?',
      [b.displayName ?? '', b.org ?? '', b.notes ?? '', !!b.hidden, Date.now(), Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.delete('/api/contacts/:id', async (req) => {
    await run('DELETE FROM contacts WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.get('/api/contacts/suggest', async (req) => {
    const term = String((req.query as any).q ?? '').toLowerCase();
    if (!term) return [];
    const rows = await q<any>(`
      SELECT c.display_name, ce.email FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
      WHERE c.user_id = ? AND c.hidden = false AND (lower(c.display_name) LIKE ? OR ce.email LIKE ?)
      ORDER BY GREATEST(c.sent_count, c.received_count) DESC LIMIT 8
    `, [uid(req), `%${term}%`, `%${term}%`]);
    return rows.map((r) => ({ name: r.display_name, email: r.email }));
  });

  app.get('/api/contacts/export.vcf', async (req, reply) => {
    const cards = (await listContacts(uid(req))).map(contactToVcf).join('');
    reply.header('Content-Type', 'text/vcard; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="seamless-contacts.vcf"');
    return reply.send(cards);
  });

  app.post('/api/contacts/import', async (req, reply) => {
    const part = await (req as any).file();
    if (!part) return reply.code(400).send({ error: 'no file' });
    const created = await importVcf(uid(req), (await part.toBuffer()).toString('utf8'));
    return { created };
  });

  app.post('/api/contacts/harvest', async () => ({ scanned: await harvestContacts() }));

  // ---- processing logs ----
  app.get('/api/logs', async (req) => {
    const kind = (req.query as any).kind as string | undefined;
    const limit = Math.min(Number((req.query as any).limit) || 200, 1000);
    // user_id IS NULL covers instance-level entries (backup) that belong to no one user
    const rows = kind
      ? await q('SELECT id, email_id, kind, level, message, created_at FROM processing_logs WHERE (user_id = ? OR user_id IS NULL) AND kind = ? ORDER BY id DESC LIMIT ?', [uid(req), kind, limit])
      : await q('SELECT id, email_id, kind, level, message, created_at FROM processing_logs WHERE (user_id = ? OR user_id IS NULL) ORDER BY id DESC LIMIT ?', [uid(req), limit]);
    return rows.map((r: any) => ({ id: r.id, emailId: r.email_id, kind: r.kind, level: r.level, message: r.message, createdAt: new Date(r.created_at).toISOString() }));
  });

  app.delete('/api/logs', async (req) => {
    await run('DELETE FROM processing_logs WHERE user_id = ?', [uid(req)]);
    return { ok: true };
  });

  // ---- backup (admin) ----
  app.get('/api/backup', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    // Unreachable storage must not 500 this page: a failing bucket is exactly when the
    // admin needs to reach it to read the failure banner and fix the configuration.
    let backups: Awaited<ReturnType<typeof listBackupsForUi>> = [];
    let storageError = '';
    try {
      backups = await listBackupsForUi();
    } catch (err: any) {
      storageError = err?.message ?? 'cannot read backup storage';
    }
    return { config: await getBackupConfig(), status: await getBackupStatus(), backups, storageError };
  });

  app.put('/api/backup', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    return { config: await setBackupConfig(req.body as any), status: await getBackupStatus() };
  });

  app.post('/api/backup/run', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const res = await runBackup({ appVersion: pkgVersion });
    if (!res.ok) return reply.code(500).send({ error: res.error });
    return { ...res, status: await getBackupStatus(), backups: await listBackupsForUi() };
  });

  app.post('/api/backup/verify', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const key = String((req.body as any)?.key ?? '');
    try {
      const { manifest, rows } = await verifyBackup(key);
      return { ok: true, rows, tables: Object.keys(manifest.tables).length, bytes: manifest.bytes };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'verify failed' });
    }
  });

  app.post('/api/backup/ack', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    await acknowledgeFailure();
    return { ok: true };
  });

  // Restore is deliberately NOT exposed to a logged-in admin: it truncates every
  // table, and the disaster case (empty database, nobody to log in as) is the only
  // one that needs it. Both routes below are public but refuse once a user exists.
  // The backup store's own credentials can never come out of the backup — you need them to
  // read it. So the setup screen may supply them, for a box rebuilt with no S3_BACKUP_* set.
  // (The MAIL bucket needs no such thing: its config travels inside the backup.)
  const backupStoreFrom = (body: any) => {
    const s = body?.store;
    if (!s?.bucket) return undefined;   // fall back to the environment
    return makeStore({
      endpoint: String(s.endpoint ?? config.s3Backup.endpoint),
      region: String(s.region ?? config.s3Backup.region),
      bucket: String(s.bucket),
      accessKey: String(s.accessKey ?? config.s3Backup.accessKey),
      secretKey: String(s.secretKey ?? config.s3Backup.secretKey),
      forcePathStyle: s.forcePathStyle ?? config.s3Backup.forcePathStyle,
    });
  };

  const listSetupBackups = async (body: any) => {
    const store = backupStoreFrom(body);
    const prefix = normalizePrefix(String(body?.prefix ?? (await getBackupConfig()).prefix));
    const backups = await listBackups({ prefix, store });
    return { backups, prefix, bucket: store ? (body.store.bucket as string) : config.s3Backup.bucket };
  };

  app.get('/api/setup/backups', async (req, reply) => {
    if (!(await databaseIsEmpty())) return reply.code(403).send({ error: 'already set up' });
    try {
      return await listSetupBackups(undefined);
    } catch (err: any) {
      // no usable storage config in the environment: the UI then asks the user for it
      return reply.code(400).send({ error: `cannot read backup storage: ${err?.message ?? err}`, needsStorage: true });
    }
  });

  /** Same as the GET, but the caller names the bucket + credentials to look in. */
  app.post('/api/setup/backups', async (req, reply) => {
    if (!(await databaseIsEmpty())) return reply.code(403).send({ error: 'already set up' });
    try {
      return await listSetupBackups(req.body);
    } catch (err: any) {
      return reply.code(400).send({ error: `cannot read that bucket: ${err?.message ?? err}`, needsStorage: true });
    }
  });

  app.post('/api/setup/restore', async (req, reply) => {
    if (!(await databaseIsEmpty())) return reply.code(403).send({ error: 'already set up' });
    const body = req.body as any;
    const key = String(body?.key ?? '');
    if (!key) return reply.code(400).send({ error: 'backup key required' });
    try {
      const report = await restoreBackup(key, { store: backupStoreFrom(body) });
      await plog(null, 'backup', `restored ${report.rows} rows from ${report.key}`, { meta: report });
      return { ok: true, ...report };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'restore failed' });
    }
  });

  // ---- in-app manual ----
  app.get('/api/help', async () => {
    const dir = path.resolve(fileURLToPath(import.meta.url), '../../../docs/manual');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => ({
      id: f.replace(/\.md$/, ''),
      title: (fs.readFileSync(path.join(dir, f), 'utf8').match(/^#\s+(.+)$/m)?.[1] ?? f).trim(),
    }));
  });

  app.get('/api/help/:page', async (req, reply) => {
    const page = String((req.params as any).page).replace(/[^a-z0-9-]/gi, '');
    const file = path.resolve(fileURLToPath(import.meta.url), '../../../docs/manual', `${page}.md`);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'not found' });
    reply.type('text/markdown; charset=utf-8');
    return reply.send(fs.readFileSync(file, 'utf8'));
  });

  // ---- getting-started wizard status ----
  app.get('/api/wizard/status', async (req) => {
    const userId = uid(req);
    const accounts = (await one<{ c: number }>('SELECT COUNT(*) c FROM accounts WHERE user_id = ?', [userId]))?.c ?? 0;
    const rules = (await one<{ c: number }>('SELECT COUNT(*) c FROM rules WHERE user_id = ?', [userId]))?.c ?? 0;
    const aiReady = !!(await one("SELECT 1 FROM ai_tasks WHERE user_id = ? AND task = 'classify' AND enabled = true AND provider_id IS NOT NULL", [userId]));
    const devices = (await one<{ c: number }>('SELECT COUNT(*) c FROM app_passwords WHERE user_id = ?', [userId]))?.c ?? 0;
    return { accounts, rules, aiReady, devices };
  });

  // ---- tracking pixel (public) ----
  app.get('/t/:file', async (req, reply) => {
    const m = String((req.params as any).file).match(/^([a-f0-9]{32})\.gif$/);
    if (m) {
      await run('INSERT INTO tracking_opens(token, ts, ip, ua) VALUES (?,?,?,?)',
        [m[1], Date.now(), req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)]);
      await bumpState();
      broadcast({ type: 'stateChange' });
    }
    reply.header('Content-Type', 'image/gif');
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    return reply.send(PIXEL_GIF);
  });

  // ---- web push ----
  app.get('/api/push/key', async () => ({ key: vapidPublicKey() }));
  app.post('/api/push/subscribe', async (req) => { await saveSubscription(uid(req), req.body as any); return { ok: true }; });
  app.post('/api/push/unsubscribe', async (req) => { await removeSubscription((req.body as any).endpoint); return { ok: true }; });

  // ---- JMAP ----
  app.get('/jmap/session', async () => jmapSession());
  app.post('/jmap/api', async (req) => handleJmapRequest(uid(req), req.body as any));
}
