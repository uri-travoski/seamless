/**
 * Snooze (T2 F-18). A snoozed thread keeps its messages in the Inbox but is hidden from it
 * (store.ts) until `snoozed_until`; a `snooze.wake` job brings it back as unread, at the top.
 */
import { q, one, run, bumpState } from '../db.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { emitEvent } from '../events/emit.ts';
import { getUserSetting } from '../classify/settings.ts';
import { broadcast } from '../ws.ts';
import { roleFor, canSendRole, Forbidden } from '../auth/access.ts';
import { accountUserIds } from './assignments.ts';
import { snoozeAllowedFor } from './team.ts';

async function cancelWakeJobs(userId: number, threadId: string): Promise<void> {
  await run(
    `UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE user_id = ? AND kind = 'snooze.wake' AND status = 'pending' AND payload->>'threadId' = ?`,
    [Date.now(), userId, threadId]);
}

/** Message row + the viewer's role on its account (null role = no access). */
async function reach(userId: number, emailId: string) {
  const msg = await one<{ thread_id: string; user_id: number; account_id: number }>('SELECT thread_id, user_id, account_id FROM messages WHERE id = ?', [Number(String(emailId).replace(/^m/, '')) || 0]);
  if (!msg) return null;
  const role = msg.user_id === userId ? 'owner' : await roleFor(userId, msg.account_id);
  return role ? { msg, role } : null;
}

/**
 * Snooze the inbox messages of the thread `emailId` belongs to. Returns how many messages were snoozed.
 * On a shared mailbox (T8.3) a responder/manager may do it when the mailbox allows it; it hides the thread for everyone.
 */
export async function snoozeThread(userId: number, emailId: string, until: number): Promise<number> {
  if (!Number.isFinite(until) || until <= Date.now()) throw new Error('Pick a time in the future');
  const r = await reach(userId, emailId);
  if (!r) throw new Error('not found');
  const { msg } = r;
  const shared = msg.user_id !== userId;
  if (shared && !(await snoozeAllowedFor(userId, msg.account_id))) {
    throw new Forbidden(canSendRole(r.role) ? 'Snoozing is off for this shared mailbox' : 'your role on this shared mailbox does not allow that');
  }
  const n = await run(
    `UPDATE messages SET snoozed_until = ?, snoozed_by = ? WHERE user_id = ? AND thread_id = ? ${shared ? 'AND account_id = ?' : ''}
       AND mailbox_id IN (SELECT id FROM mailboxes WHERE role = 'inbox')`, [until, userId, msg.user_id, msg.thread_id, ...(shared ? [msg.account_id] : [])]);
  if (n === 0) throw new Error('Only mail in the Inbox can be snoozed');
  await cancelWakeJobs(msg.user_id, msg.thread_id);
  await enqueueJob(msg.user_id, 'snooze.wake', until, { threadId: msg.thread_id });
  await tellEveryone(msg.account_id, msg.user_id);
  return n;
}

async function tellEveryone(accountId: number, ownerId: number): Promise<void> {
  await bumpState();
  const ids = new Set<number>([ownerId, ...(await accountUserIds(accountId))]);
  for (const id of ids) broadcast({ type: 'stateChange' }, id);
}

/**
 * Clear the snooze. With `wake`, the thread returns unread and first in the list, with a notification (to the owner).
 * `userId` is the mailbox owner for the wake job; a shared user passes their own id and must be allowed to snooze.
 */
export async function unsnoozeThread(userId: number, threadId: string, opts: { wake: boolean }): Promise<boolean> {
  let ownerId = userId;
  let rows = await q<{ id: number; subject: string; account_id: number }>(
    `SELECT id, subject, account_id FROM messages WHERE user_id = ? AND thread_id = ? AND snoozed_until IS NOT NULL ORDER BY date DESC`, [userId, threadId]);
  if (rows.length === 0) {
    // a responder / manager removing a team snooze: find it through the shares
    const shared = await q<{ id: number; subject: string; account_id: number; user_id: number }>(
      `SELECT m.id, m.subject, m.account_id, m.user_id FROM messages m JOIN mailbox_shares s ON s.account_id = m.account_id AND s.user_id = ?
        WHERE m.thread_id = ? AND m.snoozed_until IS NOT NULL ORDER BY m.date DESC`, [userId, threadId]);
    if (shared.length === 0) return false;   // idempotent: already woken or never snoozed
    if (!(await snoozeAllowedFor(userId, shared[0].account_id))) throw new Forbidden('Snoozing is off for this shared mailbox');
    ownerId = shared[0].user_id;
    rows = shared.filter((r) => r.account_id === shared[0].account_id);
  }
  const accountIds = [...new Set(rows.map((r) => r.account_id))];
  if (opts.wake) {
    await run(`UPDATE messages SET snoozed_until = NULL, snoozed_by = NULL, unread = true, sort_date = ? WHERE user_id = ? AND thread_id = ? AND account_id = ANY(?::int[]) AND snoozed_until IS NOT NULL`, [Date.now(), ownerId, threadId, accountIds]);
  } else {
    await run(`UPDATE messages SET snoozed_until = NULL, snoozed_by = NULL WHERE user_id = ? AND thread_id = ? AND account_id = ANY(?::int[]) AND snoozed_until IS NOT NULL`, [ownerId, threadId, accountIds]);
  }
  await cancelWakeJobs(ownerId, threadId);
  if (opts.wake) {
    await emitEvent(ownerId, 'snooze.woke', { type: 'message', id: rows[0].id },
      { messageId: rows[0].id, subject: rows[0].subject, title: 'Back in your Inbox' });
  }
  for (const a of accountIds) await tellEveryone(a, ownerId);
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
