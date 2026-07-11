import { q, one, run, bumpState } from '../db.ts';
import { getBlob, putBlob } from '../s3.ts';
import { sha256 } from '../crypto.ts';
import { smtpTransport } from './send.ts';
import { setKeywords } from './store.ts';
import { deleteMessageRow } from './ingest.ts';
import { enqueueOp, syncManager, type AccountRow } from '../imap/sync.ts';

const TICK_MS = 30_000;

interface SchedRow {
  id: number; account_id: number; message_id: string | null; s3_key: string;
  envelope_from: string; envelope_to: string; send_at: number;
  tracking_token: string | null; reply_to_email_id: string | null;
}

let broadcastChange: () => void = () => {};
export function onScheduledSend(fn: () => void): void { broadcastChange = fn; }

async function deliverOne(row: SchedRow): Promise<void> {
  const acct = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND enabled = true', [row.account_id]);
  if (!acct) {
    // account gone/disabled: drop the schedule so it doesn't retry forever
    await run('DELETE FROM scheduled_sends WHERE id = ?', [row.id]);
    return;
  }
  const raw = await getBlob(row.s3_key);
  const envelopeTo = JSON.parse(row.envelope_to) as string[];

  await (await smtpTransport(acct)).sendMail({ envelope: { from: row.envelope_from, to: envelopeTo }, raw });

  // remove the message from the Scheduled folder (local row + IMAP expunge)
  if (row.message_id) {
    const scheduled = await one<{ id: number; account_id: number; mailbox_id: number; uid: number }>(`
      SELECT m.id, m.account_id, m.mailbox_id, m.uid FROM messages m
      JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE m.message_id = ? AND mb.role = 'scheduled'
    `, [row.message_id]);
    if (scheduled) {
      if (scheduled.uid > 0) await enqueueOp(scheduled.account_id, 'expunge', { mailboxId: scheduled.mailbox_id, uid: scheduled.uid });
      await deleteMessageRow(scheduled.id);
    }
  }

  // copy to Sent
  if (acct.sent_copy) {
    const key = `outbound/${acct.id}/${sha256(raw)}.eml`;
    await putBlob(key, raw);
    await enqueueOp(acct.id, 'append', { s3Key: key, targetRole: 'sent', flags: ['\\Seen'] });
  }

  if (row.reply_to_email_id) {
    try { await setKeywords(acct.user_id, row.reply_to_email_id, { $answered: true }); } catch { /* original gone */ }
  }

  await run('DELETE FROM scheduled_sends WHERE id = ?', [row.id]);
  syncManager.kick(acct.id);
}

/** Deliver every scheduled send whose time has passed. Exported for the scheduler loop and tests. */
export async function processDueSends(now = Date.now()): Promise<number> {
  const due = await q<SchedRow>('SELECT * FROM scheduled_sends WHERE send_at <= ? ORDER BY send_at', [now]);
  if (due.length === 0) return 0;
  let sent = 0;
  for (const row of due) {
    try {
      await deliverOne(row);
      sent++;
      console.log(`[scheduler] delivered scheduled send #${row.id}`);
    } catch (err: any) {
      // leave the row in place; retry next tick (SMTP flaky, S3 hiccup, etc.)
      console.error(`[scheduler] send #${row.id} failed, will retry: ${err?.message ?? err}`);
    }
  }
  if (sent > 0) { await bumpState(); broadcastChange(); }
  return sent;
}

export function startScheduler(): void {
  setInterval(() => { void processDueSends(); }, TICK_MS);
  // also run shortly after boot to catch anything due while the server was down
  setTimeout(() => { void processDueSends(); }, 5_000);
}

export async function pendingScheduledCount(): Promise<number> {
  const row = await one<{ c: number }>('SELECT COUNT(*) AS c FROM scheduled_sends');
  return row?.c ?? 0;
}
