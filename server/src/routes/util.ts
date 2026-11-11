/** Helpers shared by the route modules. */
import type { FastifyRequest } from 'fastify';
import fs from 'node:fs';
import { one, run } from '../db.ts';
import { randomToken } from '../crypto.ts';
import { type AccountRow } from '../imap/sync.ts';

export const pkgVersion = (() => {
  try {
    return (JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

export interface SessionUser { userId: number; role: 'admin' | 'member' }

export async function sessionUser(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await one<{ user_id: number; role: 'admin' | 'member' }>(
    'SELECT s.user_id, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', [token]);
  return row ? { userId: row.user_id, role: row.role } : null;
}

export function uid(req: FastifyRequest): number {
  return (req as any).sessionUser.userId as number;
}

export function isAdmin(req: FastifyRequest): boolean {
  return (req as any).sessionUser?.role === 'admin';
}

export function accountToApi(r: AccountRow) {
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

export async function makeSession(reply: any, userId: number): Promise<void> {
  const token = randomToken(24);
  await run('INSERT INTO sessions(token, user_id, created_at) VALUES (?,?,?)', [token, userId, Date.now()]);
  reply.setCookie('smsession', token, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 90 });
}
