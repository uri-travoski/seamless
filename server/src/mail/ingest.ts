import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import type { ApiAddress, ApiAttachmentMeta } from '@seamless/shared';
import { one, run, insertId, bumpState } from '../db.ts';
import { sha256 } from '../crypto.ts';
import { putBlob } from '../s3.ts';
import { config } from '../config.ts';
import { assignThreadId } from './threading.ts';
import { resolvePendingFollowup } from './followups.ts';
import { assessAndStore } from './risk.ts';
import { recordBounce } from './dsn.ts';
import { evaluateFilters, loadFilters, type FilterableMessage } from './filters.ts';

export function addressList(obj: AddressObject | AddressObject[] | undefined): ApiAddress[] {
  if (!obj) return [];
  const arr = Array.isArray(obj) ? obj : [obj];
  const out: ApiAddress[] = [];
  for (const a of arr) {
    for (const v of a.value) {
      if (v.address) out.push({ name: v.name ?? '', email: v.address });
      else if (v.group) for (const g of v.group) if (g.address) out.push({ name: g.name ?? '', email: g.address });
    }
  }
  return out;
}

export function textSnippet(parsed: ParsedMail): string {
  let text = parsed.text ?? '';
  if (!text && parsed.html) text = String(parsed.html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function attachmentMeta(parsed: ParsedMail): ApiAttachmentMeta[] {
  return parsed.attachments.map((att, i) => ({
    partId: String(i),
    filename: att.filename ?? `attachment-${i}`,
    contentType: att.contentType,
    size: att.size,
    cid: att.cid ?? null,
    inline: att.contentDisposition === 'inline' && !!att.cid,
  }));
}

export function extractTrackingToken(raw: string): string | null {
  // undo quoted-printable soft line breaks so a wrapped pixel URL still matches
  const unfolded = raw.replace(/=\r?\n/g, '');
  const re = new RegExp(config.publicUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/t/([a-f0-9]{32})\\.gif');
  const m = unfolded.match(re);
  return m ? m[1] : null;
}

export interface IngestArgs {
  accountId: number;
  mailboxId: number;
  uid: number;
  raw: Buffer;
  flags: Set<string>;
  internalDate: Date | null;
  deliveredTo?: string | null; // envelope recipient when the transport knows it (push inbound)
  isLive: boolean; // true for freshly arrived mail (filters + AI apply), false for backfill
}

export interface IngestResult {
  rowId: number;
  userId: number;
  parsed: ParsedMail;
  filterActions: { type: string; value?: string }[];
  isInboxLive: boolean;
}

export async function ingestMessage(args: IngestArgs): Promise<IngestResult | null> {
  const exists = await one('SELECT id FROM messages WHERE mailbox_id = ? AND uid = ?', [args.mailboxId, args.uid]);
  if (exists) return null;

  const mailbox = await one<{ role: string | null }>('SELECT role FROM mailboxes WHERE id = ?', [args.mailboxId]);
  const account = await one<{ email: string; user_id: number }>('SELECT email, user_id FROM accounts WHERE id = ?', [args.accountId]);
  if (!mailbox || !account) return null;
  const userId = account.user_id;

  const hash = sha256(args.raw);
  const s3Key = `msg/${args.accountId}/${hash}.eml`;
  await putBlob(s3Key, args.raw);

  const parsed = await simpleParser(args.raw);
  const from = addressList(parsed.from)[0] ?? { name: '', email: '' };
  const to = addressList(parsed.to);
  const cc = addressList(parsed.cc);
  const replyTo = addressList(parsed.replyTo);
  const references = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [];
  const messageId = parsed.messageId ?? null;
  const threadId = await assignThreadId(userId, { messageId, inReplyTo: parsed.inReplyTo ?? null, references });
  const headerText = (name: string): string | null => {
    const v = parsed.headers.get(name) as unknown;
    if (typeof v === 'string') return v;
    return (v as { text?: string } | undefined)?.text ?? null; // mailparser returns address-like headers as objects
  };
  const deliveredTo = args.deliveredTo ?? headerText('delivered-to') ?? headerText('x-original-to');
  const atts = attachmentMeta(parsed);
  const bodyText = parsed.text ?? textSnippet(parsed);
  const date = (parsed.date ?? args.internalDate ?? new Date()).getTime();
  const trackingToken = extractTrackingToken(args.raw.toString('utf8'));

  // decisive raw headers for the classification cascade (DESIGN.md §3a)
  const keyHeaders: Record<string, string> = {};
  for (const h of ['list-id', 'list-unsubscribe', 'precedence', 'auto-submitted', 'x-auto-response-suppress']) {
    const v = parsed.headers.get(h);
    if (v !== undefined) keyHeaders[h] = typeof v === 'string' ? v : JSON.stringify(v);
  }

  const rowId = await insertId(`
    INSERT INTO messages (
      user_id, account_id, mailbox_id, uid, message_id, in_reply_to, references_ids, thread_id,
      subject, snippet, from_name, from_addr, to_json, cc_json, reply_to_json, delivered_to,
      date, size, unread, flagged, answered, draft, has_attachments, attachments_json,
      s3_key, tracking_token, headers_json, created_at, sort_date
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (mailbox_id, uid) DO NOTHING
  `, [
    userId, args.accountId, args.mailboxId, args.uid, messageId, parsed.inReplyTo ?? null,
    JSON.stringify(references), threadId,
    parsed.subject ?? '', textSnippet(parsed), from.name, from.email,
    JSON.stringify(to), JSON.stringify(cc), JSON.stringify(replyTo),
    typeof deliveredTo === 'string' ? deliveredTo.replace(/^.*</, '').replace(/>.*$/, '').trim() : null,
    date, args.raw.length,
    !args.flags.has('\\Seen'),
    args.flags.has('\\Flagged'),
    args.flags.has('\\Answered'),
    args.flags.has('\\Draft') || mailbox.role === 'drafts',
    atts.some((a) => !a.inline),
    JSON.stringify(atts), s3Key, trackingToken, JSON.stringify(keyHeaders), Date.now(), date,
  ]);
  if (!rowId) return null; // concurrent sync already inserted this uid

  await run('INSERT INTO message_fts(message_id, subject, body, addrs) VALUES (?,?,?,?)', [
    rowId,
    parsed.subject ?? '',
    bodyText.slice(0, 200_000),
    `${from.name} ${from.email} ` + [...to, ...cc].map((a) => `${a.name} ${a.email}`).join(' '),
  ]);

  const isInboxLive = args.isLive && mailbox.role === 'inbox';
  let filterActions: IngestResult['filterActions'] = [];
  if (isInboxLive) {
    const fmsg: FilterableMessage = {
      from: `${from.name} <${from.email}>`,
      to: to.map((a) => `${a.name} <${a.email}>`).join(', '),
      cc: cc.map((a) => `${a.name} <${a.email}>`).join(', '),
      subject: parsed.subject ?? '',
      body: bodyText,
      hasAttachment: atts.some((a) => !a.inline),
      accountEmail: account.email,
    };
    filterActions = evaluateFilters(fmsg, await loadFilters(userId));
    await applyLocalFilterActions(rowId, filterActions);
  }

  await assessAndStore(userId, rowId, parsed, mailbox.role).catch((err) => console.error('[risk] assess failed:', err?.message ?? err));  // never breaks ingest
  if (isInboxLive) await recordBounce(userId, parsed).catch((err) => console.error('[dsn] bounce handling failed:', err?.message ?? err));
  if (mailbox.role === 'sent') await resolvePendingFollowup(userId, rowId, messageId, threadId).catch(() => {});
  await bumpState();
  return { rowId, userId, parsed, filterActions, isInboxLive };
}

/** Apply label/flag filter actions: local DB write + IMAP flag propagation. Moves are handled by the caller. */
export async function applyLocalFilterActions(rowId: number, actions: { type: string; value?: string }[]): Promise<void> {
  const row = await one<{ account_id: number; mailbox_id: number; uid: number }>(
    'SELECT account_id, mailbox_id, uid FROM messages WHERE id = ?', [rowId]);
  if (!row) return;
  const imapAdd: string[] = [];
  for (const a of actions) {
    if (a.type === 'label' && a.value) {
      await run('INSERT INTO message_labels(message_id, label_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [rowId, Number(a.value)]);
    } else if (a.type === 'markRead') {
      await run('UPDATE messages SET unread = false WHERE id = ?', [rowId]);
      imapAdd.push('\\Seen');
    } else if (a.type === 'star') {
      await run('UPDATE messages SET flagged = true WHERE id = ?', [rowId]);
      imapAdd.push('\\Flagged');
    }
  }
  if (imapAdd.length > 0 && row.uid > 0) {
    await enqueueImapFlagOp(row.account_id, { mailboxId: row.mailbox_id, uid: row.uid, add: imapAdd, remove: [] });
  }
}

// injected by imap/sync.ts to avoid a circular import at module load
let enqueueImapFlagOp: (accountId: number, payload: unknown) => Promise<void> = async () => {};
export function setFlagOpEnqueuer(fn: (accountId: number, payload: unknown) => Promise<void>): void {
  enqueueImapFlagOp = fn;
}

export async function deleteMessageRow(rowId: number): Promise<void> {
  await run("DELETE FROM email_vectors WHERE message_id = ? AND source = 'local'", [rowId]); // FK dropped in migration 4
  await run('DELETE FROM messages WHERE id = ?', [rowId]); // message_fts + labels cascade
}
