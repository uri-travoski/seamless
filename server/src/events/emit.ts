/**
 * Event bus (T0 F-04 / AD-4).
 *
 *   domain code ──emitEvent()──► events table ──► notifier ──► notifications + web push
 *                                             ├─► webhook dispatcher (T5)
 *                                             └─► audit log view (T6)
 *
 * Pass a transaction client to write the event in the caller's transaction: the
 * notifier then runs only after COMMIT, so a rollback leaves no trace.
 */
import type pg from 'pg';
import type { EventType } from '@seamless/shared';
import { pool, q, onCommit, clientQuery } from '../db.ts';
import { notifyFromEvent, type EventRow } from './notifier.ts';

export interface EventSubject { type: string; id: string | number }

export async function emitEvent(
  userId: number,
  type: EventType,
  subject: EventSubject | null,
  payload: Record<string, unknown> = {},
  client?: pg.PoolClient,
): Promise<number> {
  const now = Date.now();
  const sql = `INSERT INTO events(user_id, type, subject_type, subject_id, payload, created_at)
               VALUES (?,?,?,?,?::jsonb,?) RETURNING id`;
  const params = [userId, type, subject?.type ?? null, subject ? String(subject.id) : null, JSON.stringify(payload), now];
  const rows = client ? await clientQuery<{ id: number }>(client, sql, params) : await q<{ id: number }>(sql, params);
  const ev: EventRow = {
    id: Number(rows[0].id), user_id: userId, type, subject_type: subject?.type ?? null,
    subject_id: subject ? String(subject.id) : null, payload, created_at: now,
  };
  const run = () => notifyFromEvent(ev).catch((err) => console.error('[events] notify failed:', err?.message ?? err));
  if (client) onCommit(client, async () => { await run(); });
  else await run();
  return ev.id;
}

/** Emit the same event to every admin (instance-level things like backups). */
export async function emitToAdmins(type: EventType, subject: EventSubject | null, payload: Record<string, unknown> = {}): Promise<void> {
  const admins = (await pool.query("SELECT id FROM users WHERE role = 'admin'")).rows as { id: number }[];
  for (const a of admins) await emitEvent(a.id, type, subject, payload);
}

/** Retention: events 180 days, notifications 365 days. */
export async function pruneEvents(now = Date.now()): Promise<{ events: number; notifications: number }> {
  const e = await pool.query('DELETE FROM events WHERE created_at < $1', [now - 180 * 86_400_000]);
  const n = await pool.query('DELETE FROM notifications WHERE created_at < $1', [now - 365 * 86_400_000]);
  return { events: e.rowCount ?? 0, notifications: n.rowCount ?? 0 };
}

export function startEventPrune(): void {
  const tick = () => { void pruneEvents().catch(() => {}); };
  setTimeout(tick, 60_000);
  setInterval(tick, 12 * 3_600_000);
}
