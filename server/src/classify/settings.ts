import { q, one, run, insertId } from '../db.ts';

/** Per-user settings (seeded from the spreadsheet's Settings tab). */
export const SETTING_DEFAULTS: Record<string, string> = {
  dry_run: 'true',              // retention only logs until the user flips it live
  trash_days: '30',             // recoverable-trash grace before purge
  ai_conf_threshold: '0.7',
  undo_send_seconds: '10',      // T2 F-17: hold a sent message this long so it can be undone
  snooze_wake_on_reply: 'true', // T2 F-18
  log_retention_days: '90',     // auto-clear processing logs
};

export async function getUserSetting(userId: number, key: string): Promise<string> {
  const row = await one<{ value: string }>('SELECT value FROM user_settings WHERE user_id = ? AND key = ?', [userId, key]);
  return row?.value ?? SETTING_DEFAULTS[key] ?? '';
}

export async function setUserSetting(userId: number, key: string, value: string): Promise<void> {
  await run(`
    INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `, [userId, key, value]);
}

export async function allUserSettings(userId: number): Promise<Record<string, string>> {
  const rows = await q<{ key: string; value: string }>('SELECT key, value FROM user_settings WHERE user_id = ?', [userId]);
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function plog(userId: number | null, kind: string, message: string, opts: {
  emailId?: number; level?: 'info' | 'warn' | 'error'; meta?: unknown;
} = {}): Promise<void> {
  await insertId('INSERT INTO processing_logs(user_id, email_id, kind, level, message, meta, created_at) VALUES (?,?,?,?,?,?,?)',
    [userId, opts.emailId ?? null, kind, opts.level ?? 'info', message, JSON.stringify(opts.meta ?? {}), Date.now()]);
}

/** Prune old logs per user setting; called from the retention tick. */
export async function pruneLogs(): Promise<void> {
  const users = await q<{ id: number }>('SELECT id FROM users');
  for (const u of users) {
    const days = Number(await getUserSetting(u.id, 'log_retention_days')) || 90;
    await run('DELETE FROM processing_logs WHERE user_id = ? AND created_at < ?', [u.id, Date.now() - days * 86_400_000]);
  }
}
