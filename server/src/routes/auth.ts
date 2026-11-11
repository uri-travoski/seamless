/** Session auth: who am I, first-run setup, login, logout. */
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { one, run, insertId } from '../db.ts';
import { hashPassword, verifyPassword } from '../crypto.ts';
import { sessionUser, makeSession, type SessionUser } from './util.ts';

const loginAttempts = new Map<string, { count: number; resetAt: number }>();

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
}
