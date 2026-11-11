/**
 * Push inbound (F-24): a Cloudflare Email Worker POSTs each raw message, signed with a per-inbox
 * secret. Signature = sha256 HMAC over `timestamp + "." + body`.
 */
import crypto from 'node:crypto';
import { one, run } from '../../db.ts';
import { encrypt, decrypt, randomToken, sha256 } from '../../crypto.ts';
import { ingestLocal } from '../../mail/localbox.ts';
import { syncManager, type NewMailEvent } from '../../imap/sync.ts';
import { dropIfDisposed, matchAddress, clean } from '../../mail/disposable.ts';
import { simpleParser } from 'mailparser';

export const MAX_INGEST_BYTES = 30 * 1024 * 1024;
export const SKEW_MS = 5 * 60_000;

export function sign(secret: string, timestamp: string, body: Buffer): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex');
}

export function signatureValid(secret: string, timestamp: string, signature: string, body: Buffer, now = Date.now()): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SKEW_MS) return false;
  const want = Buffer.from(sign(secret, timestamp, body));
  const got = Buffer.from(signature);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export interface PushInboxRow {
  token: string; account_id: number; secret_enc: string; domains: string[]; catch_all: boolean;
  unknown_policy: string; created_at: string;
}

export const getInbox = (token: string) => one<PushInboxRow>('SELECT * FROM push_inboxes WHERE token = ?', [token]);

export async function createInbox(accountId: number, domains: string[]): Promise<{ token: string; secret: string }> {
  const token = randomToken(24);
  const secret = randomToken(32);
  await run('INSERT INTO push_inboxes(token, account_id, secret_enc, domains, catch_all, created_at) VALUES (?,?,?,?,true,?)',
    [token, accountId, encrypt(secret), domains, Date.now()]);
  return { token, secret };
}

export async function rotateSecret(token: string): Promise<string> {
  const secret = randomToken(32);
  await run('UPDATE push_inboxes SET secret_enc = ? WHERE token = ?', [encrypt(secret), token]);
  return secret;
}

export const inboxSecret = (row: PushInboxRow) => decrypt(row.secret_enc);

export type IngestOutcome = { status: 202; id: number } | { status: 200; dropped: true; reason: 'disposed' | 'unknown' } | { status: 200; id: number | null; duplicate: true } | { status: 500; error: string };

/** Store one pushed message (already authenticated). Duplicate = same Message-ID + same bytes. */
export async function ingestPush(inbox: PushInboxRow, raw: Buffer, rcpt: string | null): Promise<IngestOutcome> {
  // disposable addresses: a disposed one is dropped (and counted) before anything is stored
  const candidates = [rcpt];
  if (!rcpt) {
    const p = await simpleParser(raw.subarray(0, 65536)).catch(() => null);
    const h = (n: string) => { const v = p?.headers.get(n) as any; return typeof v === 'string' ? v : v?.text ?? null; };
    candidates.push(h('delivered-to'), h('x-original-to'), ...((Array.isArray(p?.to) ? p!.to : p?.to ? [p.to] : []).flatMap((a: any) => a.value.map((v: any) => v.address))));
  }
  if (await dropIfDisposed(inbox.account_id, candidates)) return { status: 200, dropped: true, reason: 'disposed' };
  if (inbox.unknown_policy === 'reject' && rcpt) {
    const addr = clean(rcpt);
    const own = await one<{ email: string; aliases: string }>('SELECT email, aliases FROM accounts WHERE id = ?', [inbox.account_id]);
    const mine = own && (own.email.toLowerCase() === addr || (JSON.parse(own.aliases) as string[]).some((a) => a.toLowerCase() === addr));
    if (!mine && inbox.domains.includes(addr.split('@')[1] ?? '') && !(await matchAddress(inbox.account_id, [addr]))) {
      return { status: 200, dropped: true, reason: 'unknown' };
    }
  }
  const head = raw.subarray(0, 16384).toString('latin1');
  const mid = /^message-id:[ \t]*(.+)$/im.exec(head)?.[1]?.trim() ?? '';
  const key = `${mid}|${sha256(raw)}`;
  const first = await one<{ dedupe_key: string }>(
    'INSERT INTO push_seen(account_id, dedupe_key, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING dedupe_key',
    [inbox.account_id, key, Date.now()]);
  if (!first) {
    const seen = await one<{ message_row_id: number | null }>('SELECT message_row_id FROM push_seen WHERE account_id = ? AND dedupe_key = ?', [inbox.account_id, key]);
    return { status: 200, id: seen?.message_row_id ?? null, duplicate: true };
  }
  try {
    const result = await ingestLocal(inbox.account_id, 'inbox', raw, { isLive: true, deliveredTo: rcpt });
    if (!result) throw new Error('message was not stored');
    await run('UPDATE push_seen SET message_row_id = ? WHERE account_id = ? AND dedupe_key = ?', [result.rowId, inbox.account_id, key]);
    const acct = await one<{ ai_categorize: boolean }>('SELECT ai_categorize FROM accounts WHERE id = ?', [inbox.account_id]);
    if (result.isInboxLive) {
      syncManager.emit('newMail', {
        accountId: inbox.account_id, userId: result.userId, rowId: result.rowId, mailboxRole: 'inbox',
        from: result.parsed.from?.text ?? '', subject: result.parsed.subject ?? '',
        aiCategorize: !!acct?.ai_categorize,
      } satisfies NewMailEvent);
    }
    syncManager.emit('changed', result.userId);
    return { status: 202, id: result.rowId };
  } catch (err: any) {
    await run('DELETE FROM push_seen WHERE account_id = ? AND dedupe_key = ?', [inbox.account_id, key]); // let the Worker retry
    return { status: 500, error: String(err?.message ?? err) };
  }
}

