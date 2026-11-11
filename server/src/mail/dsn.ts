/** Delivery status notifications / bounces (T3 F-22). RFC 3464 plus the common non-standard shapes. */
import type { ParsedMail } from 'mailparser';
import { one, q, insertId } from '../db.ts';
import { emitEvent } from '../events/emit.ts';

export interface DsnRecipient { address: string; action: string; status: string; diagnostic: string }
export interface Dsn { originalMessageId: string | null; recipients: DsnRecipient[] }

const FALLBACK_SUBJECT = /undelivered mail returned to sender|delivery status notification \((failure|delay)\)|mail delivery (failed|failure)|returned mail|undeliverable/i;

function contentTypeOf(parsed: ParsedMail): { value: string; params: Record<string, string> } {
  const ct = parsed.headers.get('content-type') as any;
  return { value: String(ct?.value ?? '').toLowerCase(), params: ct?.params ?? {} };
}

/** Unfold a header block into `name: value` pairs (first value wins, names lower-cased). */
function headerBlock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (m && !out.has(m[1].toLowerCase())) out.set(m[1].toLowerCase(), m[2].trim());
  }
  return out;
}

function cleanAddress(v: string): string {
  // "rfc822; user@host" / "<user@host>" / "LOCAL; user@host"
  const part = v.includes(';') ? v.slice(v.indexOf(';') + 1) : v;
  const m = part.match(/[^\s<>"']+@[^\s<>"']+/);
  return (m ? m[0] : part.trim()).replace(/[.,;:]+$/, '').toLowerCase();
}

function attachmentText(parsed: ParsedMail, types: RegExp): string[] {
  return parsed.attachments.filter((a) => types.test(a.contentType.toLowerCase())).map((a) => a.content.toString('utf8'));
}

function originalMessageId(parsed: ParsedMail): string | null {
  for (const t of attachmentText(parsed, /^(message\/rfc822|text\/rfc822-headers)$/)) {
    const h = headerBlock(t.split(/\r?\n\r?\n/)[0]);
    const id = h.get('message-id')?.match(/<[^>]+>/)?.[0];
    if (id) return id;
  }
  // some bounces inline the original headers in the text body
  const inline = (parsed.text ?? '').match(/^Message-ID:\s*(<[^>]+>)/im);
  if (inline) return inline[1];
  // last resort: bounces usually answer the original
  return parsed.inReplyTo?.match(/<[^>]+>/)?.[0] ?? null;
}

function standardRecipients(parsed: ParsedMail): DsnRecipient[] {
  const out: DsnRecipient[] = [];
  // mailparser folds message/delivery-status into the text body; keep the attachment path for other parsers
  const sources = [...attachmentText(parsed, /^message\/(global-)?delivery-status$/), parsed.text ?? ''];
  for (const t of sources) {
    // first block = per-message fields, the rest = one block per recipient
    const blocks = t.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
    for (const b of blocks) {
      const h = headerBlock(b);
      const who = h.get('final-recipient') ?? h.get('original-recipient');
      if (!who) continue;
      out.push({
        address: cleanAddress(who),
        action: (h.get('action') ?? '').toLowerCase().split(/\s/)[0],
        status: h.get('status') ?? '',
        diagnostic: (h.get('diagnostic-code') ?? '').replace(/^smtp\s*;\s*/i, '').trim(),
      });
    }
  }
  return out;
}

function fallbackRecipients(parsed: ParsedMail): DsnRecipient[] {
  const text = parsed.text ?? '';
  const addrs = [...new Set((text.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((a) => a.toLowerCase()))];
  const fromAddr = (parsed.from?.value[0]?.address ?? '').toLowerCase();
  const own = (parsed.to as any)?.value?.map((v: any) => String(v.address ?? '').toLowerCase()) ?? [];
  const target = addrs.find((a) => a !== fromAddr && !own.includes(a) && !/^(mailer-daemon|postmaster)@/.test(a));
  if (!target) return [];
  const status = text.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/)?.[1] ?? '5.0.0';
  const diag = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /^(\d{3}[ -]|.*(does not exist|unknown user|no such user|mailbox unavailable|rejected))/i.test(l)) ?? '';
  return [{ address: target, action: 'failed', status, diagnostic: diag.slice(0, 500) }];
}

export function parseDsn(parsed: ParsedMail): Dsn | null {
  const ct = contentTypeOf(parsed);
  const isReport = ct.value === 'multipart/report' && /delivery-status/i.test(ct.params['report-type'] ?? '');
  if (isReport) {
    const recipients = standardRecipients(parsed);
    if (recipients.length > 0) return { originalMessageId: originalMessageId(parsed), recipients };
  }
  const fromAddr = (parsed.from?.value[0]?.address ?? '').toLowerCase();
  const looksLikeDaemon = /^(mailer-daemon|postmaster)@/.test(fromAddr) || (parsed.from?.value[0]?.name ?? '').toLowerCase().includes('mail delivery');
  if (FALLBACK_SUBJECT.test(parsed.subject ?? '') && (looksLikeDaemon || isReport)) {
    const hasOriginal = parsed.attachments.some((a) => /^(message\/rfc822|text\/rfc822-headers)$/i.test(a.contentType));
    if (!hasOriginal) return null;
    const recipients = fallbackRecipients(parsed);
    if (recipients.length > 0) return { originalMessageId: originalMessageId(parsed), recipients };
  }
  return null;
}

/** Link a failed-delivery report to the user's sent message and raise one event per bounced recipient. */
export async function recordBounce(userId: number, parsed: ParsedMail): Promise<number> {
  const dsn = parseDsn(parsed);
  if (!dsn || !dsn.originalMessageId) return 0;
  const sent = await one<{ id: number; subject: string; account_id: number }>(
    `SELECT m.id, m.subject, m.account_id FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
     WHERE m.user_id = ? AND m.message_id = ? AND mb.role = 'sent' ORDER BY m.id DESC LIMIT 1`, [userId, dsn.originalMessageId]);
  if (!sent) return 0;
  let n = 0;
  for (const r of dsn.recipients) {
    if (r.action !== 'failed') continue;
    const id = await insertId(
      `INSERT INTO bounces(user_id, message_id, recipient, status, diagnostic, created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT (message_id, recipient) DO NOTHING`, [userId, sent.id, r.address, r.status, r.diagnostic, Date.now()]);
    if (!id) continue;
    n++;
    await emitEvent(userId, 'mail.bounced', { type: 'message', id: sent.id }, {
      messageId: sent.id, subject: sent.subject, recipient: r.address, status: r.status, error: r.diagnostic, accountId: sent.account_id,
    });
  }
  return n;
}

export async function bouncesFor(messageRowId: number): Promise<{ recipient: string; status: string; diagnostic: string }[]> {
  return q('SELECT recipient, status, diagnostic FROM bounces WHERE message_id = ? ORDER BY id', [messageRowId]);
}
