/**
 * Server-side sessions (T0 F-01): sliding 30-day idle expiry, 90-day absolute cap,
 * listable and revocable. The cookie is `Secure` (and `__Host-` prefixed) whenever the
 * instance is served over HTTPS.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { one, q, run } from '../db.ts';
import { randomToken } from '../crypto.ts';
import { config } from '../config.ts';

export const IDLE_MS = 30 * 86_400_000;
export const ABSOLUTE_MS = 90 * 86_400_000;
const TOUCH_EVERY_MS = 60_000;

export const httpsInstance = config.publicUrl.startsWith('https://');
/** `__Host-` requires Secure + Path=/ + no Domain, which is exactly what we set on HTTPS. */
export const SESSION_COOKIE = httpsInstance ? '__Host-smsession' : 'smsession';

export interface SessionUser { userId: number; role: 'admin' | 'member'; token: string }

export function sessionToken(req: FastifyRequest): string | undefined {
  return (req as any).cookies?.[SESSION_COOKIE];
}

/** Resolve a token to its user, enforcing expiry and sliding the idle window forward. */
export async function sessionUser(token: string | undefined, now = Date.now()): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await one<{ user_id: number; role: 'admin' | 'member'; created_at: number; last_seen_at: number | null; expires_at: number | null }>(
    `SELECT s.user_id, u.role, s.created_at, s.last_seen_at, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, [token]);
  if (!row) return null;
  const expires = row.expires_at ?? row.created_at + IDLE_MS;
  if (now >= expires || now >= row.created_at + ABSOLUTE_MS) {
    await run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  if (!row.last_seen_at || now - row.last_seen_at > TOUCH_EVERY_MS) {
    await run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token = ?',
      [now, Math.min(row.created_at + ABSOLUTE_MS, now + IDLE_MS), token]);
  }
  return { userId: row.user_id, role: row.role, token };
}

export async function createSession(userId: number, meta: { ip?: string; userAgent?: string } = {}, now = Date.now()): Promise<string> {
  const token = randomToken(24);
  await run(`INSERT INTO sessions(token, user_id, created_at, last_seen_at, expires_at, ip, user_agent)
             VALUES (?,?,?,?,?,?,?)`,
    [token, userId, now, now, now + IDLE_MS, meta.ip ?? '', (meta.userAgent ?? '').slice(0, 300)]);
  return token;
}

export function cookieOptions(https = httpsInstance) {
  return { name: https ? '__Host-smsession' : 'smsession', path: '/', httpOnly: true, sameSite: 'lax' as const, secure: https, maxAge: ABSOLUTE_MS / 1000 };
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  const { name, ...opts } = cookieOptions();
  reply.setCookie(name, token, opts);
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', secure: httpsInstance });
}

export async function makeSession(req: FastifyRequest, reply: FastifyReply, userId: number): Promise<void> {
  const token = await createSession(userId, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
  setSessionCookie(reply, token);
}

export interface SessionInfo {
  id: string;            // short public handle (never the token itself)
  current: boolean;
  ip: string;
  userAgent: string;
  createdAt: number;
  lastSeenAt: number | null;
  expiresAt: number | null;
}

/** Sessions are addressed by a hash prefix so the API never returns a usable token. */
async function handleOf(token: string): Promise<string> {
  const { sha256 } = await import('../crypto.ts');
  return sha256(token).slice(0, 16);
}

export async function listSessions(userId: number, currentToken: string | undefined): Promise<SessionInfo[]> {
  const rows = await q<any>('SELECT token, ip, user_agent, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_seen_at, created_at) DESC', [userId]);
  const now = Date.now();
  const out: SessionInfo[] = [];
  for (const r of rows) {
    if ((r.expires_at && r.expires_at <= now) || r.created_at + ABSOLUTE_MS <= now) continue;
    out.push({
      id: await handleOf(r.token), current: r.token === currentToken, ip: r.ip, userAgent: r.user_agent,
      createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at,
    });
  }
  return out;
}

export async function revokeSession(userId: number, handle: string): Promise<boolean> {
  const rows = await q<{ token: string }>('SELECT token FROM sessions WHERE user_id = ?', [userId]);
  for (const r of rows) {
    if ((await handleOf(r.token)) === handle) {
      await run('DELETE FROM sessions WHERE token = ?', [r.token]);
      return true;
    }
  }
  return false;
}

/** "Sign out everywhere": every session except the caller's own. */
export async function revokeOtherSessions(userId: number, keepToken: string | undefined): Promise<number> {
  return run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', [userId, keepToken ?? '']);
}

export async function pruneExpiredSessions(now = Date.now()): Promise<number> {
  return run('DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?', [now, now - ABSOLUTE_MS]);
}
