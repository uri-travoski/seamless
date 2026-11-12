/**
 * Per-user storage quotas (T8.1). Usage = bytes of every message in the user's OWN mailboxes (messages.size is the whole
 * raw message, attachments included, so attachments are not added a second time). Mail shared with the user from someone
 * else's mailbox counts for its owner. A quota only ever warns: nothing is refused or deleted when it is exceeded.
 */
import { pool, q, one, getSetting, setSetting } from '../db.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { emitEvent } from '../events/emit.ts';

const GB = 1024 ** 3;
const CACHE_MS = 5 * 60_000;
export const WARN_AT = 0.8;
export const REARM_BELOW = 0.75;
const EVERY_MS = 30 * 60_000;

const cache = new Map<number, { at: number; bytes: number }>();
export function clearUsageCache(): void { cache.clear(); }

export const gbToBytes = (gb: number): number => Math.round(gb * GB);

/** Bytes used by one user's own mailboxes; cached for 5 minutes unless `fresh`. */
export async function userUsageBytes(userId: number, opts: { fresh?: boolean; now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const hit = cache.get(userId);
  if (!opts.fresh && hit && now - hit.at < CACHE_MS) return hit.bytes;
  const r = await one<{ b: string }>(
    'SELECT COALESCE(SUM(m.size),0) AS b FROM messages m JOIN accounts a ON a.id = m.account_id WHERE a.user_id = ?', [userId]);
  const bytes = Number(r?.b ?? 0);
  cache.set(userId, { at: now, bytes });
  return bytes;
}

/** Same numbers for every user in one query (the admin table). */
export async function allUsageBytes(): Promise<Map<number, number>> {
  const rows = await q<{ user_id: number; b: string }>(
    'SELECT a.user_id, COALESCE(SUM(m.size),0) AS b FROM messages m JOIN accounts a ON a.id = m.account_id GROUP BY a.user_id');
  const now = Date.now();
  const out = new Map<number, number>();
  for (const r of rows) { out.set(r.user_id, Number(r.b)); cache.set(r.user_id, { at: now, bytes: Number(r.b) }); }
  return out;
}

export async function defaultQuotaBytes(): Promise<number | null> {
  const v = await getSetting('default_user_quota_bytes');
  const n = v == null || v === '' ? null : Number(v);
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}
export async function setDefaultQuotaBytes(bytes: number | null): Promise<void> {
  await setSetting('default_user_quota_bytes', bytes == null ? '' : String(Math.round(bytes)));
}

export interface UsageView { usedBytes: number; quotaBytes: number | null; percent: number | null }
export function usageView(usedBytes: number, quotaBytes: number | null): UsageView {
  return { usedBytes, quotaBytes, percent: quotaBytes ? Math.round((usedBytes / quotaBytes) * 1000) / 10 : null };
}

/** Parse a "GB" value from the UI: '' / null = unlimited. Returns undefined when invalid. */
export function parseQuotaGb(v: unknown): number | null | undefined {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return undefined;
  return gbToBytes(n);
}

/**
 * Raise `quota.warning` at 80 % and `quota.full` at 100 %, to the user and every admin, once per threshold until usage falls below 75 %.
 * Returns what was raised (for tests / logs).
 */
export async function checkQuotas(now = Date.now()): Promise<{ userId: number; level: 'warning' | 'full' }[]> {
  const raised: { userId: number; level: 'warning' | 'full' }[] = [];
  const users = (await pool.query(
    "SELECT id, email, name, storage_quota_bytes FROM users WHERE storage_quota_bytes IS NOT NULL AND disabled = false")).rows as
    { id: number; email: string; name: string; storage_quota_bytes: string }[];
  const admins = (await pool.query("SELECT id FROM users WHERE role = 'admin' AND disabled = false")).rows as { id: number }[];
  // users who lost their quota (or were set to unlimited) must be able to re-arm later
  await pool.query('DELETE FROM quota_alerts WHERE user_id NOT IN (SELECT id FROM users WHERE storage_quota_bytes IS NOT NULL)');
  for (const u of users) {
    const quota = Number(u.storage_quota_bytes);
    const used = await userUsageBytes(u.id, { fresh: true, now });
    const ratio = used / quota;
    const have = new Set(((await pool.query('SELECT level FROM quota_alerts WHERE user_id = $1', [u.id])).rows as { level: string }[]).map((r) => r.level));
    if (ratio < REARM_BELOW) {
      if (have.size) await pool.query('DELETE FROM quota_alerts WHERE user_id = $1', [u.id]);
      continue;
    }
    let level: 'warning' | 'full' | null = null;
    if (ratio >= 1 && !have.has('full')) level = 'full';
    else if (ratio >= WARN_AT && ratio < 1 && !have.has('warning')) level = 'warning';
    if (!level) continue;
    // claim the threshold first: a second worker's INSERT conflicts and sends nothing
    const claimed = await pool.query('INSERT INTO quota_alerts(user_id, level, raised_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [u.id, level, now]);
    if (level === 'full') await pool.query('INSERT INTO quota_alerts(user_id, level, raised_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [u.id, 'warning', now]);
    if (!claimed.rowCount) continue;
    const payload = { forUserId: u.id, email: u.email, name: u.name, usedBytes: used, quotaBytes: quota, percent: Math.round(ratio * 100) };
    const type = level === 'full' ? 'quota.full' : 'quota.warning';
    const recipients = new Set<number>([u.id, ...admins.map((a) => a.id)]);
    for (const r of recipients) await emitEvent(r, type, { type: 'user', id: u.id }, { ...payload, own: r === u.id });
    raised.push({ userId: u.id, level });
  }
  return raised;
}

registerJob('quota.check', async () => {
  try { await checkQuotas(); }
  finally { await enqueueJob(null, 'quota.check', Date.now() + EVERY_MS, {}); }
});

/** Exactly one pending `quota.check` job; safe to call on every boot. */
export async function ensureQuotaJob(now = Date.now()): Promise<void> {
  const pending = await one(`SELECT 1 FROM jobs WHERE kind = 'quota.check' AND status IN ('pending','running') LIMIT 1`);
  if (!pending) await enqueueJob(null, 'quota.check', now + 60_000, {});
}
