/**
 * Follow-up reminders (T2 F-19): "remind me if nobody replies to this by <time>".
 * A `followup.check` job runs at the due time; a reply from one of the recipients ends it quietly,
 * otherwise a `followup.due` notification is raised.
 */
import { q, one, run, insertId, bumpState } from '../db.ts';
import { enqueueJob, cancelJob, registerJob } from '../jobs/runner.ts';
import { emitEvent } from '../events/emit.ts';
import type { MsgRow } from './store.ts';   // type only: store → imap/sync → ingest → here would be a cycle
import { broadcast } from '../ws.ts';

export interface FollowupPayloadInfo { subject: string; to: string[] }

const BASE = `SELECT m.*, a.email AS account_email, a.color AS account_color, mb.role AS mailbox_role
  FROM messages m JOIN accounts a ON a.id = m.account_id JOIN mailboxes mb ON mb.id = m.mailbox_id`;

/** From the message list / menu: the message must be the user's own Sent mail. */
export async function createFollowup(userId: number, emailId: string, dueAt: number): Promise<number> {
  if (!Number.isFinite(dueAt) || dueAt <= Date.now()) throw new Error('Pick a time in the future');
  const row = await one<MsgRow>(`${BASE} WHERE m.id = ? AND m.user_id = ?`, [Number(String(emailId).replace(/^m/, '')) || 0, userId]);
  if (!row) throw new Error('not found');
  if (row.mailbox_role !== 'sent') throw new Error('Only sent messages can have a follow-up');
  // one live reminder per message: replace it
  const old = await q<{ id: number; job_id: string | null }>(`SELECT id, job_id FROM followups WHERE user_id = ? AND message_id = ? AND status IN ('waiting','due')`, [userId, row.id]);
  for (const o of old) { if (o.job_id) await cancelJob(userId, Number(o.job_id)); await run(`UPDATE followups SET status = 'cancelled' WHERE id = ?`, [o.id]); }
  const id = await insertId(`INSERT INTO followups(user_id, message_id, message_id_header, thread_id, due_at, created_at) VALUES (?,?,?,?,?,?)`,
    [userId, row.id, row.message_id, row.thread_id, dueAt, Date.now()]);
  const jobId = await enqueueJob(userId, 'followup.check', dueAt, { followupId: id });
  await run('UPDATE followups SET job_id = ? WHERE id = ?', [jobId, id]);
  await bumpState();
  return id;
}

/** From compose: the Sent copy doesn't exist yet, so remember the Message-ID and resolve it on ingest. */
export async function createPendingFollowup(userId: number, messageIdHeader: string, dueAt: number, info: FollowupPayloadInfo): Promise<number> {
  const id = await insertId(`INSERT INTO followups(user_id, message_id, message_id_header, thread_id, due_at, created_at) VALUES (?,NULL,?,NULL,?,?)`,
    [userId, messageIdHeader, dueAt, Date.now()]);
  const jobId = await enqueueJob(userId, 'followup.check', dueAt, { followupId: id, subject: info.subject, to: info.to, sentAt: Date.now() });
  await run('UPDATE followups SET job_id = ? WHERE id = ?', [jobId, id]);
  return id;
}

/** Called by ingest for every stored message: a Sent copy with a known Message-ID completes its pending follow-up. */
export async function resolvePendingFollowup(userId: number, rowId: number, messageIdHeader: string | null, threadId: string): Promise<void> {
  if (!messageIdHeader) return;
  const n = await run(`UPDATE followups SET message_id = ?, thread_id = ? WHERE user_id = ? AND message_id_header = ? AND message_id IS NULL`,
    [rowId, threadId, userId, messageIdHeader]);
  if (n > 0) await bumpState();
}

export async function cancelFollowup(userId: number, id: number): Promise<boolean> {
  const f = await one<{ job_id: string | null }>(`SELECT job_id FROM followups WHERE id = ? AND user_id = ? AND status IN ('waiting','due')`, [id, userId]);
  if (!f) return false;
  if (f.job_id) await cancelJob(userId, Number(f.job_id));
  await run(`UPDATE followups SET status = 'cancelled' WHERE id = ? AND user_id = ?`, [id, userId]);
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
  return true;
}

export async function listFollowups(userId: number, status?: string) {
  const rows = await q<any>(
    `SELECT id, message_id, status, due_at, created_at FROM followups WHERE user_id = ? ${status ? 'AND status = ?' : ''} ORDER BY due_at`,
    status ? [userId, status] : [userId]);
  return rows.map((r) => ({ id: r.id, emailId: r.message_id ? `m${r.message_id}` : null, status: r.status, dueAt: Number(r.due_at) }));
}

const lc = (s: string) => s.trim().toLowerCase();

/** Did someone we wrote to answer? */
async function hasReply(userId: number, f: { message_id: number | null; message_id_header: string | null; thread_id: string | null; created_at: number }, recipients: string[], sentAt: number): Promise<boolean> {
  if (recipients.length === 0) return false;
  const base = `FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.user_id = ? AND (mb.role IS NULL OR mb.role NOT IN ('sent','drafts','scheduled'))
      AND lower(m.from_addr) = ANY(?::text[]) AND m.date > ?`;
  if (f.thread_id) {
    return !!(await one(`SELECT 1 ${base} AND m.thread_id = ? LIMIT 1`, [userId, recipients, sentAt, f.thread_id]));
  }
  if (f.message_id_header) {
    return !!(await one(`SELECT 1 ${base} AND (m.in_reply_to = ? OR m.references_ids LIKE ?) LIMIT 1`,
      [userId, recipients, sentAt, f.message_id_header, `%${f.message_id_header}%`]));
  }
  return false;
}

async function check(userId: number, followupId: number, hint: { subject?: string; to?: string[]; sentAt?: number }): Promise<void> {
  const f = await one<any>(`SELECT * FROM followups WHERE id = ? AND user_id = ?`, [followupId, userId]);
  if (!f || f.status !== 'waiting') return;
  let subject = hint.subject ?? '';
  let recipients = (hint.to ?? []).map(lc);
  let sentAt = hint.sentAt ?? Number(f.created_at);
  let opens = 0;
  let firstName = '';
  if (f.message_id) {
    const row = await one<MsgRow>(`${BASE} WHERE m.id = ?`, [f.message_id]);
    if (row) {
      subject = row.subject; sentAt = Number(row.date);
      const addrs = [...JSON.parse(row.to_json), ...JSON.parse(row.cc_json)] as { name: string; email: string }[];
      recipients = addrs.map((a) => lc(a.email));
      firstName = addrs[0]?.name || addrs[0]?.email || '';
      const { rowToApi } = await import('./store.ts');
      const api = await rowToApi(row);
      opens = Math.max(0, api.openCount);
    }
  }
  if (await hasReply(userId, f, recipients, sentAt)) {
    await run(`UPDATE followups SET status = 'replied' WHERE id = ?`, [followupId]);
  } else {
    await run(`UPDATE followups SET status = 'due' WHERE id = ?`, [followupId]);
    const who = firstName || (hint.to?.[0] ?? '') || 'your recipient';
    await emitEvent(userId, 'followup.due', { type: 'followup', id: followupId }, {
      messageId: f.message_id, subject, opens,
      title: opens > 0 ? `Opened ${opens}× but no reply from ${who}` : `No reply from ${who}`,
    });
  }
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
}

registerJob('followup.check', async (job) => {
  await check(job.user_id!, Number(job.payload.followupId), job.payload);
});

/** Live inbox mail from a recipient settles a waiting follow-up right away (no notification). */
export async function settleOnReply(userId: number, rowId: number): Promise<void> {
  const m = await one<{ thread_id: string; from_addr: string; date: number }>('SELECT thread_id, from_addr, date FROM messages WHERE id = ? AND user_id = ?', [rowId, userId]);
  if (!m) return;
  const waiting = await q<any>(`SELECT f.id, f.job_id, s.to_json, s.cc_json, s.date FROM followups f JOIN messages s ON s.id = f.message_id
    WHERE f.user_id = ? AND f.status = 'waiting' AND f.thread_id = ?`, [userId, m.thread_id]);
  for (const f of waiting) {
    const rcpts = [...JSON.parse(f.to_json), ...JSON.parse(f.cc_json)].map((a: any) => lc(a.email));
    if (rcpts.includes(lc(m.from_addr)) && Number(m.date) > Number(f.date)) {
      if (f.job_id) await cancelJob(userId, Number(f.job_id));
      await run(`UPDATE followups SET status = 'replied' WHERE id = ?`, [f.id]);
    }
  }
}
