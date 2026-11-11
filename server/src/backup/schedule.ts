import { q, one, getSetting, setSetting } from '../db.ts';
import { config } from '../config.ts';
import { plog } from '../classify/settings.ts';
import { notifyUser } from '../push.ts';
import { emitToAdmins } from '../events/emit.ts';
import { smtpTransport } from '../mail/send.ts';
import type { AccountRow } from '../imap/sync.ts';
import { createBackup, verifyBackup, pruneBackups, listBackups, type BackupSummary } from './engine.ts';
import type { BlobStore } from '../s3.ts';

const TICK_MS = 5 * 60_000;

export type Frequency = 'twice_daily' | 'daily' | 'every_2_days' | 'twice_weekly' | 'weekly';

/** Gap the scheduler enforces between runs. twice_weekly is every 3.5 days, which
 *  lands on two fixed slots a week rather than drifting. */
export const INTERVAL_HOURS: Record<Frequency, number> = {
  twice_daily: 12,
  daily: 24,
  every_2_days: 48,
  twice_weekly: 84,
  weekly: 168,
};

export const FREQUENCIES = Object.keys(INTERVAL_HOURS) as Frequency[];

/** Backups always live under the app's own folder, so one bucket can serve several apps
 *  without their backups mixing. A prefix typed in Settings is namespaced into it rather
 *  than replacing it: "nightly" becomes "seamless/nightly/". Derived from package.json,
 *  so renaming the app moves its folder instead of silently keeping a stale literal. */
export const APP_FOLDER = config.appFolder;

export function normalizePrefix(raw: string): string {
  let p = raw.trim().replace(/^\/+/, '');
  if (!p.endsWith('/')) p = `${p}/`;
  if (p === '/' || p === '') return APP_FOLDER;
  return p === APP_FOLDER || p.startsWith(APP_FOLDER) ? p : `${APP_FOLDER}${p}`;
}

export interface BackupConfig {
  enabled: boolean;
  frequency: Frequency;
  hour: number;            // UTC hour of the run slot
  keep: number;            // how many runs to retain in the bucket
  prefix: string;
  alertEmail: string;      // one or more addresses, comma-separated
}

/** Split the alert field into addresses. Accepts commas, semicolons, whitespace and
 *  newlines, because people paste lists in every shape — and drops anything that is not
 *  an address rather than handing nodemailer a string it will reject wholesale. */
export function alertRecipients(raw: string): string[] {
  return [...new Set(
    (raw ?? '')
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)),
  )];
}

export interface BackupStatus {
  lastAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string;
  lastKey: string;
  lastRows: number;
  lastBytes: number;
  acknowledged: boolean;   // false while a failure banner is still unread
  nextDueAt: number | null;
  running: boolean;
}

const DEFAULTS: BackupConfig = {
  enabled: false,
  frequency: 'daily',
  hour: 2,
  keep: 14,
  prefix: config.backupPrefix,   // BACKUP_PREFIX env: the only prefix a wiped box can know
  alertEmail: '',
};

export async function getBackupConfig(): Promise<BackupConfig> {
  const num = async (k: string, d: number) => {
    const v = Number(await getSetting(k));
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  const freq = (await getSetting('backup_frequency')) as Frequency | null;
  return {
    enabled: (await getSetting('backup_enabled')) === 'true',
    frequency: freq && FREQUENCIES.includes(freq) ? freq : DEFAULTS.frequency,
    hour: Math.min(23, Math.max(0, Number(await getSetting('backup_hour')) || DEFAULTS.hour)),
    keep: await num('backup_keep', DEFAULTS.keep),
    prefix: normalizePrefix((await getSetting('backup_prefix')) || DEFAULTS.prefix),
    alertEmail: (await getSetting('backup_alert_email')) ?? '',
  };
}

export async function setBackupConfig(cfg: Partial<BackupConfig>): Promise<BackupConfig> {
  if (cfg.enabled !== undefined) await setSetting('backup_enabled', String(cfg.enabled));
  if (cfg.frequency && FREQUENCIES.includes(cfg.frequency)) await setSetting('backup_frequency', cfg.frequency);
  if (cfg.hour !== undefined) await setSetting('backup_hour', String(Math.min(23, Math.max(0, cfg.hour))));
  if (cfg.keep !== undefined) await setSetting('backup_keep', String(Math.max(1, cfg.keep)));
  if (cfg.prefix) await setSetting('backup_prefix', normalizePrefix(cfg.prefix));
  // store the cleaned list, so what the UI shows back is exactly what will be mailed
  if (cfg.alertEmail !== undefined) await setSetting('backup_alert_email', alertRecipients(cfg.alertEmail).join(', '));
  return getBackupConfig();
}

let running = false;

export async function getBackupStatus(): Promise<BackupStatus> {
  const cfg = await getBackupConfig();
  const lastAt = Number(await getSetting('backup_last_at')) || null;
  const lastStatus = (await getSetting('backup_last_status')) as 'ok' | 'error' | null;
  return {
    lastAt,
    lastStatus,
    lastError: (await getSetting('backup_last_error')) ?? '',
    lastKey: (await getSetting('backup_last_key')) ?? '',
    lastRows: Number(await getSetting('backup_last_rows')) || 0,
    lastBytes: Number(await getSetting('backup_last_bytes')) || 0,
    acknowledged: (await getSetting('backup_ack')) === 'true',
    nextDueAt: cfg.enabled ? nextDueAt(lastAt, cfg, Date.now()) : null,
    running,
  };
}

/** The slot hours for a frequency: twice-daily fires at `hour` and twelve hours later. */
function slotHours(cfg: BackupConfig): number[] {
  return cfg.frequency === 'twice_daily' ? [cfg.hour % 24, (cfg.hour + 12) % 24] : [cfg.hour % 24];
}

/** Next wall-clock instant the scheduler would fire, given the last successful run.
 *  Exported for the Settings UI ("next backup in 4h") and pinned by tests. */
export function nextDueAt(lastAt: number | null, cfg: BackupConfig, now: number): number {
  const intervalMs = INTERVAL_HOURS[cfg.frequency] * 3_600_000;
  const earliest = lastAt === null ? now : lastAt + intervalMs;
  const slots = slotHours(cfg);

  // walk hour by hour from `earliest` to the first hour that is one of the slots
  const d = new Date(Math.max(earliest, now));
  d.setUTCMinutes(0, 0, 0);
  if (d.getTime() < Math.max(earliest, now)) d.setUTCHours(d.getUTCHours() + 1);
  for (let i = 0; i < 24 * 8; i++) {
    if (slots.includes(d.getUTCHours())) return d.getTime();
    d.setUTCHours(d.getUTCHours() + 1);
  }
  return earliest;
}

/** Due when we are inside a slot hour and the interval has elapsed — or when a run was
 *  missed by a wide margin (server was down through the slot), in which case catch up
 *  immediately rather than waiting a whole cycle for the slot to come round again. */
export function isDue(lastAt: number | null, cfg: BackupConfig, now: number): boolean {
  if (!cfg.enabled) return false;
  const intervalMs = INTERVAL_HOURS[cfg.frequency] * 3_600_000;
  if (lastAt === null) return true;                       // never run: take one now
  const elapsed = now - lastAt;
  if (elapsed >= intervalMs * 1.5) return true;           // missed slot: catch up
  return elapsed >= intervalMs && slotHours(cfg).includes(new Date(now).getUTCHours());
}

async function alert(subject: string, body: string, cfg: BackupConfig): Promise<void> {
  const admins = await q<{ id: number }>("SELECT id FROM users WHERE role = 'admin'");
  for (const a of admins) await notifyUser(a.id, subject, body, 'backup-alert').catch(() => {});

  const recipients = alertRecipients(cfg.alertEmail);
  if (!recipients.length) return;
  const acct = await one<AccountRow>('SELECT * FROM accounts WHERE enabled = true ORDER BY id LIMIT 1');
  if (!acct) return;
  try {
    const transport = await smtpTransport(acct);
    // one message addressed to everyone: a per-recipient loop would let the first bad
    // address swallow the alert for the rest
    await transport.sendMail({
      from: acct.email, to: recipients.join(', '),
      subject, text: `${body}\n\n-- Seamless`,
    });
  } catch (err: any) {
    // the mail path is exactly what a broken server breaks, so a failed alert must
    // never mask the failure it was trying to report — the log and banner still stand
    await plog(null, 'backup', `alert email failed: ${err?.message ?? err}`, { level: 'warn' });
  }
}

export interface RunResult { ok: boolean; key?: string; rows?: number; bytes?: number; error?: string }

/** One backup: write, verify what was written, prune old runs, then record + alert.
 *  Shared by the scheduler tick and the "Back up now" button. */
export async function runBackup(opts: { store?: BlobStore; appVersion?: string } = {}): Promise<RunResult> {
  if (running) return { ok: false, error: 'a backup is already running' };
  running = true;
  const started = Date.now();
  try {
    const cfg = await getBackupConfig();
    const manifest = await createBackup({ prefix: cfg.prefix, store: opts.store, appVersion: opts.appVersion });
    await verifyBackup(manifest.key, { store: opts.store });
    const pruned = await pruneBackups(cfg.keep, { prefix: cfg.prefix, store: opts.store });

    await setSetting('backup_last_at', String(started));
    await setSetting('backup_last_status', 'ok');
    await setSetting('backup_last_error', '');
    await setSetting('backup_last_key', manifest.key);
    await setSetting('backup_last_rows', String(manifest.rows));
    await setSetting('backup_last_bytes', String(manifest.bytes));
    await setSetting('backup_ack', 'true');

    await plog(null, 'backup', `backup ok: ${manifest.rows} rows, ${(manifest.bytes / 1024).toFixed(0)} KB -> ${manifest.key}`, {
      meta: { key: manifest.key, rows: manifest.rows, bytes: manifest.bytes, pruned, ms: Date.now() - started },
    });
    await emitToAdmins('backup.ok', { type: 'backup', id: manifest.key }, { rows: manifest.rows, bytes: manifest.bytes }).catch(() => {});
    return { ok: true, key: manifest.key, rows: manifest.rows, bytes: manifest.bytes };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    await setSetting('backup_last_at', String(started));
    await setSetting('backup_last_status', 'error');
    await setSetting('backup_last_error', message);
    await setSetting('backup_ack', 'false');
    await plog(null, 'backup', `backup FAILED: ${message}`, { level: 'error', meta: { ms: Date.now() - started } });

    const cfg = await getBackupConfig().catch(() => DEFAULTS);
    await alert('Seamless backup failed', `The scheduled backup did not complete.\n\n${message}`, cfg);
    await emitToAdmins('backup.failed', { type: 'backup', id: started }, { error: message }).catch(() => {});
    return { ok: false, error: message };
  } finally {
    running = false;
  }
}

export async function acknowledgeFailure(): Promise<void> {
  await setSetting('backup_ack', 'true');
}

export async function listBackupsForUi(): Promise<BackupSummary[]> {
  const cfg = await getBackupConfig();
  return listBackups({ prefix: cfg.prefix });
}

export function startBackupScheduler(appVersion: string): void {
  const tick = async () => {
    const cfg = await getBackupConfig();
    if (!cfg.enabled) return;
    const lastAt = Number(await getSetting('backup_last_at')) || null;
    if (!isDue(lastAt, cfg, Date.now())) return;
    await runBackup({ appVersion });
  };
  setTimeout(() => { void tick().catch((e) => console.error('[backup]', e?.message ?? e)); }, 60_000);
  setInterval(() => { void tick().catch((e) => console.error('[backup]', e?.message ?? e)); }, TICK_MS);
}
