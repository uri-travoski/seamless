/**
 * Snooze (T2 F-18). A snoozed thread keeps its messages in the Inbox but is hidden from it
 * (store.ts) until `snoozed_until`; a `snooze.wake` job brings it back as unread, at the top.
 */
import { q, one, run, bumpState } from '../db.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { emitEvent } from '../events/emit.ts';
import { getUserSetting } from '../classify/settings.ts';
import { broadcast } from '../ws.ts';

async function cancelWakeJobs(userId: number, threadId: string): Promise<void> {
  await run(
    `UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE user_id = ? AND kind = 'snooze.wake' AND status = 'pending' AND payload->>'threadId' = ?`,
    [Date.now(), userId, threadId]);
}

/** Snooze the inbox messages of the thread `emailId` belongs to. Returns how many messages were snoozed. */
export async function snoozeThread(userId: number, emailId: string, until: number): Promise<number> {
  if (!Number.isFinite(until) || until <= Date.now()) throw new Error('Pick a time in the future');
  const msg = await one<{ thread_id: string }>('SELECT thread_id FROM messages WHERE id = ? AND user_id = ?', [Number(String(emailId).replace(/^m/, '')) || 0, userId]);
  if (!msg) throw new Error('not found');
  const n = await run(
    `UPDATE messages SET snoozed_until = ? WHERE user_id = ? AND thread_id = ?
       AND mailbox_id IN (SELECT id FROM mailboxes WHERE role = 'inbox')`, [until, userId, msg.thread_id]);
  if (n === 0) throw new Error('Only mail in the Inbox can be snoozed');
  await cancelWakeJobs(userId, msg.thread_id);
  await enqueueJob(userId, 'snooze.wake', until, { threadId: msg.thread_id });
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
  return n;
}

/** Clear the snooze. With `wake`, the thread returns unread and first in the list, with a notification. */
export async function unsnoozeThread(userId: number, threadId: string, opts: { wake: boolean }): Promise<boolean> {
  const rows = await q<{ id: number; subject: string }>(
    `SELECT id, subject FROM messages WHERE user_id = ? AND thread_id = ? AND snoozed_until IS NOT NULL ORDER BY date DESC`, [userId, threadId]);
  if (rows.length === 0) return false;   // idempotent: already woken or never snoozed
  if (opts.wake) {
    await run(`UPDATE messages SET snoozed_until = NULL, unread = true, sort_date = ? WHERE user_id = ? AND thread_id = ? AND snoozed_until IS NOT NULL`, [Date.now(), userId, threadId]);
  } else {
    await run(`UPDATE messages SET snoozed_until = NULL WHERE user_id = ? AND thread_id = ? AND snoozed_until IS NOT NULL`, [userId, threadId]);
  }
  await cancelWakeJobs(userId, threadId);
  if (opts.wake) {
    await emitEvent(userId, 'snooze.woke', { type: 'message', id: rows[0].id },
      { messageId: rows[0].id, subject: rows[0].subject, title: 'Back in your Inbox' });
  }
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
  return true;
}

/** Called for live inbox mail: someone replied to a snoozed thread → bring it back now. */
export async function wakeOnReply(userId: number, rowId: number): Promise<boolean> {
  if ((await getUserSetting(userId, 'snooze_wake_on_reply')) === 'false') return false;
  const msg = await one<{ thread_id: string }>('SELECT thread_id FROM messages WHERE id = ? AND user_id = ?', [rowId, userId]);
  if (!msg) return false;
  const snoozed = await one(`SELECT 1 FROM messages WHERE user_id = ? AND thread_id = ? AND snoozed_until > ?`, [userId, msg.thread_id, Date.now()]);
  if (!snoozed) return false;
  return unsnoozeThread(userId, msg.thread_id, { wake: true });
}

registerJob('snooze.wake', async (job) => {
  await unsnoozeThread(job.user_id!, String(job.payload.threadId), { wake: true });
});
