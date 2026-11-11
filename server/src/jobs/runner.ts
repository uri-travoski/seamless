/**
 * Generic job runner (T2). One `jobs` table, handlers registered by `kind`.
 * Used by undo-send, snooze wake-ups and follow-up checks. Safe with two processes
 * (FOR UPDATE SKIP LOCKED); a job whose worker died is picked up again once its lock expires.
 */
import type pg from 'pg';
import { pool, q, one, run, clientQuery } from '../db.ts';
import { emitEvent } from '../events/emit.ts';

export interface JobRow {
  id: number;
  user_id: number | null;
  kind: string;
  run_at: number;
  payload: any;
  status: string;
  attempts: number;
  last_error: string | null;
}

export type JobHandler = (job: JobRow) => Promise<void>;   // throw = retry

const handlers = new Map<string, JobHandler>();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 60_000;

export function registerJob(kind: string, fn: JobHandler): void {
  handlers.set(kind, fn);
}

export async function enqueueJob(
  userId: number | null, kind: string, runAt: number, payload: object, client?: pg.PoolClient,
): Promise<number> {
  const sql = `INSERT INTO jobs(user_id, kind, run_at, payload, created_at) VALUES (?,?,?,?::jsonb,?) RETURNING id`;
  const params = [userId, kind, runAt, JSON.stringify(payload), Date.now()];
  const rows = client ? await clientQuery<{ id: string }>(client, sql, params) : await q<{ id: string }>(sql, params);
  return Number(rows[0].id);
}

/** pending → cancelled. False if it is already running/done, or belongs to someone else. */
export async function cancelJob(userId: number, id: number): Promise<boolean> {
  const n = await run(
    `UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'`,
    [Date.now(), id, userId]);
  return n > 0;
}

export async function runDueJobs(now = Date.now()): Promise<number> {
  await run(`UPDATE jobs SET status = 'pending', locked_until = NULL WHERE status = 'running' AND locked_until < ?`, [now]);
  const claimed = await q<JobRow>(
    `UPDATE jobs SET status = 'running', locked_until = ?, attempts = attempts + 1
     WHERE id IN (SELECT id FROM jobs WHERE status = 'pending' AND run_at <= ?
                  ORDER BY run_at LIMIT 20 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [now + LOCK_MS, now]);

  for (const raw of claimed) {
    const job: JobRow = { ...raw, id: Number(raw.id), run_at: Number(raw.run_at) };
    const handler = handlers.get(job.kind);
    if (!handler) {
      await run(`UPDATE jobs SET status = 'failed', last_error = 'no handler', finished_at = ?, locked_until = NULL WHERE id = ?`, [now, job.id]);
      continue;
    }
    try {
      await handler(job);
      await run(`UPDATE jobs SET status = 'done', finished_at = ?, locked_until = NULL WHERE id = ? AND status = 'running'`, [Date.now(), job.id]);
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 500);
      if (job.attempts >= MAX_ATTEMPTS) {
        await run(`UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ?, locked_until = NULL WHERE id = ?`, [msg, Date.now(), job.id]);
        if (job.user_id) await emitEvent(job.user_id, 'job.failed', { type: 'job', id: job.id }, { kind: job.kind, error: msg }).catch(() => {});
      } else {
        await run(`UPDATE jobs SET status = 'pending', run_at = ?, last_error = ?, locked_until = NULL WHERE id = ?`,
          [now + 2 ** job.attempts * 10_000, msg, job.id]);
      }
    }
  }
  return claimed.length;
}

let timer: NodeJS.Timeout | null = null;
export function startJobRunner(): void {
  if (timer) return;
  timer = setInterval(() => { runDueJobs().catch((err) => console.error('[jobs] run failed:', err?.message ?? err)); }, 5000);
  timer.unref?.();
}
