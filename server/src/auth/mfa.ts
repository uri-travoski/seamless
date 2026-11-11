/**
 * Second factor (T0 F-02): TOTP (RFC 6238) + single-use recovery codes.
 * Passkeys (WebAuthn) need a secure context (HTTPS); the user_mfa table already has
 * their columns, the flow lands once the instance is served over HTTPS.
 */
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import { q, one, run, insertId, getSetting } from '../db.ts';
import { encrypt, decrypt, sha256 } from '../crypto.ts';

authenticator.options = { window: 1, step: 30 };

const ISSUER = 'Seamless';
const PENDING_MS = 5 * 60_000;

export async function hasMfa(userId: number): Promise<boolean> {
  return !!(await one('SELECT 1 FROM user_mfa WHERE user_id = ? AND confirmed = true', [userId]));
}

export async function mfaRequiredForAll(): Promise<boolean> {
  return (await getSetting('mfa_required')) === 'true';
}

// ---- login challenge (password ok, second factor pending) ----

const pending = new Map<string, { userId: number; expiresAt: number }>();

export function issueMfaChallenge(userId: number, now = Date.now()): string {
  for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
  const token = crypto.randomBytes(24).toString('hex');
  pending.set(token, { userId, expiresAt: now + PENDING_MS });
  return token;
}

export function peekMfaChallenge(token: string, now = Date.now()): number | null {
  const p = pending.get(token);
  if (!p || p.expiresAt <= now) { pending.delete(token); return null; }
  return p.userId;
}

export function consumeMfaChallenge(token: string): void { pending.delete(token); }

// ---- TOTP ----

/** Begin enrolment: a fresh, unconfirmed secret. Returns the otpauth URI + a QR data URL. */
export async function startTotp(userId: number, accountLabel: string): Promise<{ secret: string; uri: string; qr: string }> {
  await run('DELETE FROM user_mfa WHERE user_id = ? AND kind = ? AND confirmed = false', [userId, 'totp']);
  const secret = authenticator.generateSecret(20);
  await insertId('INSERT INTO user_mfa(user_id, kind, label, secret_enc, confirmed, created_at) VALUES (?,?,?,?,false,?)',
    [userId, 'totp', 'Authenticator app', encrypt(secret), Date.now()]);
  const uri = authenticator.keyuri(accountLabel, ISSUER, secret);
  return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
}

/** Check a 6-digit code against the user's TOTP secret. Rejects a replay of an already used step. */
export async function verifyTotp(userId: number, code: string, opts: { pendingEnrolment?: boolean; now?: number } = {}): Promise<boolean> {
  const clean = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const row = await one<{ id: number; secret_enc: string; last_step: number | null }>(
    'SELECT id, secret_enc, last_step FROM user_mfa WHERE user_id = ? AND kind = ? AND confirmed = ? ORDER BY id DESC LIMIT 1',
    [userId, 'totp', !opts.pendingEnrolment]);
  if (!row) return false;
  const secret = decrypt(row.secret_enc);
  const now = opts.now ?? Date.now();
  // pin the clock per call (tests pass `now`); never mutate the shared instance
  const delta = authenticator.clone({ epoch: now, window: 1, step: 30 }).checkDelta(clean, secret);
  if (delta === null) return false;
  const step = Math.floor(now / 30_000) + delta;
  if (row.last_step !== null && step <= row.last_step) return false;   // replayed
  await run('UPDATE user_mfa SET last_step = ?, last_used_at = ? WHERE id = ?', [step, now, row.id]);
  return true;
}

/** Finish enrolment with a first valid code. Returns 10 recovery codes, shown once. */
export async function confirmTotp(userId: number, code: string): Promise<string[] | null> {
  if (!(await verifyTotp(userId, code, { pendingEnrolment: true }))) return null;
  await run('DELETE FROM user_mfa WHERE user_id = ? AND kind = ? AND confirmed = true', [userId, 'totp']);
  await run('UPDATE user_mfa SET confirmed = true WHERE user_id = ? AND kind = ? AND confirmed = false', [userId, 'totp']);
  return regenerateRecoveryCodes(userId);
}

export async function disableTotp(userId: number): Promise<void> {
  await run('DELETE FROM user_mfa WHERE user_id = ? AND kind = ?', [userId, 'totp']);
  await run('DELETE FROM user_recovery_codes WHERE user_id = ?', [userId]);
}

// ---- recovery codes ----

function newCode(): string {
  const raw = crypto.randomBytes(5).toString('hex');           // 10 hex chars
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

const normCode = (c: string) => String(c ?? '').toLowerCase().replace(/[^a-f0-9]/g, '');

export async function regenerateRecoveryCodes(userId: number): Promise<string[]> {
  await run('DELETE FROM user_recovery_codes WHERE user_id = ?', [userId]);
  const codes = Array.from({ length: 10 }, newCode);
  for (const c of codes) {
    await run('INSERT INTO user_recovery_codes(user_id, code_hash) VALUES (?,?)', [userId, sha256(normCode(c))]);
  }
  return codes;
}

/** Single use: a code works once, then it's spent. */
export async function useRecoveryCode(userId: number, code: string): Promise<boolean> {
  const n = normCode(code);
  if (n.length !== 10) return false;
  const changed = await run('UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
    [Date.now(), userId, sha256(n)]);
  return changed === 1;
}

export async function recoveryCodesLeft(userId: number): Promise<number> {
  return (await one<{ c: number }>('SELECT COUNT(*) AS c FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', [userId]))?.c ?? 0;
}

/** A second factor in whatever form the user typed it: 6-digit TOTP or a recovery code. */
export async function verifySecondFactor(userId: number, code: string): Promise<'totp' | 'recovery' | null> {
  if (/^\s*\d{3}\s?\d{3}\s*$/.test(code ?? '')) return (await verifyTotp(userId, code)) ? 'totp' : null;
  return (await useRecoveryCode(userId, code)) ? 'recovery' : null;
}

export async function mfaStatus(userId: number) {
  const rows = await q<{ kind: string; created_at: number; last_used_at: number | null }>(
    'SELECT kind, created_at, last_used_at FROM user_mfa WHERE user_id = ? AND confirmed = true', [userId]);
  return {
    totp: rows.some((r) => r.kind === 'totp'),
    totpSince: rows.find((r) => r.kind === 'totp')?.created_at ?? null,
    recoveryCodesLeft: await recoveryCodesLeft(userId),
    required: await mfaRequiredForAll(),
  };
}
