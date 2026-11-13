/**
 * Unknown addresses on a disposable domain (T10.1). Mail to an address that is neither the mailbox nor a
 * disposable address is, by default, quarantined: kept out of sight in Settings → Disposable for a week,
 * where it can be turned into a real disposable address ("Create this address") or blocked.
 */
import { q, one, run, insertId, bumpState } from '../db.ts';
import { sha256 } from '../crypto.ts';
import { putBlob, getBlob, deleteBlob } from '../s3.ts';
import { broadcast } from '../ws.ts';
import { getUserSetting } from '../classify/settings.ts';
import { simpleParser } from 'mailparser';

export type UnknownPolicy = 'quarantine' | 'deliver' | 'drop';
export const POLICIES: UnknownPolicy[] = ['quarantine', 'deliver', 'drop'];
export const NO_ADDRESS = '(no address)';
export const DEFAULT_QUARANTINE_DAYS = 7;

export interface UnknownRow {
  id: number; user_id: number; account_id: number; domain: string; address: string; status: 'quarantine' | 'blocked';
  received_count: number; dropped_count: number; last_from: string; last_subject: string; first_at: string; last_at: string;
}

/** Legacy `reject` means `drop`. */
export const normalizePolicy = (p: string | undefined | null): UnknownPolicy => (p === 'deliver' ? 'deliver' : p === 'quarantine' ? 'quarantine' : p ? 'drop' : 'deliver');

async function changed(userId: number) { await bumpState(); broadcast({ type: 'stateChange' }, userId); }

export const isBlockedAddress = async (accountId: number, address: string) =>
  !!(await one("SELECT 1 FROM unknown_addresses WHERE account_id = ? AND address = ? AND status = 'blocked'", [accountId, address]));

/** Count a dropped message against a blocked address. */
export async function countDropped(accountId: number, address: string): Promise<void> {
  await run("UPDATE unknown_addresses SET dropped_count = dropped_count + 1, last_at = ? WHERE account_id = ? AND address = ? AND status = 'blocked'", [Date.now(), accountId, address]);
}

/** Store a raw message in quarantine. Throws if the blob cannot be written (the caller then leaves the mail at the source). */
export async function quarantineMail(accountId: number, address: string, domain: string, raw: Buffer): Promise<number> {
  const acct = await one<{ user_id: number }>('SELECT user_id FROM accounts WHERE id = ?', [accountId]);
  if (!acct) throw new Error('no such account');
  const parsed = await simpleParser(raw.subarray(0, 262144)).catch(() => null);
  const from = parsed?.from?.text ?? '';
  const subject = parsed?.subject ?? '';
  const now = Date.now();
  const key = `quarantine/${accountId}/${sha256(raw)}.eml`;
  await putBlob(key, raw);
  const row = await one<{ id: number }>(`
    INSERT INTO unknown_addresses(user_id, account_id, domain, address, received_count, last_from, last_subject, first_at, last_at)
    VALUES (?,?,?,?,1,?,?,?,?)
    ON CONFLICT (account_id, address) DO UPDATE SET received_count = unknown_addresses.received_count + 1,
      last_from = excluded.last_from, last_subject = excluded.last_subject, last_at = excluded.last_at
    RETURNING id`, [acct.user_id, accountId, domain, address, from.slice(0, 200), subject.slice(0, 200), now, now]);
  await insertId('INSERT INTO quarantined_mail(user_id, unknown_id, s3_key, from_addr, subject, received_at) VALUES (?,?,?,?,?,?)',
    [acct.user_id, row!.id, key, from.slice(0, 200), subject.slice(0, 200), now]);
  await changed(acct.user_id);
  return row!.id;
}

export const listUnknown = (userId: number) =>
  q<UnknownRow & { held: number }>(
    `SELECT u.*, (SELECT COUNT(*)::int FROM quarantined_mail m WHERE m.unknown_id = u.id) AS held
     FROM unknown_addresses u WHERE u.user_id = ? ORDER BY u.last_at DESC, u.id DESC`, [userId]);

export const getUnknown = (userId: number, id: number) =>
  one<UnknownRow>('SELECT * FROM unknown_addresses WHERE id = ? AND user_id = ?', [id, userId]);

async function deleteHeld(unknownId: number): Promise<void> {
  const held = await q<{ id: number; s3_key: string }>('SELECT id, s3_key FROM quarantined_mail WHERE unknown_id = ?', [unknownId]);
  await run('DELETE FROM quarantined_mail WHERE unknown_id = ?', [unknownId]);
  for (const h of held) {
    // blobs are content-addressed: only delete when no other held message uses the key
    if (!(await one('SELECT 1 FROM quarantined_mail WHERE s3_key = ?', [h.s3_key]))) await deleteBlob(h.s3_key).catch(() => {});
  }
}

/** Raw messages held for an address (for "Create this address"). */
export async function heldRaw(unknownId: number): Promise<Buffer[]> {
  const held = await q<{ s3_key: string }>('SELECT s3_key FROM quarantined_mail WHERE unknown_id = ? ORDER BY id', [unknownId]);
  const out: Buffer[] = [];
  for (const h of held) out.push(await getBlob(h.s3_key));
  return out;
}

export async function blockUnknown(userId: number, id: number): Promise<UnknownRow | null | undefined> {
  const row = await getUnknown(userId, id);
  if (!row) return null;
  await deleteHeld(id);
  await run("UPDATE unknown_addresses SET status = 'blocked' WHERE id = ?", [id]);
  await changed(userId);
  return getUnknown(userId, id);
}

export async function removeUnknown(userId: number, id: number): Promise<boolean> {
  const row = await getUnknown(userId, id);
  if (!row) return false;
  await deleteHeld(id);
  await run('DELETE FROM unknown_addresses WHERE id = ?', [id]);
  await changed(userId);
  return true;
}

/** Purge held mail older than the user's retention (default 7 days) and quarantine rows left empty. */
export async function purgeQuarantine(now = Date.now()): Promise<number> {
  const users = await q<{ user_id: number }>('SELECT DISTINCT user_id FROM quarantined_mail');
  let n = 0;
  for (const { user_id } of users) {
    const days = Math.max(1, Number(await getUserSetting(user_id, 'unknown_days')) || DEFAULT_QUARANTINE_DAYS);
    const old = await q<{ id: number; unknown_id: number; s3_key: string }>('SELECT id, unknown_id, s3_key FROM quarantined_mail WHERE user_id = ? AND received_at < ?', [user_id, now - days * 86_400_000]);
    for (const m of old) {
      await run('DELETE FROM quarantined_mail WHERE id = ?', [m.id]);
      if (!(await one('SELECT 1 FROM quarantined_mail WHERE s3_key = ?', [m.s3_key]))) await deleteBlob(m.s3_key).catch(() => {});
      n++;
    }
    if (old.length) {
      await run(`DELETE FROM unknown_addresses u WHERE u.user_id = ? AND u.status = 'quarantine' AND NOT EXISTS (SELECT 1 FROM quarantined_mail m WHERE m.unknown_id = u.id)`, [user_id]);
      await changed(user_id);
    }
  }
  return n;
}
