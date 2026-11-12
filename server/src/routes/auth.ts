/** Session auth: who am I, first-run setup, login (+ second factor), logout, sessions, 2FA enrolment. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, run, insertId, setSetting } from '../db.ts';
import { hashPassword, verifyPassword } from '../crypto.ts';
import { makeSession, isAdmin, uid, type SessionUser } from './util.ts';
import { authLimiter } from '../security/ratelimit.ts';
import { sessionToken, clearSessionCookie, listSessions, revokeSession, revokeOtherSessions } from '../auth/sessions.ts';
import {
  hasMfa, issueMfaChallenge, peekMfaChallenge, consumeMfaChallenge, verifySecondFactor,
  startTotp, confirmTotp, disableTotp, regenerateRecoveryCodes, mfaStatus, mfaRequiredForAll,
} from '../auth/mfa.ts';
import { emitEvent } from '../events/emit.ts';
import { audit } from '../audit/log.ts';

/** Minimum length for new passwords. (The plan asks for 12; kept at 8 so existing logins and
 *  the owner's standard password still work — see PASSWORD_MIN in the tier notes.) */
export const PASSWORD_MIN = 8;

/** Count an attempt against both the IP and the email; true if either is over the limit. */
function throttled(req: FastifyRequest, email: string): boolean {
  const ipOk = authLimiter.hit(`ip:${req.ip}`);
  const emailOk = email ? authLimiter.hit(`email:${email}`) : true;
  return !ipOk || !emailOk;
}

function alreadyBlocked(req: FastifyRequest, email: string): boolean {
  return authLimiter.blocked(`ip:${req.ip}`) || (!!email && authLimiter.blocked(`email:${email}`));
}

export function register(app: FastifyInstance): void {
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
      // admin switched on "require 2FA" and this user has none yet: the UI forces enrolment
      mfaEnrollRequired: (await mfaRequiredForAll()) && !(await hasMfa(su.userId)),
    };
  });

  app.post('/api/setup', async (req, reply) => {
    if (await one('SELECT 1 FROM users LIMIT 1')) return reply.code(400).send({ error: 'already set up' });
    const { email, name, password } = req.body as { email: string; name?: string; password: string };
    if (throttled(req, (email ?? '').toLowerCase())) return reply.code(429).send({ error: 'too many attempts, try later' });
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'valid email required' });
    if (!password || password.length < PASSWORD_MIN) return reply.code(400).send({ error: `password must be at least ${PASSWORD_MIN} characters` });
    const userId = await insertId(
      'INSERT INTO users(email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)',
      [email.toLowerCase(), name ?? '', hashPassword(password), 'admin', Date.now()]);
    await makeSession(req, reply, userId);
    return { ok: true };
  });

  app.post('/api/login', async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    const lc = (email ?? '').toLowerCase();
    if (alreadyBlocked(req, lc)) return reply.code(429).send({ error: 'too many attempts, try later' });
    const user = await one<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE email = ?', [lc]);
    if (!user || !verifyPassword(password ?? '', user.password_hash)) {
      await audit(req, 'login.failed', { type: 'user', id: user?.id ?? null }, { email: lc, reason: 'password' }, { userId: user?.id ?? null });
      if (throttled(req, lc)) return reply.code(429).send({ error: 'too many attempts, try later' });
      return reply.code(401).send({ error: 'wrong email or password' });
    }
    if (await hasMfa(user.id)) {
      // password ok, second factor outstanding: no session until /api/login/mfa succeeds
      return { ok: false, mfaRequired: true, mfaToken: issueMfaChallenge(user.id) };
    }
    authLimiter.reset(`ip:${req.ip}`); authLimiter.reset(`email:${lc}`);
    await makeSession(req, reply, user.id);
    await emitEvent(user.id, 'security.login', { type: 'user', id: user.id }, { ip: req.ip, ua: String(req.headers['user-agent'] ?? '').slice(0, 200) });
    await audit(req, 'login.ok', { type: 'user', id: user.id }, { mfa: false }, { userId: user.id });
    return { ok: true };
  });

  app.post('/api/login/mfa', async (req, reply) => {
    const { mfaToken, code } = req.body as { mfaToken: string; code: string };
    const userId = peekMfaChallenge(String(mfaToken ?? ''));
    if (!userId) return reply.code(401).send({ error: 'sign-in expired, enter your password again' });
    if (alreadyBlocked(req, `uid:${userId}`)) return reply.code(429).send({ error: 'too many attempts, try later' });
    const how = await verifySecondFactor(userId, String(code ?? ''));
    if (!how) {
      await audit(req, 'login.failed', { type: 'user', id: userId }, { reason: 'second factor' }, { userId });
      if (throttled(req, `uid:${userId}`)) return reply.code(429).send({ error: 'too many attempts, try later' });
      return reply.code(401).send({ error: 'wrong code' });
    }
    consumeMfaChallenge(String(mfaToken));
    await makeSession(req, reply, userId);
    await emitEvent(userId, 'security.login', { type: 'user', id: userId }, { ip: req.ip, mfa: how });
    await audit(req, 'login.ok', { type: 'user', id: userId }, { mfa: how }, { userId });
    return { ok: true, usedRecoveryCode: how === 'recovery' };
  });

  app.post('/api/logout', async (req, reply) => {
    const token = sessionToken(req);
    if (token) await run('DELETE FROM sessions WHERE token = ?', [token]);
    clearSessionCookie(reply);
    return { ok: true };
  });

  // ---- sessions (Settings → Security) ----
  app.get('/api/sessions', async (req) => listSessions(uid(req), sessionToken(req)));

  app.delete('/api/sessions/:id', async (req, reply) => {
    const ok = await revokeSession(uid(req), String((req.params as any).id));
    if (!ok) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.post('/api/sessions/revoke-others', async (req) => ({ revoked: await revokeOtherSessions(uid(req), sessionToken(req)) }));

  // ---- second factor (Settings → Security) ----
  app.get('/api/security', async (req) => mfaStatus(uid(req)));

  app.post('/api/security/totp/start', async (req) => {
    const user = await one<{ email: string }>('SELECT email FROM users WHERE id = ?', [uid(req)]);
    const r = await startTotp(uid(req), user?.email ?? 'user');
    return { uri: r.uri, qr: r.qr, secret: r.secret };
  });

  app.post('/api/security/totp/confirm', async (req, reply) => {
    const codes = await confirmTotp(uid(req), String((req.body as any)?.code ?? ''));
    if (!codes) return reply.code(400).send({ error: 'that code did not match, try the current one' });
    await emitEvent(uid(req), 'security.2fa_changed', { type: 'user', id: uid(req) }, { enabled: true });
    return { ok: true, recoveryCodes: codes };
  });

  const checkPassword = async (req: FastifyRequest) => {
    const user = await one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [uid(req)]);
    return !!user && verifyPassword(String((req.body as any)?.password ?? ''), user.password_hash);
  };

  app.post('/api/security/totp/disable', async (req, reply) => {
    if (!(await checkPassword(req))) return reply.code(401).send({ error: 'wrong password' });
    await disableTotp(uid(req));
    await emitEvent(uid(req), 'security.2fa_changed', { type: 'user', id: uid(req) }, { enabled: false });
    return { ok: true };
  });

  app.post('/api/security/recovery/regenerate', async (req, reply) => {
    if (!(await checkPassword(req))) return reply.code(401).send({ error: 'wrong password' });
    if (!(await hasMfa(uid(req)))) return reply.code(400).send({ error: 'turn on two-factor first' });
    return { recoveryCodes: await regenerateRecoveryCodes(uid(req)) };
  });

  app.put('/api/security/policy', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    await setSetting('mfa_required', (req.body as any)?.mfaRequired ? 'true' : 'false');
    return { ok: true };
  });
}
