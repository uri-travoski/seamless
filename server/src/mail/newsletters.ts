/**
 * Newsletters (T6.3 F-40, minus the digest which the user removed from scope).
 *
 * - detection at ingest from list / ESP headers → messages.is_newsletter (+ the List-Unsubscribe headers)
 * - per-sender choice (Inbox / Read later / Unsubscribed) in newsletter_senders
 * - Read later: flagged mail leaves the Inbox view and shows in the Read later folder (like Snoozed)
 * - unsubscribe: RFC 8058 one-click POST through the SSRF guard, else mailto, else hand the link to the browser;
 *   then a filter sends the sender's future mail to Trash (or Archive) and the sender is marked unsubscribed.
 * VIP and snoozed mail are never moved by this feature.
 */
import { q, one, run, insertId, bumpState } from '../db.ts';
import { getUserSetting, setUserSetting } from '../classify/settings.ts';
import { safeRequest, type SafeRequest, type SafeResponse } from '../integrations/ssrf.ts';
import { VIP_SQL } from './vip.ts';
import { broadcast } from '../ws.ts';

export class NewsletterError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export const WORDS_PER_MINUTE = 230;
export type Choice = 'inbox' | 'read_later' | 'unsubscribed';

// ---- detection ----

const ESP_HEADERS = ['x-mailchimp-id', 'x-mc-user', 'x-sg-eid', 'x-sg-id', 'x-mailgun-sid', 'x-mailgun-variables', 'feedback-id',
  'x-campaign-id', 'x-campaignid', 'x-mandrill-user', 'x-ses-outgoing', 'x-mailer-lid', 'x-cmail-id', 'x-rpcampaign', 'x-pm-tag', 'x-csa-complaints'];

/** Raw (unfolded) header values from the header block of a message; lower-cased names, first value wins. */
export function rawHeaders(raw: Buffer | string): Map<string, string> {
  const text = (typeof raw === 'string' ? raw : raw.subarray(0, 64 * 1024).toString('utf8'));
  const block = text.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ');
  const out = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(i + 1).trim());
  }
  return out;
}

export interface Detection { isNewsletter: boolean; sender: string; listId: string | null; unsubscribe: string | null; unsubscribePost: string | null }

/** `<id.example.com>` or `Name <id.example.com>` → `id.example.com` */
export function listIdValue(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.match(/<([^>]+)>/);
  const id = (m ? m[1] : v).trim().toLowerCase();
  return id || null;
}

/** Decide whether a message is a newsletter / bulk mail, and which key identifies its sender. */
export function detectNewsletter(h: Map<string, string>, fromAddr: string, aiVerdict?: string | null): Detection {
  const unsub = h.get('list-unsubscribe') ?? null;
  const post = h.get('list-unsubscribe-post') ?? null;
  const listId = listIdValue(h.get('list-id'));
  const precedence = (h.get('precedence') ?? '').toLowerCase();
  const bulk = precedence === 'bulk' || precedence === 'list' || precedence === 'junk';
  const esp = ESP_HEADERS.some((n) => h.has(n));
  const ai = (aiVerdict ?? '').toLowerCase() === 'newsletter';
  const isNewsletter = !!unsub || !!listId || bulk || esp || ai;
  return { isNewsletter, sender: (listId ?? fromAddr).toLowerCase(), listId, unsubscribe: unsub, unsubscribePost: post };
}

export function readMinutes(text: string): number {
  const words = (text.match(/\S+/g) ?? []).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/** Entries of a List-Unsubscribe header: `<https://…>, <mailto:…>` */
export function parseUnsubTargets(header: string | null): { https: string[]; http: string[]; mailto: string[] } {
  const out = { https: [] as string[], http: [] as string[], mailto: [] as string[] };
  if (!header) return out;
  for (const m of header.matchAll(/<([^>]+)>/g)) {
    const u = m[1].trim();
    if (/^https:\/\//i.test(u)) out.https.push(u);
    else if (/^http:\/\//i.test(u)) out.http.push(u);
    else if (/^mailto:/i.test(u)) out.mailto.push(u);
  }
  return out;
}

export function isOneClick(post: string | null): boolean {
  return !!post && /list-unsubscribe\s*=\s*one-click/i.test(post);
}

export type UnsubMethod = 'one-click' | 'mailto' | 'link' | null;
export function unsubMethod(unsub: string | null, post: string | null): UnsubMethod {
  const t = parseUnsubTargets(unsub);
  if (isOneClick(post) && t.https.length) return 'one-click';
  if (t.mailto.length) return 'mailto';
  if (t.https.length || t.http.length) return 'link';
  return null;
}

// ---- senders ----

export interface NewsletterSender { id: number; sender: string; choice: Choice; createdAt: number }

export async function listSenders(userId: number): Promise<NewsletterSender[]> {
  const rows = await q<any>('SELECT id, sender, choice, created_at FROM newsletter_senders WHERE user_id = ? ORDER BY sender', [userId]);
  return rows.map((r) => ({ id: r.id, sender: r.sender, choice: r.choice, createdAt: Number(r.created_at) }));
}

export async function senderChoice(userId: number, sender: string): Promise<Choice | null> {
  const r = await one<{ choice: Choice }>('SELECT choice FROM newsletter_senders WHERE user_id = ? AND sender = ?', [userId, sender.toLowerCase()]);
  return r?.choice ?? null;
}

async function ownMessage(userId: number, emailId: string) {
  const id = Number(String(emailId).replace(/^m/, '')) || 0;
  const m = await one<any>('SELECT * FROM messages WHERE id = ? AND user_id = ?', [id, userId]);
  if (!m) throw new NewsletterError(404, 'not found');
  return m;
}

/** A read-later flag may only be set on mail that is not snoozed and not from a VIP. */
async function canFlag(userId: number, rowId: number): Promise<boolean> {
  const r = await one(`SELECT 1 FROM messages m WHERE m.id = ? AND m.user_id = ? AND COALESCE(m.snoozed_until, 0) <= ? AND NOT ${VIP_SQL}`, [rowId, userId, Date.now(), userId]);
  return !!r;
}

export async function setSenderChoice(userId: number, sender: string, choice: Choice, emailId?: string): Promise<NewsletterSender> {
  if (!['inbox', 'read_later', 'unsubscribed'].includes(choice)) throw new NewsletterError(400, 'choice must be inbox, read_later or unsubscribed');
  const key = String(sender ?? '').trim().toLowerCase();
  if (!key) throw new NewsletterError(400, 'sender is required');
  await run(`INSERT INTO newsletter_senders(user_id, sender, choice, created_at) VALUES (?,?,?,?)
             ON CONFLICT (user_id, sender) DO UPDATE SET choice = excluded.choice`, [userId, key, choice, Date.now()]);
  if (emailId) {
    const m = await ownMessage(userId, emailId);
    if (choice === 'read_later' && m.mailbox_id && (await canFlag(userId, m.id))) {
      await run('UPDATE messages SET read_later = true, read_later_at = ? WHERE id = ?', [Date.now(), m.id]);
    } else if (choice === 'inbox') {
      await run('UPDATE messages SET read_later = false, read_later_at = NULL WHERE id = ?', [m.id]);
    }
  }
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
  return (await listSenders(userId)).find((s) => s.sender === key)!;
}

export async function removeSender(userId: number, id: number): Promise<void> {
  if ((await run('DELETE FROM newsletter_senders WHERE id = ? AND user_id = ?', [id, userId])) === 0) throw new NewsletterError(404, 'not found');
  await bumpState();
}

/** Prompt data for the reading pane (null when the message is not a newsletter). */
export async function newsletterInfo(userId: number, r: { id: number; is_newsletter: boolean; newsletter_sender: string | null; list_unsubscribe: string | null; list_unsubscribe_post: string | null; read_later: boolean; read_minutes: number | null }) {
  if (!r.is_newsletter || !r.newsletter_sender) return null;
  return {
    sender: r.newsletter_sender,
    choice: await senderChoice(userId, r.newsletter_sender),
    unsubscribe: unsubMethod(r.list_unsubscribe, r.list_unsubscribe_post),
  };
}

// ---- ingest hook ----

/** Called for every ingested inbox message. Records the detection; routes to Read later for chosen senders. */
export async function applyOnIngest(userId: number, rowId: number, d: Detection, minutes: number, opts: { live: boolean }): Promise<{ readLater: boolean }> {
  if (!d.isNewsletter) return { readLater: false };
  await run(`UPDATE messages SET is_newsletter = true, newsletter_sender = ?, list_unsubscribe = ?, list_unsubscribe_post = ?, read_minutes = ? WHERE id = ?`,
    [d.sender, d.unsubscribe, d.unsubscribePost, minutes, rowId]);
  if (!opts.live) return { readLater: false };
  if ((await senderChoice(userId, d.sender)) !== 'read_later') return { readLater: false };
  if (!(await canFlag(userId, rowId))) return { readLater: false };
  await run('UPDATE messages SET read_later = true, read_later_at = ? WHERE id = ?', [Date.now(), rowId]);
  return { readLater: true };
}

/** "Archive after read": a Read later message that gets opened leaves the list (moved to Archive). */
export async function archiveAfterRead(userId: number, rowId: number): Promise<void> {
  if ((await getUserSetting(userId, 'read_later_archive_after_read')) !== 'true') return;
  const m = await one<{ read_later: boolean }>('SELECT read_later FROM messages WHERE id = ? AND user_id = ?', [rowId, userId]);
  if (!m?.read_later) return;
  const { moveEmail } = await import('./store.ts');
  await run('UPDATE messages SET read_later = false, read_later_at = NULL WHERE id = ?', [rowId]);
  await moveEmail(userId, `m${rowId}`, 'u:archive');
}

// ---- settings ----

export interface NewsletterSettings { archiveAfterRead: boolean; retentionOn: boolean; retentionDays: number; unsubAction: 'trash' | 'archive' }

export async function getSettings(userId: number): Promise<NewsletterSettings> {
  return {
    archiveAfterRead: (await getUserSetting(userId, 'read_later_archive_after_read')) === 'true',
    retentionOn: (await getUserSetting(userId, 'read_later_retention')) !== 'false',
    retentionDays: Number(await getUserSetting(userId, 'read_later_retention_days')) || 30,
    unsubAction: (await getUserSetting(userId, 'unsub_action')) === 'archive' ? 'archive' : 'trash',
  };
}

export async function putSettings(userId: number, b: Partial<NewsletterSettings>): Promise<NewsletterSettings> {
  if (b.archiveAfterRead !== undefined) await setUserSetting(userId, 'read_later_archive_after_read', b.archiveAfterRead ? 'true' : 'false');
  if (b.retentionOn !== undefined) await setUserSetting(userId, 'read_later_retention', b.retentionOn ? 'true' : 'false');
  if (b.retentionDays !== undefined) {
    const n = Math.floor(Number(b.retentionDays));
    if (!(n >= 1 && n <= 3650)) throw new NewsletterError(400, 'retention must be 1–3650 days');
    await setUserSetting(userId, 'read_later_retention_days', String(n));
  }
  if (b.unsubAction !== undefined) {
    if (b.unsubAction !== 'trash' && b.unsubAction !== 'archive') throw new NewsletterError(400, 'unsubAction must be trash or archive');
    await setUserSetting(userId, 'unsub_action', b.unsubAction);
  }
  return getSettings(userId);
}

// ---- unsubscribe ----

export interface UnsubDeps {
  request?: (url: string, o: SafeRequest) => Promise<SafeResponse>;
  send?: (userId: number, payload: any) => Promise<unknown>;
}

async function allowList(): Promise<string[]> {
  return (await q<{ cidr_or_host: string }>('SELECT cidr_or_host FROM webhook_allowlist')).map((r) => r.cidr_or_host);
}

export interface UnsubResult { ok: true; method: 'one-click' | 'mailto' | 'link'; url?: string; filterId: number | null }

export async function unsubscribe(userId: number, emailId: string, deps: UnsubDeps = {}): Promise<UnsubResult> {
  const m = await ownMessage(userId, emailId);
  if (!m.is_newsletter) throw new NewsletterError(400, 'this message is not a newsletter');
  const method = unsubMethod(m.list_unsubscribe, m.list_unsubscribe_post);
  if (!method) throw new NewsletterError(400, 'this newsletter has no unsubscribe link');
  const t = parseUnsubTargets(m.list_unsubscribe);
  let url: string | undefined;

  if (method === 'one-click') {
    const request = deps.request ?? safeRequest;
    let res: SafeResponse;
    try {
      res = await request(t.https[0], {
        method: 'POST', body: 'List-Unsubscribe=One-Click', timeoutMs: 10_000, allow: await allowList(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Seamless' },
      });
    } catch (e: any) { throw new NewsletterError(502, `unsubscribe request failed: ${e?.message ?? e}`); }
    if (res.status < 200 || res.status >= 300) throw new NewsletterError(502, `the sender answered HTTP ${res.status}`);
  } else if (method === 'mailto') {
    const u = new URL(t.mailto[0]);
    const to = decodeURIComponent(u.pathname).trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(to)) throw new NewsletterError(400, 'the unsubscribe address is invalid');
    const subject = u.searchParams.get('subject') || 'unsubscribe';
    // send from the identity the newsletter was delivered to (falls back to the account's own address)
    const acct = await one<{ email: string }>('SELECT email FROM accounts WHERE id = ?', [m.account_id]);
    const ident = m.delivered_to ? await one<{ id: number; email: string }>(
      'SELECT id, email FROM identities WHERE user_id = ? AND account_id = ? AND lower(email) = lower(?)', [userId, m.account_id, m.delivered_to]) : null;
    const send = deps.send ?? (await import('./send.ts')).sendEmail;
    await send(userId, {
      accountId: m.account_id, fromEmail: ident?.email ?? acct!.email, ...(ident ? { identityId: ident.id } : {}),
      to: [{ name: '', email: to }], cc: [], bcc: [], subject, html: '', attachmentIds: [], track: false,
    });
  } else {
    url = t.https[0] ?? t.http[0];   // the user has to finish it in the browser
  }

  const filterId = await blockSender(userId, m.from_addr);
  await run(`INSERT INTO newsletter_senders(user_id, sender, choice, created_at) VALUES (?,?,'unsubscribed',?)
             ON CONFLICT (user_id, sender) DO UPDATE SET choice = 'unsubscribed'`, [userId, m.newsletter_sender, Date.now()]);
  await run('UPDATE messages SET read_later = false, read_later_at = NULL WHERE id = ?', [m.id]);
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
  return { ok: true, method, ...(url ? { url } : {}), filterId };
}

/** Filter that sends future mail from `addr` to Trash (or Archive, per setting). Idempotent. */
async function blockSender(userId: number, addr: string): Promise<number | null> {
  if (!addr) return null;
  const name = `Unsubscribed: ${addr}`;
  const existing = await one<{ id: number }>('SELECT id FROM filters WHERE user_id = ? AND name = ?', [userId, name]);
  if (existing) return existing.id;
  const action = (await getUserSetting(userId, 'unsub_action')) === 'archive' ? { type: 'move', value: 'archive' } : { type: 'delete' };
  const sort = (await one<{ s: number | null }>('SELECT MAX(sort) AS s FROM filters WHERE user_id = ?', [userId]))?.s ?? 0;
  return insertId('INSERT INTO filters(user_id, name, enabled, sort, match, conditions, actions, stop) VALUES (?,?,?,?,?,?,?,?)',
    [userId, name, true, sort + 1, 'all', JSON.stringify([{ field: 'from', op: 'contains', value: addr }]), JSON.stringify([action]), true]);
}

// ---- retention (called from classify/retention.ts) ----

/** Read later items older than N days (not starred, not VIP, not snoozed) → candidates for Trash. */
export async function retentionCandidates(userId: number, now: number): Promise<{ id: number; subject: string; from_addr: string }[]> {
  if ((await getUserSetting(userId, 'read_later_retention')) === 'false') return [];
  const days = Number(await getUserSetting(userId, 'read_later_retention_days')) || 30;
  return q(`
    SELECT m.id, m.subject, m.from_addr FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.user_id = ? AND m.read_later AND m.read_later_at IS NOT NULL AND m.read_later_at < ?
      AND m.flagged = false AND COALESCE(m.snoozed_until, 0) <= ? AND (mb.role IS NULL OR mb.role IN ('inbox','archive'))
      AND NOT ${VIP_SQL}
    ORDER BY m.read_later_at LIMIT 500`, [userId, now - days * 86_400_000, now, userId]);
}
