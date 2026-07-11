import { q, one, run, insertId } from '../db.ts';
import { hashPassword, verifyPassword, randomToken } from '../crypto.ts';

/**
 * App passwords: per-device credentials for the IMAP/SMTP/CardDAV facades.
 * The secret is shown once at creation ("sp-" prefix + 24 hex) and stored hashed.
 */

export interface FacadeUser { userId: number; appPasswordId: number; scopes: string[] }

export async function createAppPassword(userId: number, label: string, scopes: string[]): Promise<{ id: number; secret: string }> {
  const secret = `sp-${randomToken(12)}`;
  const id = await insertId('INSERT INTO app_passwords(user_id, label, secret_hash, scopes, created_at) VALUES (?,?,?,?,?)',
    [userId, label, hashPassword(secret), scopes.join(','), Date.now()]);
  return { id, secret };
}

/** Verify email + app password for a facade scope. */
export async function facadeLogin(email: string, secret: string, scope: 'imap' | 'smtp' | 'carddav'): Promise<FacadeUser | null> {
  const user = await one<{ id: number }>('SELECT id FROM users WHERE lower(email) = lower(?)', [email.trim()]);
  if (!user) return null;
  const rows = await q<{ id: number; secret_hash: string; scopes: string }>(
    'SELECT id, secret_hash, scopes FROM app_passwords WHERE user_id = ?', [user.id]);
  for (const r of rows) {
    if (!r.scopes.split(',').includes(scope)) continue;
    if (verifyPassword(secret, r.secret_hash)) {
      await run('UPDATE app_passwords SET last_used_at = ? WHERE id = ?', [Date.now(), r.id]);
      return { userId: user.id, appPasswordId: r.id, scopes: r.scopes.split(',') };
    }
  }
  return null;
}
