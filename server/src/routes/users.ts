/** Users (admin manages; anyone changes own password) + per-user client settings. */
import type { FastifyInstance } from 'fastify';
import { q, one, run, insertId } from '../db.ts';
import { hashPassword, verifyPassword } from '../crypto.ts';
import { syncManager } from '../imap/sync.ts';
import { uid, isAdmin } from './util.ts';
import { audit } from '../audit/log.ts';
import { revokeOtherSessions, sessionToken } from '../auth/sessions.ts';
import { allUsageBytes, userUsageBytes, usageView, defaultQuotaBytes, setDefaultQuotaBytes, parseQuotaGb } from '../admin/quota.ts';

interface UserRow { id: number; email: string; name: string; role: 'admin' | 'member'; disabled: boolean }

export function register(app: FastifyInstance): void {
  // ---- users (admin manages; anyone can change own password) ----
  const guard = (req: any, reply: any) => (isAdmin(req) ? false : (reply.code(403).send({ error: 'admin only' }), true));
  const targetOf = async (req: any, reply: any): Promise<UserRow | null> => {
    const t = await one<UserRow>('SELECT id, email, name, role, disabled FROM users WHERE id = ?', [Number(req.params.id)]);
    if (!t) reply.code(404).send({ error: 'user not found' });
    return t ?? null;
  };
  /** True when `id` is an active admin and nobody else active would be left as admin. */
  const isLastActiveAdmin = async (t: UserRow): Promise<boolean> => {
    if (t.role !== 'admin' || t.disabled) return false;
    return !(await one("SELECT 1 FROM users WHERE role = 'admin' AND disabled = false AND id <> ?", [t.id]));
  };
  const LAST_ADMIN = 'This is the last active administrator. Make someone else an admin first.';

  app.get('/api/users', async (req, reply) => {
    if (guard(req, reply)) return;
    const rows = await q<any>(`SELECT id, email, name, role, created_at, disabled, must_change_password, last_login_at, storage_quota_bytes
                               FROM users ORDER BY id`);
    const usage = await allUsageBytes();
    const boxes = await q<{ user_id: number; id: number; email: string }>('SELECT user_id, id, email FROM accounts ORDER BY id');
    return rows.map((u) => {
      const mine = boxes.filter((b) => b.user_id === u.id);
      const quota = u.storage_quota_bytes == null ? null : Number(u.storage_quota_bytes);
      return {
        id: u.id, email: u.email, name: u.name, role: u.role, createdAt: Number(u.created_at),
        disabled: u.disabled, mustChangePassword: u.must_change_password,
        lastLoginAt: u.last_login_at == null ? null : Number(u.last_login_at),
        mailboxCount: mine.length, mailboxes: mine.map((b) => b.email),
        ...usageView(usage.get(u.id) ?? 0, quota),
      };
    });
  });

  app.get('/api/users/quota-default', async (req, reply) => {
    if (guard(req, reply)) return;
    return { bytes: await defaultQuotaBytes() };
  });

  app.put('/api/users/quota-default', async (req, reply) => {
    if (guard(req, reply)) return;
    const bytes = parseQuotaGb((req.body as any)?.gb);
    if (bytes === undefined) return reply.code(400).send({ error: 'enter a size in GB, or leave it empty for no limit' });
    await setDefaultQuotaBytes(bytes);
    await audit(req, 'quota.default_change', { type: 'instance' }, { bytes });
    return { ok: true, bytes };
  });

  /** The signed-in user's own space (Settings → Storage → "Your mailbox space"). */
  app.get('/api/usage/mine', async (req) => {
    const u = await one<{ storage_quota_bytes: string | null }>('SELECT storage_quota_bytes FROM users WHERE id = ?', [uid(req)]);
    return usageView(await userUsageBytes(uid(req)), u?.storage_quota_bytes == null ? null : Number(u.storage_quota_bytes));
  });

  app.post('/api/users', async (req, reply) => {
    if (guard(req, reply)) return;
    const b = req.body as { email: string; name?: string; password: string; role?: string; quotaGb?: unknown; mustChangePassword?: boolean };
    if (!b.email || !/^[^@\s]+@[^@\s]+$/.test(b.email)) return reply.code(400).send({ error: 'valid email required' });
    if (!b.password || b.password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    if (await one('SELECT 1 FROM users WHERE email = ?', [b.email.toLowerCase()])) {
      return reply.code(400).send({ error: 'email already exists' });
    }
    // new users start with the instance default quota unless the admin typed one (empty = unlimited)
    let quota: number | null;
    if (b.quotaGb === undefined) quota = await defaultQuotaBytes();
    else { const p = parseQuotaGb(b.quotaGb); if (p === undefined) return reply.code(400).send({ error: 'invalid storage limit' }); quota = p; }
    const id = await insertId(
      'INSERT INTO users(email, name, password_hash, role, created_at, storage_quota_bytes, must_change_password) VALUES (?,?,?,?,?,?,?)',
      [b.email.toLowerCase(), b.name ?? '', hashPassword(b.password), b.role === 'admin' ? 'admin' : 'member', Date.now(), quota, !!b.mustChangePassword]);
    return { id };
  });

  app.put('/api/users/:id', async (req, reply) => {
    if (guard(req, reply)) return;
    const t = await targetOf(req, reply); if (!t) return;
    const b = (req.body ?? {}) as { name?: string; role?: string; quotaGb?: unknown };
    const role = b.role === undefined ? t.role : b.role === 'admin' ? 'admin' : 'member';
    if (role !== 'admin' && (await isLastActiveAdmin(t))) return reply.code(400).send({ error: LAST_ADMIN });
    let quota: number | null | undefined;
    if ('quotaGb' in b) { quota = parseQuotaGb(b.quotaGb); if (quota === undefined) return reply.code(400).send({ error: 'invalid storage limit' }); }
    await run('UPDATE users SET name = ?, role = ? WHERE id = ?', [b.name ?? t.name, role, t.id]);
    if (quota !== undefined) await run('UPDATE users SET storage_quota_bytes = ? WHERE id = ?', [quota, t.id]);
    // a role change takes effect on the next request (role is read per request, sessions need not be dropped)
    await audit(req, 'user.update', { type: 'user', id: t.id }, { email: t.email, role, roleBefore: t.role, ...(quota !== undefined ? { quotaBytes: quota } : {}) });
    return { ok: true };
  });

  app.post('/api/users/:id/reset-password', async (req, reply) => {
    if (guard(req, reply)) return;
    const t = await targetOf(req, reply); if (!t) return;
    if (t.id === uid(req)) return reply.code(400).send({ error: 'use “Change my password” for your own account' });
    const password = String((req.body as any)?.password ?? '');
    if (password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    await run('UPDATE users SET password_hash = ?, must_change_password = true WHERE id = ?', [hashPassword(password), t.id]);
    await run('DELETE FROM sessions WHERE user_id = ?', [t.id]);
    await audit(req, 'user.password_reset', { type: 'user', id: t.id }, { email: t.email });
    return { ok: true };
  });

  app.post('/api/users/:id/disable', async (req, reply) => {
    if (guard(req, reply)) return;
    const t = await targetOf(req, reply); if (!t) return;
    if (t.id === uid(req)) return reply.code(400).send({ error: 'you cannot disable your own account' });
    if (await isLastActiveAdmin(t)) return reply.code(400).send({ error: LAST_ADMIN });
    await run('UPDATE users SET disabled = true WHERE id = ?', [t.id]);
    await run('DELETE FROM sessions WHERE user_id = ?', [t.id]);
    for (const a of await q<{ id: number }>('SELECT id FROM accounts WHERE user_id = ?', [t.id])) syncManager.stopAccount(a.id);
    await audit(req, 'user.disable', { type: 'user', id: t.id }, { email: t.email });
    return { ok: true };
  });

  app.post('/api/users/:id/enable', async (req, reply) => {
    if (guard(req, reply)) return;
    const t = await targetOf(req, reply); if (!t) return;
    await run('UPDATE users SET disabled = false WHERE id = ?', [t.id]);
    for (const a of await q<{ id: number }>('SELECT id FROM accounts WHERE user_id = ?', [t.id])) await syncManager.restartAccount(a.id);
    await audit(req, 'user.enable', { type: 'user', id: t.id }, { email: t.email });
    return { ok: true };
  });

  /** "Sign out everywhere". For yourself, the session you are using stays. */
  app.post('/api/users/:id/sign-out', async (req, reply) => {
    if (guard(req, reply)) return;
    const t = await targetOf(req, reply); if (!t) return;
    const n = t.id === uid(req) ? await revokeOtherSessions(t.id, sessionToken(req)) : await run('DELETE FROM sessions WHERE user_id = ?', [t.id]);
    await audit(req, 'user.sign_out_everywhere', { type: 'user', id: t.id }, { email: t.email, sessions: n });
    return { ok: true, revoked: n };
  });

  app.delete('/api/users/:id', async (req, reply) => {
    if (guard(req, reply)) return;
    const t = await targetOf(req, reply); if (!t) return;
    if (t.id === uid(req)) return reply.code(400).send({ error: 'cannot delete yourself' });
    if (await isLastActiveAdmin(t)) return reply.code(400).send({ error: LAST_ADMIN });
    const accounts = await q<{ id: number }>('SELECT id FROM accounts WHERE user_id = ?', [t.id]);
    for (const a of accounts) syncManager.stopAccount(a.id);
    await run('DELETE FROM users WHERE id = ?', [t.id]);
    return { ok: true };
  });

  app.put('/api/users/password', async (req, reply) => {
    const { current, password } = req.body as { current: string; password: string };
    if (!password || password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    const user = await one<{ password_hash: string; must_change_password: boolean }>('SELECT password_hash, must_change_password FROM users WHERE id = ?', [uid(req)]);
    if (!user || !verifyPassword(current ?? '', user.password_hash)) return reply.code(401).send({ error: 'wrong current password' });
    if (user.must_change_password && password === current) return reply.code(400).send({ error: 'choose a different password from the temporary one' });
    await run('UPDATE users SET password_hash = ?, must_change_password = false WHERE id = ?', [hashPassword(password), uid(req)]);
    return { ok: true };
  });

  // ---- client settings (per user) ----
  app.put('/api/settings', async (req) => {
    await run('UPDATE users SET settings_json = ? WHERE id = ?', [JSON.stringify(req.body ?? {}), uid(req)]);
    return { ok: true };
  });
}
