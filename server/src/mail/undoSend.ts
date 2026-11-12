/**
 * Undo send (T2 F-17). The message is held as a job holding the whole ComposePayload; at release it
 * goes through the normal sendEmail(), so tracking, the Sent copy and events behave as before.
 * Uploaded attachments stay on disk until sendEmail removes them, so undo can hand them back.
 */
import type { ComposePayload } from '@seamless/shared';
import { one, q } from '../db.ts';
import { getUserSetting } from '../classify/settings.ts';
import { registerJob, enqueueJob, cancelJob } from '../jobs/runner.ts';
import { sendEmail, actingUser } from './send.ts';
import { emitEvent } from '../events/emit.ts';
import { broadcast } from '../ws.ts';

export const UNDO_CHOICES = ['0', '5', '10', '20', '30'];

export type QueueResult =
  | { queued: false; sent: { trackingToken: string | null } }
  | { queued: true; jobId: number; releaseAt: number };

export async function queueSend(userId: number, payload: ComposePayload): Promise<QueueResult> {
  const secs = Number(await getUserSetting(userId, 'undo_send_seconds') || '10');
  if (!secs || payload.pgpPassphrase) return { queued: false, sent: await sendEmail(userId, payload) };

  // validate now so a bad message fails at once instead of 10 seconds later
  await actingUser(userId, payload.accountId); // owner, or responder/manager on a shared mailbox (viewer → 403)
  if (![...payload.to, ...payload.cc, ...payload.bcc].some((a) => a.email?.trim())) throw new Error('Add at least one recipient');

  const releaseAt = Date.now() + secs * 1000;
  const jobId = await enqueueJob(userId, 'send.release', releaseAt, { payload, subject: payload.subject });
  return { queued: true, jobId, releaseAt };
}

registerJob('send.release', async (job) => {
  const payload = job.payload.payload as ComposePayload;
  try {
    await sendEmail(job.user_id!, payload);
  } catch (err: any) {
    // a half-sent message must not be retried automatically: report and stop
    await emitEvent(job.user_id!, 'send.failed', null, { subject: payload?.subject ?? '', accountId: payload?.accountId ?? null, error: err?.message ?? 'send failed' }).catch(() => {});
  }
  broadcast({ type: 'stateChange' }, job.user_id!);
});

/** Cancel a held message and hand its payload back; null when it is too late (or not yours). */
export async function undoSend(userId: number, jobId: number): Promise<ComposePayload | null> {
  const row = await one<{ payload: any }>(`SELECT payload FROM jobs WHERE id = ? AND user_id = ? AND kind = 'send.release'`, [jobId, userId]);
  if (!row) return null;
  if (!(await cancelJob(userId, jobId))) return null;
  return row.payload.payload as ComposePayload;
}

export async function pendingSends(userId: number): Promise<{ id: number; releaseAt: number; subject: string }[]> {
  const rows = await q<{ id: string; run_at: string; payload: any }>(
    `SELECT id, run_at, payload FROM jobs WHERE user_id = ? AND kind = 'send.release' AND status = 'pending' ORDER BY run_at`, [userId]);
  return rows.map((r) => ({ id: Number(r.id), releaseAt: Number(r.run_at), subject: String(r.payload.subject ?? '') }));
}
