/**
 * Database maintenance framework (T10.3): settings per task, one-at-a-time execution (Postgres advisory lock), skipping
 * while a backup/archive/migration runs, the maintenance log, the `maintenance.run` jobs that re-enqueue themselves, and
 * an admin alert after two failures in a row.
 */
import { pool, q, one, run } from '../db.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { raiseAlert, resolveAlerts } from '../alerts/engine.ts';
import { TASKS, taskById, type TaskDef, type TaskCtx, type TaskResult } from './tasks.ts';
import { busyNow } from './busy.ts';

const HOUR = 3_600_000;
/** one fixed key: only one maintenance task at a time, instance-wide */
const LOCK_KEY = 7_310_003;

export interface TaskSettings { task: string; enabled: boolean; intervalHours: number; retentionDays: number | null; autoDelete: boolean }
export interface LogRow {
  id: number; task: string; trigger: 'auto' | 'manual'; userId: number | null; userName: string | null; dryRun: boolean; status: 'ok' | 'failed' | 'skipped';
  rowsRemoved: number; bytesFreed: number; durationMs: number; details: Record<string, any>; error: string | null; startedAt: number; finishedAt: number;
}

/** Test hook: pause between delete batches (ms). */
let pauseMs = 100;
export function setMaintenancePause(ms: number): void { pauseMs = ms; }

export async function ensureSettings(): Promise<void> {
  for (const t of TASKS) {
    await run(`INSERT INTO maintenance_settings(task, enabled, interval_hours, retention_days, auto_delete) VALUES (?,?,?,?,false) ON CONFLICT (task) DO NOTHING`,
      [t.id, !t.manualOnly, t.defaultIntervalHours, t.defaultRetentionDays]);
  }
}

const toSettings = (r: any): TaskSettings => ({ task: r.task, enabled: !!r.enabled, intervalHours: Number(r.interval_hours), retentionDays: r.retention_days == null ? null : Number(r.retention_days), autoDelete: !!r.auto_delete });

export async function getTaskSettings(task: string): Promise<TaskSettings | null> {
  await ensureSettings();
  const r = await one('SELECT * FROM maintenance_settings WHERE task = ?', [task]);
  return r ? toSettings(r) : null;
}

export async function allSettings(): Promise<Record<string, TaskSettings>> {
  await ensureSettings();
  const out: Record<string, TaskSettings> = {};
  for (const r of await q('SELECT * FROM maintenance_settings')) out[(r as any).task] = toSettings(r);
  return out;
}

const toLog = (r: any): LogRow => ({
  id: Number(r.id), task: r.task, trigger: r.trigger, userId: r.user_id ?? null, userName: r.user_name ?? null, dryRun: !!r.dry_run, status: r.status,
  rowsRemoved: Number(r.rows_removed), bytesFreed: Number(r.bytes_freed), durationMs: Number(r.duration_ms), details: r.details ?? {}, error: r.error ?? null,
  startedAt: Number(r.started_at), finishedAt: Number(r.finished_at),
});

async function writeLog(task: string, trigger: 'auto' | 'manual', userId: number | null, dryRun: boolean, status: LogRow['status'], res: Partial<TaskResult>, error: string | null, startedAt: number): Promise<LogRow> {
  const finished = Date.now();
  const rows = await q(`INSERT INTO maintenance_log(task, trigger, user_id, dry_run, status, rows_removed, bytes_freed, duration_ms, details, error, started_at, finished_at)
    VALUES (?,?,?,?,?,?,?,?,?::jsonb,?,?,?) RETURNING *`,
    [task, trigger, userId, dryRun, status, res.rows ?? 0, res.bytes ?? 0, Math.max(0, finished - startedAt), JSON.stringify(res.details ?? {}), error, startedAt, finished]);
  return toLog(rows[0]);
}

/** Why a real (non dry-run) run must not start right now, or null. */
export async function busyReason(): Promise<string | null> {
  const flags = busyNow();
  if (flags.length) return `${flags.join(', ')} is running`;
  const arch = await one("SELECT 1 FROM mail_archives WHERE status IN ('running','verifying') LIMIT 1");
  if (arch) return 'a mail archive is running';
  const imp = await one("SELECT 1 FROM archive_imports WHERE status = 'running' LIMIT 1");
  if (imp) return 'an archive import is running';
  const mig = await one("SELECT 1 FROM storage_migrations WHERE status IN ('planning','copying','verifying','switching') LIMIT 1");
  if (mig) return 'a storage migration is running';
  return null;
}

export interface RunOptions { trigger: 'auto' | 'manual'; userId?: number | null; dryRun?: boolean; opts?: Record<string, any>; now?: number }

/** Run one task now. Always writes a log row (ok / failed / skipped). Never throws for a task failure. */
export async function runTask(id: string, o: RunOptions): Promise<LogRow> {
  const def = taskById(id);
  if (!def) throw new Error(`unknown maintenance task: ${id}`);
  const settings = (await getTaskSettings(id))!;
  const started = Date.now();
  const userId = o.userId ?? null;
  // the weekly orphan-file run only reports unless the admin ticked "delete automatically"
  const dryRun = !!o.dryRun || (def.id === 'orphan_files' && o.trigger === 'auto' && !settings.autoDelete);
  if (def.manualOnly && o.trigger === 'auto') return writeLog(id, o.trigger, userId, dryRun, 'skipped', { details: { reason: 'manual only' } }, null, started);

  let release: (() => Promise<void>) | null = null;
  if (!dryRun) {                                    // a preview only reads: it may run any time
    const why = await busyReason();
    if (why) return writeLog(id, o.trigger, userId, dryRun, 'skipped', { details: { reason: why } }, why, started);
    const client = await pool.connect();
    const got = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0]?.ok;
    if (!got) {
      client.release();
      const why2 = 'another maintenance task is running';
      return writeLog(id, o.trigger, userId, dryRun, 'skipped', { details: { reason: why2 } }, why2, started);
    }
    release = async () => { try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } finally { client.release(); } };
  }
  try {
    const ctx: TaskCtx = { now: o.now ?? Date.now(), dryRun, retentionDays: settings.retentionDays, autoDelete: settings.autoDelete, trigger: o.trigger, pauseMs, opts: o.opts ?? {} };
    const res = await def.exec(ctx);
    const log = await writeLog(id, o.trigger, userId, dryRun, 'ok', res, null, started);
    if (!dryRun) await resolveFailureAlert(id);
    return log;
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 500);
    const log = await writeLog(id, o.trigger, userId, dryRun, 'failed', {}, msg, started);
    if (!dryRun) await maybeAlert(def, msg);
    return log;
  } finally {
    if (release) await release();
  }
}

async function adminIds(): Promise<number[]> {
  return (await q<{ id: number }>("SELECT id FROM users WHERE role = 'admin'")).map((r) => r.id);
}

/** T8.9 alert once the last two real runs of a task both failed. */
async function maybeAlert(def: TaskDef, error: string): Promise<void> {
  const last = await q<{ status: string }>(`SELECT status FROM maintenance_log WHERE task = ? AND dry_run = false AND status <> 'skipped' ORDER BY id DESC LIMIT 2`, [def.id]);
  if (last.length < 2 || !last.every((l) => l.status === 'failed')) return;
  for (const a of await adminIds()) {
    await raiseAlert(a, 'maintenance.failed', { type: 'maintenance', id: def.id, link: '/settings/storage' },
      `Database cleanup "${def.name}" keeps failing`, `The last two runs failed: ${error}. See Settings → Storage → Database maintenance.`).catch(() => {});
  }
}

async function resolveFailureAlert(task: string): Promise<void> {
  await resolveAlerts('maintenance.failed', { type: 'maintenance', id: task }).catch(() => {});
}

// ─── scheduling ────────────────────────────────────────────────────────────────

async function pendingJob(task: string) {
  return one<{ id: number; run_at: number }>(`SELECT id, run_at FROM jobs WHERE kind = 'maintenance.run' AND status IN ('pending','running') AND payload->>'task' = ? ORDER BY id LIMIT 1`, [task]);
}

export async function nextRunAt(task: string): Promise<number | null> {
  const j = await pendingJob(task);
  return j ? Number(j.run_at) : null;
}

async function scheduleTask(def: TaskDef, s: TaskSettings, from: number): Promise<void> {
  if (def.manualOnly || !s.enabled || s.intervalHours <= 0) return;
  if (await pendingJob(def.id)) return;
  const last = await one<{ t: number }>(`SELECT MAX(started_at) AS t FROM maintenance_log WHERE task = ? AND trigger = 'auto' AND dry_run = false`, [def.id]);
  let at = (last?.t ? Number(last.t) + s.intervalHours * HOUR : from + 5 * 60_000);
  if (at < from + 30_000) at = from + 30_000;
  await enqueueJob(null, 'maintenance.run', at, { task: def.id });
}

registerJob('maintenance.run', async (job) => {
  const task = String(job.payload?.task ?? '');
  const def = taskById(task);
  if (!def) return;
  const s = await getTaskSettings(task);
  if (!s || !s.enabled || def.manualOnly) return;                 // switched off: the chain ends; enabling it starts a new one
  let retryIn: number | null = null;
  try {
    const log = await runTask(task, { trigger: 'auto' });
    if (log.status === 'skipped') retryIn = 30 * 60_000;           // busy: try again in half an hour
  } finally {
    // next run, whatever happened. The job being run is still "running" here, so schedule explicitly.
    const fresh = (await getTaskSettings(task))!;
    if (fresh.enabled && fresh.intervalHours > 0) {
      await enqueueJob(null, 'maintenance.run', Date.now() + (retryIn ?? fresh.intervalHours * HOUR), { task });
    }
  }
});

/** Seed settings, retire the old fixed-interval jobs, and make sure every enabled task has exactly one pending job. Safe on every boot. */
export async function ensureMaintenanceJobs(now = Date.now()): Promise<void> {
  await ensureSettings();
  await run(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE kind = 'audit.prune' AND status = 'pending'`, [now]);
  const settings = await allSettings();
  for (const def of TASKS) {
    const s = settings[def.id];
    // a job that was running when the server stopped is picked up again by the runner; only add when none is waiting
    if (s) await scheduleTask(def, s, now);
  }
}

export interface SettingsPatch { enabled?: boolean; intervalHours?: number; retentionDays?: number | null; autoDelete?: boolean }

/** Validate + save a task's settings and reschedule it. Throws Error(message) for bad input. */
export async function updateTaskSettings(id: string, patch: SettingsPatch, now = Date.now()): Promise<TaskSettings> {
  const def = taskById(id);
  if (!def) throw new Error('unknown task');
  const cur = (await getTaskSettings(id))!;
  const next: TaskSettings = { ...cur };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled && !def.manualOnly;
  if (patch.intervalHours !== undefined) {
    if (def.manualOnly) throw new Error('this task only runs when you press its button');
    const h = Math.floor(Number(patch.intervalHours));
    if (!(h >= 1 && h <= 24 * 366)) throw new Error('interval must be between 1 hour and 366 days');
    next.intervalHours = h;
  }
  if (patch.retentionDays !== undefined) {
    if (def.defaultRetentionDays == null) throw new Error('this task has no retention setting');
    const d = Math.floor(Number(patch.retentionDays));
    if (!(d >= 1 && d <= 36500)) throw new Error('retention must be between 1 and 36500 days');
    next.retentionDays = d;
  }
  if (patch.autoDelete !== undefined) {
    if (def.id !== 'orphan_files') throw new Error('only orphan files has an automatic-delete option');
    next.autoDelete = !!patch.autoDelete;
  }
  await run('UPDATE maintenance_settings SET enabled = ?, interval_hours = ?, retention_days = ?, auto_delete = ? WHERE task = ?',
    [next.enabled, next.intervalHours, next.retentionDays, next.autoDelete, id]);
  // reschedule: drop the waiting job, queue a new one from the last run + the new interval
  await run(`UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE kind = 'maintenance.run' AND status = 'pending' AND payload->>'task' = ?`, [now, id]);
  await scheduleTask(def, next, now);
  return next;
}

// ─── reading ───────────────────────────────────────────────────────────────────

export interface LogFilter { task?: string; trigger?: string; status?: string; from?: number; to?: number; limit?: number; offset?: number; dryRun?: boolean }

export async function queryLog(f: LogFilter): Promise<{ items: LogRow[]; total: number }> {
  const where: string[] = []; const params: unknown[] = [];
  if (f.task) { where.push('l.task = ?'); params.push(f.task); }
  if (f.trigger === 'auto' || f.trigger === 'manual') { where.push('l.trigger = ?'); params.push(f.trigger); }
  if (f.status === 'ok' || f.status === 'failed' || f.status === 'skipped') { where.push('l.status = ?'); params.push(f.status); }
  if (f.from != null) { where.push('l.started_at >= ?'); params.push(f.from); }
  if (f.to != null) { where.push('l.started_at <= ?'); params.push(f.to); }
  if (f.dryRun != null) { where.push('l.dry_run = ?'); params.push(f.dryRun); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await one<{ c: string }>(`SELECT COUNT(*) AS c FROM maintenance_log l ${w}`, params))?.c ?? 0);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 5000);
  const rows = await q(`SELECT l.*, u.name AS user_name FROM maintenance_log l LEFT JOIN users u ON u.id = l.user_id ${w} ORDER BY l.id DESC LIMIT ${limit} OFFSET ${Math.max(f.offset ?? 0, 0)}`, params);
  return { items: rows.map(toLog), total };
}

export async function lastRuns(): Promise<Record<string, LogRow>> {
  const rows = await q(`SELECT DISTINCT ON (l.task) l.*, u.name AS user_name FROM maintenance_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.dry_run = false AND l.status <> 'skipped' ORDER BY l.task, l.id DESC`);
  return Object.fromEntries(rows.map((r) => [(r as any).task, toLog(r)]));
}

export function logCsv(items: LogRow[]): string {
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['time', 'task', 'trigger', 'by', 'dry_run', 'status', 'rows_removed', 'bytes_freed', 'duration_ms', 'error'];
  const lines = items.map((l) => [new Date(l.startedAt).toISOString(), l.task, l.trigger, l.userName ?? '', l.dryRun, l.status, l.rowsRemoved, l.bytesFreed, l.durationMs, l.error ?? ''].map(esc).join(','));
  return [head.join(','), ...lines].join('\n') + '\n';
}

export async function databaseOverview() {
  const { tableStats } = await import('./tasks.ts');
  const size = Number((await one<{ s: string }>('SELECT pg_database_size(current_database()) AS s'))?.s ?? 0);
  const stats = await tableStats();
  return { sizeBytes: size, tables: stats.slice(0, 10), fullVacuumOffered: stats.filter((t) => t.deadPct > 30 && t.dead >= 50).map((t) => t.name) };
}

export async function runSafeCleanups(userId: number | null): Promise<LogRow[]> {
  const out: LogRow[] = [];
  for (const def of TASKS) if (def.safe && !def.manualOnly) out.push(await runTask(def.id, { trigger: 'manual', userId }));
  return out;
}
