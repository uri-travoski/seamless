import { simpleParser, type ParsedMail } from 'mailparser';
import sanitizeHtml from 'sanitize-html';
import type { ApiEmailBody, TrackingInfo } from '@seamless/shared';
import { q, one } from '../db.ts';
import { getBlob } from '../s3.ts';
import { config } from '../config.ts';
import { getMsgRow, getNote } from './store.ts';
import { attachmentMeta } from './ingest.ts';
import { roleFor } from '../auth/access.ts';
import { inviteForMessage } from './invites.ts';
import { openPgpMessage, keyOffers } from './pgp.ts';

async function canReadAccount(userId: number, rowId: number): Promise<boolean> {
  const m = await one<{ account_id: number }>('SELECT account_id FROM messages WHERE id = ?', [rowId]);
  return !!m && (await roleFor(userId, m.account_id)) !== null;
}

// small LRU for parsed messages (body views + attachment downloads)
const cache = new Map<number, ParsedMail>();
/** Tests restart row ids between cases, so they must drop parsed mail. */
export function clearParsedCache(): void { cache.clear(); }
const CACHE_MAX = 40;

/** Parse a message's raw source from S3. Pass userId to enforce ownership (routes); omit for server-internal use. */
export async function getParsed(rowId: number, userId?: number): Promise<ParsedMail | null> {
  const row = await one<{ s3_key: string | null; user_id: number }>('SELECT s3_key, user_id FROM messages WHERE id = ?', [rowId]);
  if (!row?.s3_key) return null;
  if (userId !== undefined && row.user_id !== userId && !(await canReadAccount(userId, rowId))) return null;
  const hit = cache.get(rowId);
  if (hit) { cache.delete(rowId); cache.set(rowId, hit); return hit; }
  const raw = await getBlob(row.s3_key);
  const parsed = await simpleParser(raw);
  cache.set(rowId, parsed);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return parsed;
}

/** Keep a decrypted message in the in-memory LRU only (never written anywhere) so its attachments can be downloaded. */
function holdParsed(rowId: number, p: ParsedMail): void {
  cache.delete(rowId); cache.set(rowId, p);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

export function sanitizeEmailHtml(html: string, opts: {
  rowId: number;
  cids: Map<string, string>;      // cid -> partId
  allowRemote: boolean;
  trackingToken: string | null;
}): { html: string; hasBlockedRemote: boolean } {
  let hasBlockedRemote = false;
  const pixelUrl = opts.trackingToken ? `${config.publicUrl}/t/${opts.trackingToken}.gif` : null;

  const clean = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img', 'style', 'center', 'font', 'u', 's', 'span', 'html', 'body', 'head',
    ]),
    allowedAttributes: {
      '*': ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing', 'dir', 'class'],
      a: ['href', 'name', 'target', 'rel', 'style', 'class'],
      img: ['src', 'alt', 'width', 'height', 'style', 'class', 'data-md-src'],
      font: ['face', 'size', 'color'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
    transformTags: {
      a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
      img: (tag, attribs) => {
        const src = attribs.src ?? '';
        // strip our own tracking pixel so viewing your sent mail doesn't count as an open
        if (pixelUrl && src === pixelUrl) return { tagName: 'span', attribs: {} };
        if (src.startsWith('cid:')) {
          const cid = src.slice(4).replace(/[<>]/g, '');
          const partId = opts.cids.get(cid);
          if (partId !== undefined) {
            return { tagName: 'img', attribs: { ...attribs, src: `/api/blob/m${opts.rowId}/${partId}` } };
          }
          return { tagName: 'span', attribs: {} };
        }
        if ((src.startsWith('http://') || src.startsWith('https://')) && !opts.allowRemote) {
          hasBlockedRemote = true;
          const { src: _drop, ...rest } = attribs;
          return { tagName: 'img', attribs: { ...rest, 'data-md-src': src, class: 'md-blocked-img' } };
        }
        return { tagName: 'img', attribs };
      },
    },
  });
  return { html: clean, hasBlockedRemote };
}

/** Full open log (newest first) for a tracking token: count, last open, per-open ip/ua/time. */
export async function trackingFor(token: string): Promise<TrackingInfo> {
  const log = await q<{ ts: number; ip: string; ua: string }>(
    'SELECT ts, ip, ua FROM tracking_opens WHERE token = ? ORDER BY ts DESC LIMIT 200', [token]);
  const count = await one<{ c: number }>('SELECT COUNT(*) AS c FROM tracking_opens WHERE token = ?', [token]);
  return {
    token,
    opens: count?.c ?? 0,
    lastOpenAt: log[0] ? new Date(log[0].ts).toISOString() : null,
    log: log.map((l) => ({ ts: new Date(l.ts).toISOString(), ip: l.ip || '', ua: l.ua || '' })),
  };
}

/** Fresh tracking for a message id (used by the expandable open-log). */
export async function getTracking(userId: number, emailId: string): Promise<TrackingInfo | null> {
  const row = await getMsgRow(userId, emailId);
  if (!row || !row.tracking_token) return null;
  return trackingFor(row.tracking_token);
}

export async function getEmailBody(userId: number, emailId: string, allowRemote: boolean, opts: { pgpPassphrase?: string } = {}): Promise<ApiEmailBody | null> {
  const row = await getMsgRow(userId, emailId);
  if (!row) return null;
  let parsed = await getParsed(row.id);
  if (!parsed) return null;

  // T6.4 F-39: OpenPGP. Decrypt on view only; the plaintext lives in memory, is not stored and not indexed.
  let pgp: ApiEmailBody['pgp'] = null;
  let pgpKeys: ApiEmailBody['pgpKeys'];
  if (row.s3_key) {
    const opened = await openPgpMessage(userId, await getBlob(row.s3_key), parsed, opts.pgpPassphrase).catch((e) => ({ status: { encrypted: false, decrypted: false, signature: 'none' as const, error: String(e?.message ?? e) } }));
    if (opened) {
      pgp = opened.status;
      if ('parsed' in opened && opened.parsed) { parsed = opened.parsed; holdParsed(row.id, parsed); }
    }
    const offers = await keyOffers(userId, parsed);
    if (offers.length) pgpKeys = offers;
  }

  const atts = attachmentMeta(parsed);
  const cids = new Map<string, string>();
  for (const a of atts) if (a.cid) cids.set(a.cid.replace(/[<>]/g, ''), a.partId);

  let html: string | null = null;
  let hasBlockedRemote = false;
  if (parsed.html) {
    const res = sanitizeEmailHtml(String(parsed.html), {
      rowId: row.id, cids, allowRemote, trackingToken: row.tracking_token,
    });
    html = res.html;
    hasBlockedRemote = res.hasBlockedRemote;
  }

  const tracking = row.tracking_token ? await trackingFor(row.tracking_token) : null;

  return {
    id: emailId,
    html,
    text: parsed.text ?? null,
    hasBlockedRemote,
    note: await getNote(userId, emailId),
    attachments: atts.filter((a) => !a.inline),
    headers: {
      deliveredTo: row.delivered_to,
      messageId: row.message_id,
      listUnsubscribe: (parsed.headers.get('list-unsubscribe') as string | undefined) ?? null,
      seamlessTrack: parsed.headers.has('x-seamless-track') ? String(parsed.headers.get('x-seamless-track')) === '1' : null,
    },
    tracking,
    invite: await inviteForMessage(userId, row.id, row.account_id),
    pgp,
    ...(pgpKeys ? { pgpKeys } : {}),
  };
}
