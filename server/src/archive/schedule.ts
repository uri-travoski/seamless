/** Archive old mail (T8.5): the optional monthly rule — "archive anything older than N years". One rule per user. */
import { q, one, run } from '../db.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { getTarget } from '../storage/targets.ts';
import { audit } from '../audit/log.ts';
import { ArchiveError, scopeAccounts, type ArchiveOptions } from './select.ts';
import { planArchive } from './run.ts';

const EVERY_MS = 60 * 60_000;   // look for due rules hourly
const MONTH_MS = 30 * 86_400_000;

export interface ArchiveSchedule {
  enabled: boolean; olderThanDays: number; scope: string; mode: 'copy' | 'move'; targetId: number | null;
  options: ArchiveOptions; nextDueAt: number | null; lastRunAt: number | null; lastArchiveId: number | null;
}

const toView = (r: any): ArchiveSchedule => ({
  enabled: !!r.enabled, olderThanDays: r.older_than_days, scope: r.scope, mode: r.mode, targetId: r.target_id, options: r.options ?? {},
  nextDueAt: r.next_due_at == null ? null : Number(r.next_due_at), lastRunAt: r.last_run_at == null ? null : Number(r.last_run_at),
  lastArchiveId: r.last_archive_id ?? null,
});

export async function getSchedule(userId: number): Promise<ArchiveSchedule> {
  const r = await one<any>('SELECT * FROM archive_schedules WHERE user_id = ?', [userId]);
  return r ? toView(r) : { enabled: false, olderThanDays: 1095, scope: 'all', mode: 'copy', targetId: null, options: {}, nextDueAt: null, lastRunAt: null, lastArchiveId: null };
}

export async function saveSchedule(userId: number, b: any, now = Date.now()): Promise<ArchiveSchedule> {
  const cur = await getSchedule(userId);
  const days = b.olderThanDays != null ? Math.round(Number(b.olderThanDays)) : cur.olderThanDays;
  if (!Number.isFinite(days) || days < 1 || days > 365 * 100) throw new ArchiveError(400, 'olderThanDays must be at least 1');
  const mode = b.mode === 'move' ? 'move' : b.mode === 'copy' ? 'copy' : cur.mode;
  const scope = String(b.scope ?? cur.scope);
  await scopeAccounts(userId, scope);                // validates it
  const enabled = b.enabled != null ? !!b.enabled : cur.enabled;
  const targetId = b.targetId === null ? null : b.targetId != null ? Number(b.targetId) : cur.targetId;
  if (enabled) {
    const t = targetId ? await getTarget(targetId) : undefined;
    if (!t || t.role !== 'backup') throw new ArchiveError(400, 'pick a saved backup storage target');
  }
  const o = { ...cur.options, ...(b.options ?? {}) };
  const options: ArchiveOptions = { includeStarred: !!o.includeStarred, includeVip: !!o.includeVip, includeSpamBin: !!o.includeSpamBin, alsoDeleteFromServer: mode === 'move' && !!o.alsoDeleteFromServer };
  const next = enabled ? (cur.enabled && cur.nextDueAt ? cur.nextDueAt : now + MONTH_MS) : null;
  await run(
    `INSERT INTO archive_schedules(user_id, enabled, older_than_days, scope, mode, target_id, options, next_due_at)
     VALUES (?,?,?,?,?,?,?::jsonb,?)
     ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, older_than_days = EXCLUDED.older_than_days, scope = EXCLUDED.scope,
       mode = EXCLUDED.mode, target_id = EXCLUDED.target_id, options = EXCLUDED.options, next_due_at = EXCLUDED.next_due_at`,
    [userId, enabled, days, scope, mode, targetId, JSON.stringify(options), next]);
  await audit(null, 'archive.schedule', { type: 'user', id: userId }, { enabled, olderThanDays: days, mode, scope }, { userId });
  return getSchedule(userId);
}

/** Plan an archive for every rule that is due. A rule whose target or mailbox has vanished is switched off (the owner is told via a failed archive notification on the next manual run). */
export async function runDueSchedules(now = Date.now()): Promise<number[]> {
  const due = await q<any>('SELECT * FROM archive_schedules WHERE enabled AND next_due_at IS NOT NULL AND next_due_at <= ? ORDER BY user_id', [now]);
  const made: number[] = [];
  for (const r of due) {
    const s = toView(r);
    // claim first so two ticks can never plan the same month twice
    const claimed = await run('UPDATE archive_schedules SET next_due_at = ?, last_run_at = ? WHERE user_id = ? AND next_due_at = ?', [now + MONTH_MS, now, r.user_id, r.next_due_at]);
    if (!claimed) continue;
    try {
      const month = new Date(now).toISOString().slice(0, 7);
      const a = await planArchive(r.user_id, {
        name: `Monthly archive ${month}`, scope: s.scope, mode: s.mode, targetId: s.targetId ?? undefined, options: s.options, olderThanDays: s.olderThanDays,
      }, now);
      await run('UPDATE archive_schedules SET last_archive_id = ? WHERE user_id = ?', [a.id, r.user_id]);
      made.push(a.id);
    } catch (err: any) {
      if (!(err instanceof ArchiveError)) throw err;
      await run('UPDATE archive_schedules SET enabled = false, next_due_at = NULL WHERE user_id = ?', [r.user_id]);
      const { emitEvent } = await import('../events/emit.ts');
      await emitEvent(r.user_id, 'archive.failed', null, { name: 'Monthly archive', error: `${err.message} The monthly rule was switched off.` });
    }
  }
  return made;
}

registerJob('archive.schedule', async () => {
  try { await runDueSchedules(); }
  finally { await enqueueJob(null, 'archive.schedule', Date.now() + EVERY_MS, {}); }
});

/** Exactly one pending `archive.schedule` job; safe to call on every boot. */
export async function ensureArchiveScheduleJob(now = Date.now()): Promise<void> {
  const pending = await one(`SELECT 1 FROM jobs WHERE kind = 'archive.schedule' AND status IN ('pending','running') LIMIT 1`);
  if (!pending) await enqueueJob(null, 'archive.schedule', now + 120_000, {});
}
