/** Calendar invites (T4 F-33): parse text/calendar parts at ingest, RSVP by iMIP REPLY, optional CalDAV PUT. */
import ICAL from 'ical.js';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { ParsedMail } from 'mailparser';
import type { ApiInvite, ApiInviteAttendee } from '@seamless/shared';
import { q, one, run } from '../db.ts';
import { encrypt, decrypt, randomToken } from '../crypto.ts';
import { config } from '../config.ts';
import { getMsgRow } from './store.ts';
import { roleFor, canSendRole, Forbidden } from '../auth/access.ts';
import { transportForAccount, sendWithFallback } from '../transport/registry.ts';
import type { AccountRow } from '../imap/sync.ts';

export const DEFAULT_ZONE = 'Australia/Perth';

// ---- time zones (no VTIMEZONE needed: Intl knows the IANA zones) ----
function tzOffsetMs(ms: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(ms)).reduce<Record<string, number>>((a, x) => { if (x.type !== 'literal') a[x.type] = Number(x.value); return a; }, {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
export function wallToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);   // second pass settles around DST changes
  return t;
}
const validZone = (tz: string | null | undefined): tz is string => {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

export interface ParsedInvite {
  uid: string; sequence: number; method: string; summary: string;
  startsAt: number | null; endsAt: number | null; allDay: boolean; tz: string | null;
  location: string; url: string; description: string;
  organizer: { name: string; email: string } | null;
  attendees: ApiInviteAttendee[];
  status: 'active' | 'cancelled';
  rawIcs: string;
}

const mailto = (v: unknown): string => String(v ?? '').replace(/^mailto:/i, '').trim().toLowerCase();

function timeToEpoch(prop: ICAL.Property | null, defaultZone: string): { ms: number | null; allDay: boolean; tz: string | null } {
  if (!prop) return { ms: null, allDay: false, tz: null };
  const t = prop.getFirstValue() as ICAL.Time;
  const j = t.toJSON() as { year: number; month: number; day: number; hour: number; minute: number; second: number; isDate: boolean; timezone?: string };
  const tzid = String(prop.getParameter('tzid') ?? '');
  if (j.isDate) return { ms: wallToEpoch(j.year, j.month, j.day, 0, 0, 0, defaultZone), allDay: true, tz: null };
  if (/Z$/.test(prop.toICALString().trim()) || /^(UTC|GMT|Z)$/i.test(tzid)) return { ms: Date.UTC(j.year, j.month - 1, j.day, j.hour, j.minute, j.second), allDay: false, tz: null };
  const zone = validZone(tzid) ? tzid : defaultZone;
  return { ms: wallToEpoch(j.year, j.month, j.day, j.hour, j.minute, j.second, zone), allDay: false, tz: validZone(tzid) ? tzid : null };
}

/** Parse one iCalendar document. Returns null when it holds no VEVENT. Throws on garbage (caller catches). */
export function parseIcs(ics: string, contentTypeMethod?: string | null, defaultZone = DEFAULT_ZONE): ParsedInvite | null {
  const cal = new ICAL.Component(ICAL.parse(ics));
  const ev = cal.getFirstSubcomponent('vevent');
  if (!ev) return null;
  const uid = String(ev.getFirstPropertyValue('uid') ?? '');
  if (!uid) return null;
  const method = String(cal.getFirstPropertyValue('method') ?? contentTypeMethod ?? 'REQUEST').toUpperCase();
  const start = timeToEpoch(ev.getFirstProperty('dtstart'), defaultZone);
  let end = timeToEpoch(ev.getFirstProperty('dtend'), defaultZone);
  if (end.ms === null && start.ms !== null) {
    const dur = ev.getFirstPropertyValue('duration') as ICAL.Duration | null;
    end = { ms: start.ms + (dur ? dur.toSeconds() * 1000 : start.allDay ? 86_400_000 : 0), allDay: start.allDay, tz: null };
  }
  const orgProp = ev.getFirstProperty('organizer');
  const organizer = orgProp ? { name: String(orgProp.getParameter('cn') ?? ''), email: mailto(orgProp.getFirstValue()) } : null;
  const attendees = ev.getAllProperties('attendee').map((a): ApiInviteAttendee => ({
    name: String(a.getParameter('cn') ?? ''), email: mailto(a.getFirstValue()),
    partstat: String(a.getParameter('partstat') ?? 'NEEDS-ACTION').toUpperCase(), role: String(a.getParameter('role') ?? 'REQ-PARTICIPANT').toUpperCase(),
  }));
  const status = method === 'CANCEL' || String(ev.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED' ? 'cancelled' : 'active';
  return {
    uid, method, status, sequence: Number(ev.getFirstPropertyValue('sequence') ?? 0) || 0,
    summary: String(ev.getFirstPropertyValue('summary') ?? ''), startsAt: start.ms, endsAt: end.ms, allDay: start.allDay,
    tz: start.tz, location: String(ev.getFirstPropertyValue('location') ?? ''), url: String(ev.getFirstPropertyValue('url') ?? ''),
    description: String(ev.getFirstPropertyValue('description') ?? ''), organizer, attendees, rawIcs: ics,
  };
}

const VIDEO_RE = /https?:\/\/(?:[\w-]+\.)?(?:meet\.google\.com|zoom\.us|zoom\.com|teams\.microsoft\.com|teams\.live\.com)\/[^\s<>"')]+/i;
export function findVideoUrl(...texts: string[]): string | null {
  for (const t of texts) { const m = t.match(VIDEO_RE); if (m) return m[0]; }
  return null;
}

async function userZone(userId: number): Promise<string> {
  const row = await one<{ value: string }>("SELECT value FROM user_settings WHERE user_id = ? AND key = 'notif_quiet'", [userId]);
  try { const tz = JSON.parse(row?.value ?? '{}').tz; if (validZone(tz)) return tz; } catch { /* default */ }
  return DEFAULT_ZONE;
}

/** Every address the account's owner is known by on this mailbox (account, aliases, identities). */
async function ownAddresses(accountId: number): Promise<string[]> {
  const a = await one<{ email: string; aliases: string }>('SELECT email, aliases FROM accounts WHERE id = ?', [accountId]);
  const ids = await q<{ email: string }>('SELECT email FROM identities WHERE account_id = ?', [accountId]).catch(() => []);
  const out = new Set<string>();
  if (a) { out.add(a.email.toLowerCase()); for (const al of JSON.parse(a.aliases || '[]') as string[]) out.add(al.toLowerCase()); }
  for (const i of ids) out.add(i.email.toLowerCase());
  return [...out];
}

/** Ingest hook: store/refresh the invite carried by this message. Never throws. */
export async function ingestInvites(userId: number, accountId: number, rowId: number, parsed: ParsedMail): Promise<void> {
  try {
    const parts = (parsed.attachments ?? []).filter((a) => /^(text\/calendar|application\/ics)/i.test(a.contentType) || /\.ics$/i.test(a.filename ?? ''));
    if (parts.length === 0) return;
    const zone = await userZone(userId);
    const mine = await ownAddresses(accountId);
    for (const part of parts) {
      const methodParam = part.contentType.match(/method=([A-Za-z]+)/i)?.[1] ?? (part.headers?.get('content-type') as any)?.params?.method ?? null;
      let inv: ParsedInvite | null = null;
      try { inv = parseIcs(part.content.toString('utf8'), methodParam, zone); } catch (err: any) { console.error('[invites] parse failed:', err?.message ?? err); }
      if (!inv || inv.method === 'REPLY' || inv.method === 'COUNTER' || inv.method === 'REFRESH') continue;
      const me = inv.attendees.find((a) => mine.includes(a.email));
      const old = await one<{ id: number; sequence: number; my_partstat: string | null }>('SELECT id, sequence, my_partstat FROM calendar_invites WHERE user_id = ? AND uid = ?', [userId, inv.uid]);
      if (old && inv.sequence < old.sequence) continue;   // stale update
      const myPart = old && inv.sequence === old.sequence && old.my_partstat && old.my_partstat !== 'NEEDS-ACTION' ? old.my_partstat : (me?.partstat ?? null);
      const vals = [rowId, inv.sequence, inv.method, inv.summary, inv.startsAt, inv.endsAt, inv.allDay, inv.tz, inv.location, inv.url,
        inv.organizer ? JSON.stringify(inv.organizer) : null, JSON.stringify(inv.attendees), inv.status, myPart, inv.rawIcs];
      if (old) {
        await run(`UPDATE calendar_invites SET message_id=?, sequence=?, method=?, summary=?, starts_at=?, ends_at=?, all_day=?, tz=?, location=?, url=?,
                   organizer=?, attendees=?, status=?, my_partstat=?, raw_ics=? WHERE id = ?`, [...vals, old.id]);
      } else {
        await run(`INSERT INTO calendar_invites(message_id, sequence, method, summary, starts_at, ends_at, all_day, tz, location, url, organizer, attendees, status, my_partstat, raw_ics, user_id, uid, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...vals, userId, inv.uid, Date.now()]);
      }
    }
  } catch (err: any) {
    console.error('[invites] ingest hook failed:', err?.message ?? err);
  }
}

interface InviteRow {
  id: number; user_id: number; message_id: number | null; uid: string; sequence: number; method: string; summary: string;
  starts_at: string | null; ends_at: string | null; all_day: boolean; tz: string | null; location: string; url: string;
  organizer: { name: string; email: string } | null; attendees: ApiInviteAttendee[]; status: 'active' | 'cancelled';
  my_partstat: string | null; raw_ics: string;
}

async function toApi(userId: number, r: InviteRow, accountId: number | null): Promise<ApiInvite> {
  let description = '';
  try { description = parseIcs(r.raw_ics)?.description ?? ''; } catch { /* ignore */ }
  const mine = accountId ? await ownAddresses(accountId) : [];
  const me = r.attendees.find((a) => mine.includes(a.email));
  const role = accountId ? await roleFor(userId, accountId) : null;
  const conn = await one('SELECT id FROM calendar_connections WHERE user_id = ?', [r.user_id]);
  return {
    id: r.id, uid: r.uid, sequence: r.sequence, method: r.method, summary: r.summary,
    startsAt: r.starts_at === null ? null : Number(r.starts_at), endsAt: r.ends_at === null ? null : Number(r.ends_at),
    allDay: r.all_day, tz: r.tz, location: r.location, url: r.url,
    videoUrl: findVideoUrl(r.url, r.location, description), organizer: r.organizer, attendees: r.attendees,
    status: r.status, myPartstat: r.my_partstat, myEmail: me?.email ?? null,
    canRsvp: r.status === 'active' && !!me && !!r.organizer?.email && canSendRole(role) && r.user_id === (await ownerOf(accountId)),
    caldavConnected: !!conn && r.user_id === userId,
  };
}
async function ownerOf(accountId: number | null): Promise<number | null> {
  if (!accountId) return null;
  return (await one<{ user_id: number }>('SELECT user_id FROM accounts WHERE id = ?', [accountId]))?.user_id ?? null;
}

/** Card data for a message (access is checked by getMsgRow upstream). */
export async function inviteForMessage(userId: number, rowId: number, accountId: number): Promise<ApiInvite | null> {
  const r = await one<InviteRow>('SELECT * FROM calendar_invites WHERE message_id = ?', [rowId]);
  return r ? toApi(userId, r, accountId) : null;
}

/** Load an invite the user may see (through the message's account); undefined = not found for them. */
async function loadInvite(userId: number, id: number): Promise<{ row: InviteRow; accountId: number | null } | undefined> {
  const row = await one<InviteRow>('SELECT * FROM calendar_invites WHERE id = ?', [id]);
  if (!row) return undefined;
  if (row.message_id) {
    const m = await one<{ account_id: number }>('SELECT account_id FROM messages WHERE id = ?', [row.message_id]);
    if (m && ((row.user_id === userId) || (await roleFor(userId, m.account_id)))) return { row, accountId: m.account_id };
    return undefined;
  }
  return row.user_id === userId ? { row, accountId: null } : undefined;
}

export async function getInvite(userId: number, id: number): Promise<ApiInvite | undefined> {
  const l = await loadInvite(userId, id);
  return l ? toApi(userId, l.row, l.accountId) : undefined;
}
export async function inviteIcs(userId: number, id: number): Promise<{ ics: string; filename: string } | undefined> {
  const l = await loadInvite(userId, id);
  return l ? { ics: l.row.raw_ics, filename: `${l.row.summary.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'invite'}.ics` } : undefined;
}

// ---- RSVP ----
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const fold = (line: string) => line.length <= 73 ? line : line.match(/.{1,73}/g)!.join('\r\n ');

export function buildReplyIcs(inv: { uid: string; sequence: number; summary: string; startsAt: number | null; endsAt: number | null; organizer: { name: string; email: string } }, me: { name: string; email: string }, partstat: string): string {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Seamless//Invites//EN', 'METHOD:REPLY', 'BEGIN:VEVENT',
    `UID:${inv.uid}`, `SEQUENCE:${inv.sequence}`, `DTSTAMP:${icsDate(Date.now())}`,
    ...(inv.startsAt ? [`DTSTART:${icsDate(inv.startsAt)}`] : []), ...(inv.endsAt ? [`DTEND:${icsDate(inv.endsAt)}`] : []),
    `SUMMARY:${esc(inv.summary)}`,
    `ORGANIZER${inv.organizer.name ? `;CN="${inv.organizer.name.replace(/"/g, '')}"` : ''}:mailto:${inv.organizer.email}`,
    `ATTENDEE;${me.name ? `CN="${me.name.replace(/"/g, '')}";` : ''}PARTSTAT=${partstat}:mailto:${me.email}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

const VERB: Record<string, string> = { ACCEPTED: 'Accepted', TENTATIVE: 'Tentative', DECLINED: 'Declined' };

export async function rsvp(userId: number, id: number, partstat: string, note: string): Promise<ApiInvite> {
  if (!VERB[partstat]) throw Object.assign(new Error('partstat must be ACCEPTED, TENTATIVE or DECLINED'), { statusCode: 400 });
  const l = await loadInvite(userId, id);
  if (!l || !l.accountId) throw Object.assign(new Error('not found'), { statusCode: 404 });
  const role = await roleFor(userId, l.accountId);
  if (!canSendRole(role)) throw new Forbidden('viewers cannot reply to invites');
  const { row } = l;
  if (row.status === 'cancelled') throw Object.assign(new Error('this event was cancelled'), { statusCode: 409 });
  if (!row.organizer?.email) throw Object.assign(new Error('the invite has no organiser to reply to'), { statusCode: 400 });
  const mine = await ownAddresses(l.accountId);
  const meAtt = row.attendees.find((a) => mine.includes(a.email));
  if (!meAtt) throw Object.assign(new Error('none of your addresses is on the attendee list'), { statusCode: 400 });

  const owner = row.user_id;
  const acct = await one<AccountRow>('SELECT * FROM accounts WHERE id = ?', [l.accountId]);
  if (!acct) throw Object.assign(new Error('not found'), { statusCode: 404 });
  const ident = await one<{ display_name: string; transport_id: number | null }>('SELECT display_name, transport_id FROM identities WHERE account_id = ? AND lower(email) = ?', [l.accountId, meAtt.email]).catch(() => undefined);
  const fromName = ident?.display_name || meAtt.name || acct.name || meAtt.email;
  const ics = buildReplyIcs({ ...row, startsAt: row.starts_at === null ? null : Number(row.starts_at), endsAt: row.ends_at === null ? null : Number(row.ends_at), organizer: row.organizer }, { name: fromName, email: meAtt.email }, partstat);
  const text = `${fromName} <${meAtt.email}> has ${VERB[partstat].toLowerCase()} the invitation "${row.summary}".` + (note.trim() ? `\n\n${note.trim()}` : '');
  const composer = new MailComposer({
    from: { name: fromName, address: meAtt.email },
    to: [{ name: row.organizer.name, address: row.organizer.email }],
    subject: `${VERB[partstat]}: ${row.summary}`,
    text,
    messageId: `<${randomToken(12)}@${new URL(config.publicUrl).hostname}>`,
    alternatives: [{ contentType: 'text/calendar; method=REPLY; charset=utf-8', content: ics }],
  });
  const raw = await new Promise<Buffer>((res, rej) => composer.compile().build((e, m) => (e ? rej(e) : res(m))));
  const transport = await transportForAccount(owner, acct, ident?.transport_id);
  await sendWithFallback(owner, transport, raw, { from: meAtt.email, to: [row.organizer.email] }, { subject: `${VERB[partstat]}: ${row.summary}`, accountId: acct.id });
  await run('UPDATE calendar_invites SET my_partstat = ? WHERE id = ?', [partstat, id]);
  return (await getInvite(userId, id))!;
}

// ---- CalDAV (optional) ----
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init as any);
export function setCaldavFetch(f: FetchLike | null): void { fetchImpl = f ?? ((url, init) => fetch(url, init as any)); }

export async function getConnection(userId: number): Promise<{ url: string; username: string } | null> {
  const r = await one<{ url: string; username: string }>('SELECT url, username FROM calendar_connections WHERE user_id = ?', [userId]);
  return r ?? null;
}
export async function setConnection(userId: number, url: string, username: string, password: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error('calendar URL must be http(s)'), { statusCode: 400 });
  if (!username || !password) throw Object.assign(new Error('username and password are required'), { statusCode: 400 });
  await run(`INSERT INTO calendar_connections(user_id, url, username, password_enc, created_at) VALUES (?,?,?,?,?)
             ON CONFLICT (user_id) DO UPDATE SET url = excluded.url, username = excluded.username, password_enc = excluded.password_enc`,
    [userId, url, username, encrypt(password), Date.now()]);
}
export async function deleteConnection(userId: number): Promise<void> { await run('DELETE FROM calendar_connections WHERE user_id = ?', [userId]); }

/** PUT the invite's event to the user's CalDAV calendar as <uid>.ics (Basic auth). */
export async function addToCalendar(userId: number, id: number): Promise<{ ok: true; href: string }> {
  const l = await loadInvite(userId, id);
  if (!l) throw Object.assign(new Error('not found'), { statusCode: 404 });
  const c = await one<{ url: string; username: string; password_enc: string }>('SELECT * FROM calendar_connections WHERE user_id = ?', [userId]);
  if (!c) throw Object.assign(new Error('no calendar connected'), { statusCode: 400 });
  const href = `${c.url.replace(/\/+$/, '')}/${encodeURIComponent(l.row.uid)}.ics`;
  const res = await fetchImpl(href, {
    method: 'PUT',
    headers: { Authorization: `Basic ${Buffer.from(`${c.username}:${decrypt(c.password_enc)}`).toString('base64')}`, 'Content-Type': 'text/calendar; charset=utf-8' },
    body: l.row.raw_ics,
  });
  if (res.status < 200 || res.status >= 300) throw Object.assign(new Error(`calendar server answered ${res.status}`), { statusCode: 502 });
  return { ok: true, href };
}
