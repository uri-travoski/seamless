import type { FastifyInstance, FastifyRequest } from 'fastify';
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
import { getMsgRow, setNote, moveEmail } from './mail/store.ts';
import { loadFilters, filterMatches, type FilterableMessage } from './mail/filters.ts';
import { applyLocalFilterActions } from './mail/ingest.ts';
import { summarizeThread, draftReply } from './ai/tasks.ts';
import { chatComplete, getProvider } from './ai/client.ts';
import { handleJmapRequest, jmapSession, listIdentities } from './jmap/api.ts';
import { vapidPublicKey, saveSubscription, removeSubscription } from './push.ts';
import { broadcast } from './ws.ts';
import { importWorkbook } from './import/xlsx.ts';
import { reclassifyUser, recomputeDisposition, kickClassifier } from './classify/engine.ts';
import { sweepRetention } from './classify/retention.ts';
import { allUserSettings, setUserSetting, SETTING_DEFAULTS } from './classify/settings.ts';

const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const PUBLIC_PATHS = [/^\/t\//, /^\/api\/(login|setup|me)$/, /^\/(?!api|jmap)/];

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
    id: r.id, name: r.name, email: r.email, aliases: JSON.parse(r.aliases),
    imapHost: r.imap_host, imapPort: r.imap_port, imapSecure: !!r.imap_secure, imapUser: r.imap_user,
    smtpHost: r.smtp_host, smtpPort: r.smtp_port, smtpSecure: !!r.smtp_secure, smtpUser: r.smtp_user,
    color: r.color, signature: r.signature, sentCopy: !!r.sent_copy,
    aiCategorize: !!r.ai_categorize, enabled: !!r.enabled,
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

  // ---- processing logs ----
  app.get('/api/logs', async (req) => {
    const kind = (req.query as any).kind as string | undefined;
    const limit = Math.min(Number((req.query as any).limit) || 200, 1000);
    const rows = kind
      ? await q('SELECT id, email_id, kind, level, message, created_at FROM processing_logs WHERE user_id = ? AND kind = ? ORDER BY id DESC LIMIT ?', [uid(req), kind, limit])
      : await q('SELECT id, email_id, kind, level, message, created_at FROM processing_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?', [uid(req), limit]);
    return rows.map((r: any) => ({ id: r.id, emailId: r.email_id, kind: r.kind, level: r.level, message: r.message, createdAt: new Date(r.created_at).toISOString() }));
  });

  app.delete('/api/logs', async (req) => {
    await run('DELETE FROM processing_logs WHERE user_id = ?', [uid(req)]);
    return { ok: true };
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
