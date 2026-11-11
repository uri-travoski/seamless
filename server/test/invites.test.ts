/** T4 F-33: calendar invites — ingest, card data, RSVP (iMIP REPLY), cancel, time zones, CalDAV, isolation. */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import http from 'node:http';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest } from './helpers.ts';

const sent: any[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { q } = await import('../src/db.ts');
const { parseIcs, findVideoUrl, wallToEpoch } = await import('../src/mail/invites.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

let app: Awaited<ReturnType<typeof makeApp>>;
let A: number, B: number, acct: number, inbox: number;
const ck: Record<string, string> = {};
const api = (who: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck[who] } });

const ics = (o: { method?: string; uid?: string; seq?: number; dtstart?: string; summary?: string; location?: string; status?: string } = {}) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', `METHOD:${o.method ?? 'REQUEST'}`, 'BEGIN:VEVENT',
  `UID:${o.uid ?? 'evt-1@org.test'}`, `SEQUENCE:${o.seq ?? 0}`, 'DTSTAMP:20260701T000000Z',
  o.dtstart ?? 'DTSTART;TZID=America/New_York:20260715T090000', 'DTEND;TZID=America/New_York:20260715T100000',
  `SUMMARY:${o.summary ?? 'Planning sync'}`, `LOCATION:${o.location ?? 'https://meet.google.com/abc-defg-hij'}`,
  ...(o.status ? [`STATUS:${o.status}`] : []),
  'ORGANIZER;CN=Olivia Org:mailto:olivia@org.test',
  'ATTENDEE;CN=Alice;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@demo.test',
  'ATTENDEE;CN=Pat;PARTSTAT=ACCEPTED:mailto:pat@org.test',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

function invMail(icsText: string, subject = 'Invitation: Planning sync'): Buffer {
  const b = 'BOUND';
  return Buffer.from([
    'From: Olivia Org <olivia@org.test>', 'To: alice@demo.test', `Subject: ${subject}`, 'Date: Wed, 08 Jul 2026 10:00:00 +0000',
    `Message-ID: <${Math.random().toString(36).slice(2)}@org.test>`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary=${b}`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', '', 'You are invited.', '',
    `--${b}`, `Content-Type: text/calendar; charset=utf-8; method=${/METHOD:CANCEL/.test(icsText) ? 'CANCEL' : 'REQUEST'}`, '', icsText, `--${b}--`, '',
  ].join('\r\n'));
}
const msgInvite = async (rowId: number) => (await api('A', 'GET', `/api/message/m${rowId}/body`)).json().invite;

beforeEach(async () => {
  await resetDb(); resetLimiters(); sent.length = 0;
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test');
  acct = await makeAccount('alice@demo.test', { userId: A });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  app = await makeApp();
  ck.A = await login(app, 'a@x.test'); ck.B = await login(app, 'b@x.test');
});
afterAll(() => { /* nothing to close */ });

describe('parsing + time zones', () => {
  it('America/New_York 09:00 in July is 21:00 Perth (UTC+8)', () => {
    const p = parseIcs(ics())!;
    expect(new Date(p.startsAt!).toISOString()).toBe('2026-07-15T13:00:00.000Z');
    const perth = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Perth', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(p.startsAt!));
    expect(perth).toBe('21:00');
    expect(p.tz).toBe('America/New_York');
    expect(wallToEpoch(2026, 1, 15, 9, 0, 0, 'America/New_York')).toBe(Date.UTC(2026, 0, 15, 14)); // winter offset differs
  });
  it('UTC and all-day values; video link detection', () => {
    expect(new Date(parseIcs(ics({ dtstart: 'DTSTART:20260715T130000Z' }))!.startsAt!).toISOString()).toBe('2026-07-15T13:00:00.000Z');
    expect(parseIcs(ics({ dtstart: 'DTSTART;VALUE=DATE:20260715' }))!.allDay).toBe(true);
    expect(findVideoUrl('', 'Join https://acme.zoom.us/j/123?pwd=x now')).toContain('zoom.us/j/123');
    expect(findVideoUrl('https://teams.microsoft.com/l/meetup-join/abc')).toContain('teams.microsoft');
    expect(findVideoUrl('Room 4')).toBeNull();
  });
  it('garbage does not break ingest', async () => {
    const r = await ingest(acct, inbox, invMail('BEGIN:VCALENDAR\r\nnot really\r\n'));
    expect(r).toBeTruthy();
    expect(await q('SELECT 1 FROM calendar_invites')).toHaveLength(0);
  });
});

describe('ingest + card data', () => {
  it('stores a REQUEST and returns card data with the message body', async () => {
    const r = await ingest(acct, inbox, invMail(ics()));
    const inv = await msgInvite(r!.rowId);
    expect(inv).toMatchObject({ uid: 'evt-1@org.test', summary: 'Planning sync', method: 'REQUEST', status: 'active', myPartstat: 'NEEDS-ACTION',
      myEmail: 'alice@demo.test', tz: 'America/New_York', canRsvp: true, videoUrl: 'https://meet.google.com/abc-defg-hij' });
    expect(inv.startsAt).toBe(Date.UTC(2026, 6, 15, 13));
    expect(inv.organizer).toEqual({ name: 'Olivia Org', email: 'olivia@org.test' });
    expect(inv.attendees).toHaveLength(2);
    const dl = await api('A', 'GET', `/api/invites/${inv.id}/ics`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('text/calendar');
    expect(dl.body).toContain('UID:evt-1@org.test');
  });
  it('a later REQUEST with a higher sequence updates the row; a lower one is ignored; CANCEL marks cancelled', async () => {
    const r1 = await ingest(acct, inbox, invMail(ics()));
    const r2 = await ingest(acct, inbox, invMail(ics({ seq: 2, summary: 'Planning sync v2', dtstart: 'DTSTART;TZID=America/New_York:20260716T090000' })));
    expect(await q('SELECT 1 FROM calendar_invites')).toHaveLength(1);
    let inv = await msgInvite(r2!.rowId);
    expect(inv).toMatchObject({ summary: 'Planning sync v2', sequence: 2 });
    expect(await msgInvite(r1!.rowId)).toBeNull();
    await ingest(acct, inbox, invMail(ics({ seq: 1, summary: 'stale' })));
    expect((await q<any>('SELECT summary FROM calendar_invites'))[0].summary).toBe('Planning sync v2');
    const r4 = await ingest(acct, inbox, invMail(ics({ method: 'CANCEL', seq: 3, status: 'CANCELLED' }), 'Cancelled: Planning sync'));
    inv = await msgInvite(r4!.rowId);
    expect(inv).toMatchObject({ status: 'cancelled', canRsvp: false });
    expect((await api('A', 'POST', `/api/invites/${inv.id}/rsvp`, { partstat: 'ACCEPTED' })).statusCode).toBe(409);
  });
});

describe('RSVP', () => {
  it('Accept sends an iMIP REPLY with the same UID/SEQUENCE and our PARTSTAT, and stores my_partstat', async () => {
    const r = await ingest(acct, inbox, invMail(ics({ seq: 4 })));
    const inv = await msgInvite(r!.rowId);
    const res = await api('A', 'POST', `/api/invites/${inv.id}/rsvp`, { partstat: 'ACCEPTED', note: 'See you there' });
    expect(res.statusCode).toBe(200);
    expect(res.json().myPartstat).toBe('ACCEPTED');
    expect(sent).toHaveLength(1);
    const raw = (sent[0].raw as Buffer).toString().replace(/\r\n[ \t]/g, '');
    expect(sent[0].envelope.to).toEqual(['olivia@org.test']);
    expect(raw).toMatch(/Content-Type: text\/calendar; method=REPLY/i);
    expect(raw).toContain('METHOD:REPLY');
    expect(raw).toContain('UID:evt-1@org.test');
    expect(raw).toContain('SEQUENCE:4');
    expect(raw).toMatch(/ATTENDEE;[^\r\n]*PARTSTAT=ACCEPTED:mailto:alice@demo\.test/);
    expect(raw).toContain('See you there');
    expect(raw).toContain('Subject: Accepted: Planning sync');
    expect((await q<any>('SELECT my_partstat FROM calendar_invites'))[0].my_partstat).toBe('ACCEPTED');
    expect((await api('A', 'POST', `/api/invites/${inv.id}/rsvp`, { partstat: 'MAYBE' })).statusCode).toBe(400);
    expect((await api('A', 'POST', `/api/invites/${inv.id}/rsvp`, { partstat: 'DECLINED' })).statusCode).toBe(200);
    expect(sent[1].raw.toString()).toContain('PARTSTAT=DECLINED');
  });
  it('refuses when none of your addresses is invited', async () => {
    const other = ics().replace('mailto:alice@demo.test', 'mailto:someone@else.test');
    const r = await ingest(acct, inbox, invMail(other));
    const inv = await msgInvite(r!.rowId);
    expect(inv.canRsvp).toBe(false);
    expect((await api('A', 'POST', `/api/invites/${inv.id}/rsvp`, { partstat: 'ACCEPTED' })).statusCode).toBe(400);
  });
});

describe('CalDAV', () => {
  it('PUTs <uid>.ics with Basic auth to a fake server', async () => {
    const seen: any[] = [];
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b }); res.statusCode = 201; res.end(); }); });
    await new Promise<void>((ok) => srv.listen(0, ok));
    const port = (srv.address() as any).port;
    try {
      const r = await ingest(acct, inbox, invMail(ics()));
      const inv = await msgInvite(r!.rowId);
      expect((await api('A', 'POST', `/api/invites/${inv.id}/caldav`)).statusCode).toBe(400);
      expect((await api('A', 'PUT', '/api/calendar-connection', { url: `http://127.0.0.1:${port}/cal/alice`, username: 'alice', password: 's3cret' })).statusCode).toBe(200);
      expect((await q<any>('SELECT password_enc FROM calendar_connections'))[0].password_enc).not.toContain('s3cret');
      expect((await api('A', 'GET', '/api/calendar-connection')).statusCode).toBe(200);
      expect((await api('A', 'POST', `/api/invites/${inv.id}/caldav`)).statusCode).toBe(200);
      expect(seen[0]).toMatchObject({ method: 'PUT', url: '/cal/alice/evt-1%40org.test.ics' });
      expect(seen[0].auth).toBe('Basic ' + Buffer.from('alice:s3cret').toString('base64'));
      expect(seen[0].body).toContain('UID:evt-1@org.test');
    } finally { srv.close(); }
  });
});

describe('isolation', () => {
  it('user B cannot read, download, RSVP or push user A\'s invite', async () => {
    const r = await ingest(acct, inbox, invMail(ics()));
    const inv = await msgInvite(r!.rowId);
    expect((await api('B', 'GET', `/api/invites/${inv.id}`)).statusCode).toBe(404);
    expect((await api('B', 'GET', `/api/invites/${inv.id}/ics`)).statusCode).toBe(404);
    expect((await api('B', 'POST', `/api/invites/${inv.id}/rsvp`, { partstat: 'ACCEPTED' })).statusCode).toBe(404);
    expect((await api('B', 'GET', `/api/message/m${r!.rowId}/body`)).statusCode).toBe(404);
    expect(sent).toHaveLength(0);
    expect((await api('B', 'GET', '/api/calendar-connection')).json().url).toBeNull();
  });
  it('a viewer on a shared mailbox sees the card but cannot RSVP; a responder can', async () => {
    const C = await makeUser('c@x.test');
    ck.C = await login(app, 'c@x.test');
    await api('A', 'PUT', `/api/accounts/${acct}/shares`, { userId: B, role: 'viewer' });
    await api('A', 'PUT', `/api/accounts/${acct}/shares`, { userId: C, role: 'responder' });
    const r = await ingest(acct, inbox, invMail(ics()));
    const inv = await msgInvite(r!.rowId);
    expect((await api('B', 'GET', `/api/invites/${inv.id}`)).json().canRsvp).toBe(false);
    expect((await api('B', 'POST', `/api/invites/${inv.id}/rsvp`, { partstat: 'ACCEPTED' })).statusCode).toBe(403);
    expect((await api('C', 'POST', `/api/invites/${inv.id}/rsvp`, { partstat: 'ACCEPTED' })).statusCode).toBe(200);
  });
});
