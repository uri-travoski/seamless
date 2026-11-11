/** Alerts for conditions the Health page shows red (T2 F-21). Each fires at most once per 6 h per subject. */
import { q, getSetting, setSetting } from '../db.ts';
import { emitEvent, emitToAdmins } from '../events/emit.ts';
import { syncManager } from '../imap/sync.ts';
import { backupHealth, storageProbe } from './status.ts';

const SUPPRESS_MS = 6 * 3_600_000;
const AUTH_ERR = /invalid_grant|unauthori[sz]ed|authenticationfailed|invalid credentials|auth.*fail|token/i;

/** True the first time in SUPPRESS_MS; records the emit time. */
export async function shouldAlert(condition: string, subject: string | number, now: number): Promise<boolean> {
  const key = `alert:${condition}:${subject}`;
  const last = Number(await getSetting(key)) || 0;
  if (last && now - last < SUPPRESS_MS) return false;
  await setSetting(key, String(now));
  return true;
}

export async function runHealthAlerts(now = Date.now()): Promise<void> {
  // OAuth mailboxes whose sign-in no longer works (the refresh token was revoked or expired)
  const oauth = await q<{ id: number; user_id: number; email: string }>(`SELECT id, user_id, email FROM accounts WHERE enabled = true AND health_ignored = false AND kind IN ('gmail','microsoft')`);
  for (const a of oauth) {
    const st = syncManager.status(a.id);
    if (st.state === 'error' && st.failures >= 2 && AUTH_ERR.test(st.lastError) && await shouldAlert('oauth.expiring', a.id, now)) {
      await emitEvent(a.user_id, 'oauth.expiring', { type: 'account', id: a.id }, { accountId: a.id, email: a.email });
    }
  }

  const b = await backupHealth(now);
  if (b.enabled && b.status === 'red' && await shouldAlert('backup.failed', 'instance', now)) {
    await emitToAdmins('backup.failed', null, { error: b.note });
  }

  const p = await storageProbe(now);
  if (!p.ok && await shouldAlert('storage.unreachable', 'mail', now)) {
    await emitToAdmins('storage.unreachable', null, { error: p.error });
  }
}

let timer: NodeJS.Timeout | null = null;
export function startHealthAlerts(): void {
  if (timer) return;
  const tick = () => { runHealthAlerts().catch((err) => console.error('[health] alert check failed:', err?.message ?? err)); };
  setTimeout(tick, 90_000);
  timer = setInterval(tick, 10 * 60_000);
  timer.unref?.();
}
