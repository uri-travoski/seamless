import { currentMode } from '../mode.ts';
/** Health report (T2 F-21): everything that can quietly go wrong, in one object the Health page draws. */
import fs from 'node:fs';
import { q, one, pool } from '../db.ts';
import { syncManager } from '../imap/sync.ts';
import { mailStore } from '../s3.ts';
import { config } from '../config.ts';
import { getBackupConfig, getBackupStatus, INTERVAL_HOURS } from '../backup/schedule.ts';
import { pkgVersion } from '../routes/util.ts';

export type Light = 'ok' | 'warn' | 'red';

const DAY = 86_400_000;
const worst = (...l: Light[]): Light => (l.includes('red') ? 'red' : l.includes('warn') ? 'warn' : 'ok');
const AUTH_ERR = /invalid_grant|unauthori[sz]ed|authenticationfailed|invalid credentials|auth.*fail|token/i;

// ---- storage probe, cached so the page (and /healthz) never hammers the bucket ----
let probe: { at: number; ok: boolean; ms: number; error: string } | null = null;
export async function storageProbe(now = Date.now(), force = false): Promise<NonNullable<typeof probe>> {
  if (probe && !force && now - probe.at < 5 * 60_000) return probe;
  const t0 = Date.now();
  try {
    const body = Buffer.from(`probe ${t0}`);
    await mailStore.put('health/probe', body, 'text/plain');
    const back = await mailStore.get('health/probe');
    if (back.toString() !== body.toString()) throw new Error('read back a different value');
    probe = { at: now, ok: true, ms: Date.now() - t0, error: '' };
  } catch (err: any) {
    probe = { at: now, ok: false, ms: Date.now() - t0, error: String(err?.message ?? err) };
  }
  return probe;
}
export function lastStorageProbe() { return probe; }
export function resetStorageProbe() { probe = null; }

export interface BackupHealth { enabled: boolean; lastAt: number | null; lastStatus: string | null; lastError: string; nextDueAt: number | null; status: Light; note: string }

export async function backupHealth(now = Date.now()): Promise<BackupHealth> {
  const cfg = await getBackupConfig();
  const st = await getBackupStatus();
  const interval = INTERVAL_HOURS[cfg.frequency] * 3_600_000;
  let status: Light = 'ok';
  let note = 'Backups are running on schedule.';
  if (!cfg.enabled) { status = 'warn'; note = 'Automatic backups are switched off.'; }
  else if (st.lastStatus === 'error') { status = 'red'; note = `The last backup failed: ${st.lastError || 'unknown error'}`; }
  else if (!st.lastAt || now - st.lastAt > 2 * interval) { status = 'red'; note = st.lastAt ? 'No successful backup for more than twice the usual gap.' : 'No backup has ever completed.'; }
  return { enabled: cfg.enabled, lastAt: st.lastAt, lastStatus: st.lastStatus, lastError: st.lastError, nextDueAt: st.nextDueAt, status, note };
}

export interface MailboxHealth {
  accountId: number; email: string; kind: string; enabled: boolean; state: string; lastSyncAt: number | null; lastError: string;
  failures: number; needsReconnect: boolean; newLast24h: number; status: Light; ignored: boolean;
}

/** One row per mailbox. A mailbox the user ticked "ignore" keeps its real status here (the Health page
 *  shows it, greyed) but never counts towards the overall light, the status dot or alerts. */
export async function mailboxHealth(userId: number, now = Date.now()): Promise<MailboxHealth[]> {
  const accts = await q<{ id: number; email: string; kind: string | null; enabled: boolean; health_ignored: boolean }>('SELECT id, email, kind, enabled, health_ignored FROM accounts WHERE user_id = ? ORDER BY id', [userId]);
  const out: MailboxHealth[] = [];
  for (const a of accts) {
    const st = syncManager.status(a.id);
    const fresh = await one<{ c: string }>('SELECT COUNT(*) AS c FROM messages WHERE account_id = ? AND created_at > ?', [a.id, now - DAY]);
    const needsReconnect = (a.kind === 'gmail' || a.kind === 'microsoft') && st.state === 'error' && st.failures >= 2 && AUTH_ERR.test(st.lastError);
    let status: Light = 'ok';
    if (!a.enabled || st.state === 'paused') status = 'warn';
    else if (st.state === 'error') status = st.failures >= 2 ? 'red' : 'warn';
    if (needsReconnect) status = 'red';
    out.push({ accountId: a.id, email: a.email, kind: a.kind ?? 'imap', enabled: a.enabled, state: st.state, lastSyncAt: st.lastSyncAt, lastError: st.lastError, failures: st.failures, needsReconnect, newLast24h: Number(fresh?.c ?? 0), status, ignored: !!a.health_ignored });
  }
  return out;
}

export async function healthReport(userId: number, isAdmin: boolean, now = Date.now()) {
  const mailboxes = await mailboxHealth(userId, now);

  // ---- sending ----
  const failed = async (since: number) => Number((await one<{ c: string }>(`SELECT COUNT(*) AS c FROM events WHERE user_id = ? AND type = 'send.failed' AND created_at > ?`, [userId, since]))?.c ?? 0);
  const failed24h = await failed(now - DAY);
  const failed7d = await failed(now - 7 * DAY);
  const scheduled = Number((await one<{ c: string }>(`SELECT COUNT(*) AS c FROM scheduled_sends s JOIN accounts a ON a.id = s.account_id WHERE a.user_id = ?`, [userId]))?.c ?? 0);
  const holding = Number((await one<{ c: string }>(`SELECT COUNT(*) AS c FROM jobs WHERE user_id = ? AND kind = 'send.release' AND status = 'pending'`, [userId]))?.c ?? 0);
  const sending = { failed24h, failed7d, scheduled, holding, status: (failed24h > 0 ? 'warn' : 'ok') as Light };

  // ---- jobs ----
  const counts: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const r of await q<{ status: string; c: string }>('SELECT status, COUNT(*) AS c FROM jobs WHERE user_id = ? GROUP BY status', [userId])) counts[r.status] = Number(r.c);
  const oldest = await one<{ run_at: string }>(`SELECT MIN(run_at) AS run_at FROM jobs WHERE user_id = ? AND status = 'pending'`, [userId]);
  const oldestPendingAt = oldest?.run_at ? Number(oldest.run_at) : null;
  const lateMs = oldestPendingAt ? Math.max(0, now - oldestPendingAt) : 0;
  const failedJobs = (await q<any>(`SELECT id, kind, attempts, last_error, run_at FROM jobs WHERE user_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 20`, [userId]))
    .map((j) => ({ id: Number(j.id), kind: j.kind, attempts: j.attempts, lastError: j.last_error ?? '', runAt: Number(j.run_at) }));
  const jobs = { counts, oldestPendingAt, lateMs, failed: failedJobs, status: (lateMs > 5 * 60_000 ? 'red' : failedJobs.length ? 'warn' : 'ok') as Light };

  const ai = { providers: Number((await one<{ c: string }>('SELECT COUNT(*) AS c FROM ai_providers WHERE user_id = ?', [userId]))?.c ?? 0) };

  const report: any = { generatedAt: now, isAdmin, mode: currentMode(), mailboxes, sending, jobs, ai: { ...ai, status: ai.providers ? 'ok' : 'warn', note: ai.providers ? 'Press Test in Settings → AI to check a provider is reachable.' : 'No AI provider is set up.' } };
  report.aiQueue = await (await import('../classify/memory.ts')).aiHealth(userId, now);
  report.attachmentIndex = isAdmin ? await (await import('../mail/attachmentText.ts')).backfillStatus(userId) : null;
  report.archives = (await q<any>("SELECT id, name, status, mode, message_count FROM mail_archives WHERE user_id = ? AND status IN ('planned','running','verifying','restoring') ORDER BY id", [userId]))
    .map((a) => ({ id: a.id, name: a.name, status: a.status, mode: a.mode, messages: a.message_count }));
  report.overall = worst(...mailboxes.filter((m) => !m.ignored).map((m) => m.status), sending.status, jobs.status, report.aiQueue.status === 'red' ? 'red' : 'ok');

  if (isAdmin) {
    const p = await storageProbe(now);
    const size = await one<{ b: string; c: string }>('SELECT COALESCE(SUM(size),0) AS b, COUNT(*) AS c FROM messages');
    report.storage = { reachable: p.ok, latencyMs: p.ms, error: p.error, checkedAt: p.at, bytes: Number(size?.b ?? 0), messages: Number(size?.c ?? 0), spool: !!(await one("SELECT 1 FROM storage_targets WHERE role = 'spool' AND active")), status: (p.ok ? 'ok' : 'red') as Light };
    report.backups = await backupHealth(now);
    let free: number | null = null;
    try { const s = fs.statfsSync(config.dataDir); free = Number(s.bavail) * Number(s.bsize); } catch { /* not supported here */ }
    const dbSize = await one<{ b: string }>('SELECT pg_database_size(current_database()) AS b');
    report.system = { version: pkgVersion, uptimeSec: Math.round(process.uptime()), dbBytes: Number(dbSize?.b ?? 0), rssBytes: process.memoryUsage().rss, freeBytes: free, status: (free !== null && free < 500_000_000 ? 'warn' : 'ok') as Light };
    report.overall = worst(report.overall, report.storage.status, report.backups.status === 'warn' ? 'ok' : report.backups.status, report.system.status);
  }
  return report;
}

/** For GET /healthz: no auth, so nothing but "is it up". */
export async function liveness(): Promise<{ ok: boolean; db: boolean; storage: boolean | null }> {
  let db = false;
  try { await pool.query('SELECT 1'); db = true; } catch { /* down */ }
  const p = lastStorageProbe();
  return { ok: db, db, storage: p ? p.ok : null };
}
