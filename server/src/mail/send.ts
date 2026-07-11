import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ComposePayload } from '@seamless/shared';
import { one, run, insertId } from '../db.ts';
import { decrypt, randomToken, sha256 } from '../crypto.ts';
import { config } from '../config.ts';
import { putBlob } from '../s3.ts';
import { enqueueOp, syncManager, type AccountRow } from '../imap/sync.ts';
import { setKeywords } from './store.ts';

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

export async function smtpTransport(acct: AccountRow) {
  const isOauth = acct.kind === 'gmail' || acct.kind === 'microsoft';
  const { freshAccessToken } = await import('../oauth.ts');
  return nodemailer.createTransport({
    host: acct.smtp_host,
    port: acct.smtp_port,
    secure: !!acct.smtp_secure,
    auth: isOauth
      ? { type: 'OAuth2' as const, user: acct.smtp_user, accessToken: await freshAccessToken(acct.id) }
      : { user: acct.smtp_user, pass: decrypt(acct.smtp_pass_enc) },
    tls: { rejectUnauthorized: acct.smtp_host !== 'localhost' && acct.smtp_host !== '127.0.0.1' },
  });
}

interface BuildOpts { draft?: boolean; date?: Date; messageId?: string }

async function buildRaw(payload: ComposePayload, acct: AccountRow, extraFlags: BuildOpts): Promise<{ raw: Buffer; trackingToken: string | null }> {
  let html = payload.html || '<p></p>';
  let trackingToken: string | null = null;
  if (payload.track && !extraFlags.draft) {
    trackingToken = randomToken(16);
    html = insertTrackingPixel(html, trackingToken);
  }

  const attachments = payload.attachmentIds
    .map(loadUpload)
    .filter((u): u is NonNullable<typeof u> => !!u)
    .map((u) => ({ filename: u.meta.filename, contentType: u.meta.contentType, content: u.data }));

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
    from: { name: acct.name || acct.email, address: payload.fromEmail },
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
  });
  const raw = await new Promise<Buffer>((resolve, reject) =>
    composer.compile().build((err, message) => (err ? reject(err) : resolve(message))),
  );
  return { raw, trackingToken };
}

export async function sendEmail(userId: number, payload: ComposePayload): Promise<{ trackingToken: string | null }> {
  const acct = await getAccount(userId, payload.accountId);
  const { raw, trackingToken } = await buildRaw(payload, acct, {});

  const transport = await smtpTransport(acct);
  const envelopeTo = [...payload.to, ...payload.cc, ...payload.bcc].map((a) => a.email);
  await transport.sendMail({ envelope: { from: payload.fromEmail, to: envelopeTo }, raw });

  // copy to the account's Sent mailbox via IMAP APPEND
  if (acct.sent_copy) {
    const key = `outbound/${acct.id}/${sha256(raw)}.eml`;
    await putBlob(key, raw);
    await enqueueOp(acct.id, 'append', { s3Key: key, targetRole: 'sent', flags: ['\\Seen'] });
  }

  if (payload.replyToEmailId) await setKeywords(userId, payload.replyToEmailId, { $answered: true });
  if (payload.draftId) await destroyDraft(userId, payload.draftId);
  for (const id of payload.attachmentIds) removeUpload(id);
  syncManager.kick(acct.id);
  return { trackingToken };
}

export async function saveDraft(userId: number, payload: ComposePayload): Promise<void> {
  const acct = await getAccount(userId, payload.accountId);
  const { raw } = await buildRaw(payload, acct, { draft: true });
  const key = `outbound/${acct.id}/${sha256(raw)}.eml`;
  await putBlob(key, raw);
  await enqueueOp(acct.id, 'append', { s3Key: key, targetRole: 'drafts', flags: ['\\Draft', '\\Seen'] });
  if (payload.draftId) await destroyDraft(userId, payload.draftId);
  syncManager.kick(acct.id);
}

/**
 * Queue a message for later delivery. The built .eml (with a future Date header and, if
 * requested, its tracking pixel) is stored in S3 and APPENDed to the Scheduled folder so it
 * shows in the unified Scheduled view. A scheduled_sends row drives the actual SMTP send later.
 */
export async function scheduleEmail(userId: number, payload: ComposePayload, sendAt: number): Promise<{ id: number; sendAt: number }> {
  if (!Number.isFinite(sendAt) || sendAt <= Date.now()) throw new Error('Scheduled time must be in the future');
  const acct = await getAccount(userId, payload.accountId);
  const messageId = `<sched-${randomToken(10)}@${new URL(config.publicUrl).hostname}>`;
  const { raw, trackingToken } = await buildRaw(payload, acct, { date: new Date(sendAt), messageId });

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
