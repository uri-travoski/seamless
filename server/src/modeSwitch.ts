/** Switching an instance between Live and Viewing mode (T8.7). */
import { one, run, bumpState } from './db.ts';
import { currentMode, modeLocked, setStoredMode, type AppMode } from './mode.ts';
import { syncManager } from './imap/sync.ts';
import { broadcast } from './ws.ts';

export interface StaleQueues { scheduledSends: number; ops: number; undoSends: number }

/** Mail that was queued before and has not gone out: a restored backup brings these along. */
export async function staleQueues(): Promise<StaleQueues> {
  const n = async (sql: string) => Number((await one<{ c: string }>(sql))?.c ?? 0);
  return {
    scheduledSends: await n('SELECT count(*) AS c FROM scheduled_sends'),
    ops: await n('SELECT count(*) AS c FROM op_queue'),
    undoSends: await n("SELECT count(*) AS c FROM jobs WHERE kind = 'send.release' AND status = 'pending'"),
  };
}

export async function describeMode() {
  return { mode: currentMode(), locked: modeLocked(), source: modeLocked() ? 'server' as const : 'setting' as const, stale: await staleQueues() };
}

export class ModeError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

/** Apply a switch. Going Live needs the word LIVE and decides what happens to old queued mail (default: discard). */
export async function switchMode(to: AppMode, opts: { confirm?: string; stale?: 'discard' | 'keep' } = {}): Promise<{ mode: AppMode; discarded: StaleQueues | null }> {
  if (to !== 'live' && to !== 'viewing') throw new ModeError(400, 'mode must be live or viewing');
  if (modeLocked()) throw new ModeError(409, 'Set by the server configuration', 'mode_locked');
  if (to === currentMode()) return { mode: to, discarded: null };
  let discarded: StaleQueues | null = null;
  if (to === 'live') {
    if (opts.confirm !== 'LIVE') throw new ModeError(400, 'Type LIVE to confirm', 'confirm_required');
    if ((opts.stale ?? 'discard') === 'discard') {
      discarded = await staleQueues();
      await run('DELETE FROM scheduled_sends');
      await run('DELETE FROM op_queue');
      await run("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE kind = 'send.release' AND status = 'pending'", [Date.now()]);
    }
  }
  await setStoredMode(to);
  if (to === 'viewing') syncManager.stopAll();
  else void syncManager.startAll().catch((err) => console.error('[mode] start failed:', err?.message ?? err));
  await bumpState();
  broadcast({ type: 'stateChange' });
  return { mode: to, discarded };
}
