import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ComposePayload } from '@seamless/shared';
import { roleFor, canSendRole, Forbidden } from '../auth/access.ts';
import { q, one, run, insertId } from '../db.ts';
import { randomToken, sha256 } from '../crypto.ts';
import { config } from '../config.ts';
import { putBlob } from '../s3.ts';
import { ingestLocal } from './localbox.ts';
import { enqueueOp, syncManager, type AccountRow } from '../imap/sync.ts';
import { setKeywords } from './store.ts';
import { createPendingFollowup } from './followups.ts';
import { logoAttachments } from '../business/logo.ts';
import { transportForAccount, sendWithFallback } from '../transport/registry.ts';
import { resolveSendIdentity, effectivePayload, type SendIdentity } from '../business/sending.ts';
import { markLeadReplies } from '../leads/leads.ts';

const uploadDir = path.join(config.dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

export interface UploadMeta { id: string; filename: string; contentType: string; size: number }

export function saveUpload(id: string, filename: string, contentType: string, data: Buffer): UploadMeta {
  fs.writeFileSync(path.join(uploadDir, id), data);
  const meta: UploadMeta = { id, filename, contentType, size: data.length };
  fs.writeFileSync(path.join(uploadDir, `${id}.json`), JSON.stringify(meta));
  return meta;
}

function loadUpload(id: string): { meta: UploadMeta; data: Buffer } | null {
  const safe = id.replace(/[^a-f0-9]/g, '');
  const metaPath = path.join(uploadDir, `${safe}.json`);
  if (!fs.existsSync(metaPath)) return null;
  return {
    meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')),
    data: fs.readFileSync(path.join(uploadDir, safe)),
  };
}

function removeUpload(id: string): void {
  const safe = id.replace(/[^a-f0-9]/g, '');
  for (const f of [safe, `${safe}.json`]) {
    try { fs.unlinkSync(path.join(uploadDir, f)); } catch { /* gone */ }
  }
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function insertTrackingPixel(html: string, token: string): string {
  const pixel = `<img src="${config.publicUrl}/t/${token}.gif" width="1" height="1" alt="" style="display:none;max-height:1px;max-width:1px;">`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${pixel}</body>`);
  return html + pixel;
}

async function getAccount(userId: number, accountId: number): Promise<AccountRow> {
  const acct = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
  if (!acct) throw new Error('Unknown account');
  return acct;
}

/**
 * Who a send is performed as. The owner acts as themself. A responder/manager on a shared mailbox acts as the
 * mailbox owner (identity, transport, Sent copy all live with the owner); a viewer gets Forbidden (403).
 */
export async function actingUser(userId: number, accountId: number): Promise<number> {
  const acct = await one<{ user_id: number }>('SELECT user_id FROM accounts WHERE id = ?', [accountId]);
  if (!acct) throw new Error('Unknown account');
  if (acct.user_id === userId) return userId;
  const role = await roleFor(userId, accountId);
  if (!role) throw new Error('Unknown account');
  if (!canSendRole(role)) throw new Forbidden('viewers cannot send from a shared mailbox');
  return acct.user_id;
}

export { smtpTransport } from '../transport/outbound/smtp.ts';

interface BuildOpts { ident?: SendIdentity | null; draft?: boolean; date?: Date; messageId?: string; trackingToken?: string | null }

/**
 * Should this message carry a tracking pixel at all? Never when every recipient is one of
 * your own mailboxes, and never when any recipient's domain is on your no-track list.
 */
export async function trackingAllowed(userId: number, payload: ComposePayload): Promise<boolean> {
  if (!payload.track) return false;
  const rcpts = [...payload.to, ...payload.cc, ...payload.bcc].map((a) => a.email.trim().toLowerCase()).filter(Boolean);
  if (rcpts.length === 0) return false;
  const own = new Set<string>();
  for (const a of await q<{ email: string; aliases: string }>('SELECT email, aliases FROM accounts WHERE user_id = ?', [userId])) {
    own.add(a.email.toLowerCase());
    for (const al of JSON.parse(a.aliases) as string[]) own.add(al.toLowerCase());
  }
  if (rcpts.every((r) => own.has(r))) return false;
  const settings = await one<{ settings_json: string }>('SELECT settings_json FROM users WHERE id = ?', [userId]);
  let noTrack: string[] = [];
  try { noTrack = (JSON.parse(settings?.settings_json ?? '{}').noTrackDomains ?? []).map((d: string) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean); } catch { /* none */ }
  if (rcpts.some((r) => noTrack.includes(r.split('@')[1] ?? ''))) return false;
  return true;
}

async function recordTrackedSend(userId: number, token: string, subject: string, sentAt: number, opts: { groupToken?: string; recipient?: string } = {}): Promise<void> {
  await run(`INSERT INTO tracked_sends(token, user_id, group_token, recipient, subject, sent_at) VALUES (?,?,?,?,?,?)
             ON CONFLICT (token) DO NOTHING`, [token, userId, opts.groupToken ?? null, opts.recipient ?? null, subject, sentAt]);
}

export async function buildRaw(payload: ComposePayload, acct: AccountRow, extraFlags: BuildOpts): Promise<{ raw: Buffer; trackingToken: string | null }> {
  // the compose editor shows the signature logo through our logo URL; the mail carries it as a CID
  let html = (payload.html || '<p></p>').replace(/(["'])(?:https?:\/\/[^"'\s]+)?\/api\/businesses\/(\d+)\/logo\1/g, '$1cid:logo-$2$1');
  let trackingToken: string | null = null;
  if (extraFlags.trackingToken !== undefined) {
    trackingToken = extraFlags.trackingToken;
    if (trackingToken) html = insertTrackingPixel(html, trackingToken);
  } else if (payload.track && !extraFlags.draft) {
    trackingToken = randomToken(16);
    html = insertTrackingPixel(html, trackingToken);
  }

  const attachments = payload.attachmentIds
    .map(loadUpload)
    .filter((u): u is NonNullable<typeof u> => !!u)
    .map((u): Record<string, unknown> => ({ filename: u.meta.filename, contentType: u.meta.contentType, content: u.data }));
  attachments.push(...await logoAttachments(acct.user_id, html));

  let references: string | undefined;
  if (payload.inReplyTo) {
    references = payload.inReplyTo;
    if (payload.replyToEmailId) {
      const row = await one<{ references_ids: string }>(
        'SELECT references_ids FROM messages WHERE id = ? AND user_id = ?',
        [Number(payload.replyToEmailId.replace(/^m/, '')) || 0, acct.user_id]);
      if (row) {
        const prev = JSON.parse(row.references_ids) as string[];
        references = [...prev, payload.inReplyTo].join(' ');
      }
    }
  }

  const composer = new MailComposer({
    from: { name: extraFlags.ident?.name || acct.name || acct.email, address: payload.fromEmail },
    replyTo: extraFlags.ident?.replyTo || undefined,
    to: payload.to.map((a) => ({ name: a.name, address: a.email })),
    cc: payload.cc.map((a) => ({ name: a.name, address: a.email })),
    bcc: payload.bcc.map((a) => ({ name: a.name, address: a.email })),
    subject: payload.subject,
    html,
    text: htmlToPlain(html),
    inReplyTo: payload.inReplyTo,
    references,
    attachments,
    date: extraFlags.date,
    messageId: extraFlags.messageId,
    // drafts remember the compose toolbar's tracking toggle
    headers: extraFlags.draft ? { 'X-Seamless-Track': payload.track ? '1' : '0' } : undefined,
  });
  const raw = await new Promise<Buffer>((resolve, reject) =>
    composer.compile().build((err, message) => (err ? reject(err) : resolve(message))),
  );
  return { raw, trackingToken };
}

export async function sendEmail(userId: number, original: ComposePayload): Promise<{ trackingToken: string | null }> {
  userId = await actingUser(userId, original.accountId);
  const acct = await getAccount(userId, original.accountId);
  const ident = await resolveSendIdentity(userId, original);
  const payload = effectivePayload(original, ident);
  const track = await trackingAllowed(userId, payload);
  const envelopeTo = [...payload.to, ...payload.cc, ...payload.bcc].map((a) => a.email);
  const transport = await transportForAccount(userId, acct, ident?.transportId);
  const ctx = { subject: payload.subject, accountId: acct.id };
  const now = Date.now();
  let raw: Buffer;
  let trackingToken: string | null = null;
  // a follow-up reminder needs to find the Sent copy again, so give the message a Message-ID we know
  const followMsgId = payload.followupDays && payload.followupDays > 0 ? `<fu-${randomToken(12)}@${new URL(config.publicUrl).hostname}>` : undefined;

  if (track && payload.perRecipientTracking && envelopeTo.length > 1) {
    // one copy per recipient, each with its own pixel and Message-ID; headers stay the same
    // so everyone still sees the full To/Cc. The Sent copy carries the group token.
    trackingToken = randomToken(16);
    await recordTrackedSend(userId, trackingToken, payload.subject, now);
    const host = new URL(config.publicUrl).hostname;
    for (const rcpt of envelopeTo) {
      const t = randomToken(16);
      const copy = await buildRaw(payload, acct, { ident, trackingToken: t, messageId: `<${randomToken(12)}@${host}>` });
      await recordTrackedSend(userId, t, payload.subject, now, { groupToken: trackingToken, recipient: rcpt });
      await sendWithFallback(userId, transport, copy.raw, { from: payload.fromEmail, to: [rcpt] }, ctx);
    }
    raw = (await buildRaw(payload, acct, { ident, trackingToken, messageId: followMsgId })).raw;
  } else {
    const built = await buildRaw(payload, acct, { ident, trackingToken: track ? randomToken(16) : null, messageId: followMsgId });
    raw = built.raw;
    trackingToken = built.trackingToken;
    if (trackingToken) await recordTrackedSend(userId, trackingToken, payload.subject, now);
    await sendWithFallback(userId, transport, raw, { from: payload.fromEmail, to: envelopeTo }, ctx);
  }

  // copy to the account's Sent mailbox via IMAP APPEND
  if (acct.sent_copy) {
    if (acct.inbound_kind && acct.inbound_kind !== 'imap') {
      await ingestLocal(acct.id, 'sent', raw); // POP3 / push: no IMAP server, keep the Sent copy locally
    } else {
      const key = `outbound/${acct.id}/${sha256(raw)}.eml`;
      await putBlob(key, raw);
      await enqueueOp(acct.id, 'append', { s3Key: key, targetRole: 'sent', flags: ['\\Seen'] });
    }
  }

  await markLeadReplies(userId, envelopeTo, Date.now()).catch((err) => console.error('[leads] reply stamp failed:', err?.message ?? err));   // F-38 response-time metric
  if (followMsgId) {
    await createPendingFollowup(userId, followMsgId, now + payload.followupDays! * 86_400_000, { subject: payload.subject, to: envelopeTo });
  }
  if (payload.replyToEmailId) await setKeywords(userId, payload.replyToEmailId, { $answered: true });
  if (payload.draftId) await destroyDraft(userId, payload.draftId);
  for (const id of payload.attachmentIds) removeUpload(id);
  syncManager.kick(acct.id);
  return { trackingToken };
}

export async function saveDraft(userId: number, original: ComposePayload): Promise<void> {
  userId = await actingUser(userId, original.accountId);
  const acct = await getAccount(userId, original.accountId);
  const ident = await resolveSendIdentity(userId, original);
  const payload: ComposePayload = ident ? { ...original, fromEmail: ident.email } : original;
  const { raw } = await buildRaw(payload, acct, { draft: true, ident });
  if (acct.inbound_kind && acct.inbound_kind !== 'imap') {
    await ingestLocal(acct.id, 'drafts', raw);
  } else {
    const key = `outbound/${acct.id}/${sha256(raw)}.eml`;
    await putBlob(key, raw);
    await enqueueOp(acct.id, 'append', { s3Key: key, targetRole: 'drafts', flags: ['\\Draft', '\\Seen'] });
  }
  if (payload.draftId) await destroyDraft(userId, payload.draftId);
  syncManager.kick(acct.id);
}

/**
 * Queue a message for later delivery. The built .eml (with a future Date header and, if
 * requested, its tracking pixel) is stored in S3 and APPENDed to the Scheduled folder so it
 * shows in the unified Scheduled view. A scheduled_sends row drives the actual SMTP send later.
 */
export async function scheduleEmail(userId: number, original: ComposePayload, sendAt: number): Promise<{ id: number; sendAt: number }> {
  if (!Number.isFinite(sendAt) || sendAt <= Date.now()) throw new Error('Scheduled time must be in the future');
  userId = await actingUser(userId, original.accountId);
  const acct = await getAccount(userId, original.accountId);
  const ident = await resolveSendIdentity(userId, original);
  const payload = effectivePayload(original, ident);
  const messageId = `<sched-${randomToken(10)}@${new URL(config.publicUrl).hostname}>`;
  const track = await trackingAllowed(userId, payload);
  const { raw, trackingToken } = await buildRaw(payload, acct, { ident, date: new Date(sendAt), messageId, trackingToken: track ? randomToken(16) : null });
  if (trackingToken) await recordTrackedSend(userId, trackingToken, payload.subject, sendAt);

  const key = `scheduled/${acct.id}/${sha256(raw)}.eml`;
  await putBlob(key, raw);
  await enqueueOp(acct.id, 'append', { s3Key: key, targetRole: 'scheduled', flags: ['\\Seen'] });

  const envelopeTo = [...payload.to, ...payload.cc, ...payload.bcc].map((a) => a.email);
  const id = await insertId(`
    INSERT INTO scheduled_sends(account_id, message_id, s3_key, envelope_from, envelope_to, send_at, tracking_token, reply_to_email_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `, [acct.id, messageId, key, payload.fromEmail, JSON.stringify(envelopeTo), sendAt, trackingToken, payload.replyToEmailId ?? null, Date.now()]);

  if (payload.draftId) await destroyDraft(userId, payload.draftId);
  for (const id2 of payload.attachmentIds) removeUpload(id2);
  syncManager.kick(acct.id);
  return { id, sendAt };
}

/** Cancel a pending scheduled send identified by its Message-ID (called when the user deletes it). */
export async function cancelScheduleByMessageId(messageId: string | null): Promise<boolean> {
  if (!messageId) return false;
  const changes = await run('DELETE FROM scheduled_sends WHERE message_id = ?', [messageId]);
  return changes > 0;
}

/** Drafts are expunged outright when sent or superseded (not moved to Trash). */
async function destroyDraft(userId: number, draftEmailId: string): Promise<void> {
  const rowId = Number(draftEmailId.replace(/^m/, '')) || 0;
  const row = await one<{ account_id: number; mailbox_id: number; uid: number }>(
    'SELECT account_id, mailbox_id, uid FROM messages WHERE id = ? AND user_id = ?', [rowId, userId]);
  if (!row) return;
  if (row.uid > 0) await enqueueOp(row.account_id, 'expunge', { mailboxId: row.mailbox_id, uid: row.uid });
  await run('DELETE FROM messages WHERE id = ?', [rowId]);
}
