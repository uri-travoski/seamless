/** T5.4 F-38: lead capture. Parser fixtures, AI fallback, phones, dedupe, reply routing, response time, isolation. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async () => ({ messageId: 'ok' }), verify: async () => true }) } };
});

const { q, one, run, insertId } = await import('../src/db.ts');
const { parseLead, normaliseAuPhone } = await import('../src/leads/parse.ts');
const { setLeadExtractorForTests, markLeadReplies } = await import('../src/leads/leads.ts');
const { sendEmail } = await import('../src/mail/send.ts');
const { subscribeEvents } = await import('../src/events/emit.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

const FIX = path.join(import.meta.dirname, 'fixtures/leads');
const fixtures = fs.readdirSync(FIX).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')));

describe('lead parser fixtures', () => {
  it('has a fixture for every common form source', () => {
    expect(fixtures.map((f) => f.name).sort()).toEqual(['contact-form-7', 'elementor', 'facebook-lead-ads', 'google-ads', 'gravity-forms', 'squarespace', 'wix', 'wordpress-default', 'wpforms']);
  });
  for (const fx of fixtures) {
    it(`parses ${fx.name}`, () => {
      const f = parseLead({ text: fx.text, html: fx.html, replyTo: fx.replyTo });
      const e = fx.expect;
      if (e.name) expect(f.name).toBe(e.name);
      if (e.email) expect(f.email).toBe(e.email);
      if (e.phone) expect(f.phone).toBe(e.phone);
      if (e.suburb) expect(f.suburb).toBe(e.suburb);
      if (e.service) expect(f.service).toBe(e.service);
      if (e.budget) expect(f.budget).toBe(e.budget);
      if (e.sourcePage) expect(f.sourcePage).toBe(e.sourcePage);
      if (e.message_has) expect(f.message).toContain(e.message_has);
      if (e.utm_source) expect(f.utm.utm_source).toBe(e.utm_source);
    });
  }
  it('keeps multi-line messages together and stops at the footer', () => {
    const f = parseLead({ text: 'Name: A B\nEmail: a@b.example\nMessage:\nline one\nline two\n-- \nThis e-mail was sent from a contact form' });
    expect(f.message).toBe('line one\nline two');
  });
});

describe('normaliseAuPhone', () => {
  const table: [string, string][] = [
    ['0412 345 678', '+61412345678'], ['0412345678', '+61412345678'], ['(08) 9381 1234', '+61893811234'], ['08 9381 1234', '+61893811234'],
    ['02 9999 8888', '+61299998888'], ['+61 412 345 678', '+61412345678'], ['61412345678', '+61412345678'], ['+44 20 7946 0958', '+442079460958'],
    ['13 12 34', '13 12 34'], ['9381 1234', '9381 1234'],
  ];
  for (const [i, o] of table) it(`${i} → ${o}`, () => expect(normaliseAuPhone(i)).toBe(o));
});

let A: number, B: number, acctA: number, inboxA: number, sentA: number, acctB: number, inboxB: number;
let app: Awaited<ReturnType<typeof makeApp>>;
let cka = '', ckb = '';
const api = (ck: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck } });
const events: any[] = [];
subscribeEvents(async (ev) => { events.push(ev); });

const form = (opts: { email?: string; phone?: string; name?: string; subject?: string; to?: string; from?: string } = {}) => ingest(acctA, inboxA, rawEmail({
  from: opts.from ?? 'WordPress <wordpress@officecleaners.com.au>', to: opts.to ?? 'a@demo.test', subject: opts.subject ?? 'New quote request',
  body: `Name: ${opts.name ?? 'Jane Citizen'}\nEmail: ${opts.email ?? 'jane@example.com'}\nPhone: ${opts.phone ?? '0412 345 678'}\nSuburb: Subiaco\nService: Office cleaning\nMessage: Weekly clean please`,
}), { isLive: true });

beforeEach(async () => {
  await resetDb(); resetLimiters(); events.length = 0; setLeadExtractorForTests();
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test');
  acctA = await makeAccount('a@demo.test', { userId: A });
  inboxA = await makeMailbox(acctA, 'INBOX', 'inbox'); sentA = await makeMailbox(acctA, 'Sent', 'sent');
  acctB = await makeAccount('b@demo.test', { userId: B }); inboxB = await makeMailbox(acctB, 'INBOX', 'inbox');
  app = await makeApp(); cka = await login(app, 'a@x.test'); ckb = await login(app, 'b@x.test');
});

async function source(ck = cka, body: any = {}) {
  const r = await api(ck, 'POST', '/api/lead-sources', { name: 'Office Cleaners site', query: 'from:wordpress@officecleaners.com.au subject:"New quote request"', ...body });
  expect(r.statusCode).toBe(200);
  return r.json();
}

describe('capture on ingest', () => {
  it('creates a lead from a matching form email, a contact for the lead (not the robot), and a lead.captured event', async () => {
    const biz = await insertId("INSERT INTO businesses(user_id, name, created_at) VALUES (?, 'Office Cleaners', 0)", [A]);
    await source(cka, { businessId: biz });
    await form();
    const l = (await api(cka, 'GET', '/api/leads')).json();
    expect(l.total).toBe(1);
    expect(l.items[0]).toMatchObject({ name: 'Jane Citizen', email: 'jane@example.com', phone: '+61412345678', suburb: 'Subiaco', service: 'Office cleaning', status: 'new', businessName: 'Office Cleaners', source: 'Office Cleaners site', repeatCount: 0 });
    const contacts = await q<any>("SELECT ce.email FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id WHERE c.user_id = ?", [A]);
    expect(contacts.map((c) => c.email)).toEqual(['jane@example.com']);
    const ev = events.find((e) => e.type === 'lead.captured');
    expect(ev.payload).toMatchObject({ email: 'jane@example.com', repeat: false, businessName: 'Office Cleaners' });
    const n = await q<any>("SELECT title FROM notifications WHERE user_id = ? AND type = 'lead.captured'", [A]);
    expect(n[0].title).toContain('Jane Citizen');
  });
  it('ignores mail that matches no source, disabled sources, and non-live (backfilled) mail', async () => {
    const s = await source();
    await form({ subject: 'Something else' });
    await api(cka, 'PUT', `/api/lead-sources/${s.id}`, { enabled: false });
    await form();
    await api(cka, 'PUT', `/api/lead-sources/${s.id}`, { enabled: true });
    await ingest(acctA, inboxA, rawEmail({ from: 'WordPress <wordpress@officecleaners.com.au>', to: 'a@demo.test', subject: 'New quote request', body: 'Email: x@y.example' }), { isLive: false });
    expect((await api(cka, 'GET', '/api/leads')).json().total).toBe(0);
  });
  it('merges a duplicate (same email or phone, within 30 days) and shows a repeat count', async () => {
    await source();
    await form();
    await form({ phone: '0400 000 000' });                                       // same email
    await form({ email: 'other@example.com', phone: '0412345678', name: 'J C' });   // same phone, normalised
    const l = (await api(cka, 'GET', '/api/leads')).json();
    expect(l.total).toBe(1);
    expect(l.items[0].repeatCount).toBe(2);
    expect(events.filter((e) => e.type === 'lead.captured').map((e) => e.payload.repeat)).toEqual([false, true, true]);
  });
  it('does not merge with a lead older than 30 days', async () => {
    await source();
    await form();
    await run('UPDATE leads SET created_at = created_at - ?', [31 * 86_400_000]);
    await form();
    expect((await api(cka, 'GET', '/api/leads')).json().total).toBe(2);
  });
  it('falls back to Reply-To for the email when the body has none (never the form robot)', async () => {
    await source();
    await ingest(acctA, inboxA, Buffer.from(['From: WordPress <wordpress@officecleaners.com.au>', 'To: a@demo.test', 'Reply-To: Zed <zed@lead.example>', 'Subject: New quote request',
      'Message-ID: <rt1@test>', 'Date: Wed, 08 Jul 2026 10:00:00 +0000', 'Content-Type: text/plain', '', 'Name: Zed', 'Message: hi'].join('\r\n')), { isLive: true });
    expect((await api(cka, 'GET', '/api/leads')).json().items[0].email).toBe('zed@lead.example');
  });
});

describe('AI fallback', () => {
  it('is not called when the parser finds an email or phone', async () => {
    const ai = vi.fn(async () => null); setLeadExtractorForTests(ai);
    await source(); await form();
    expect(ai).not.toHaveBeenCalled();
  });
  it('is called once when neither is found, and fills the lead', async () => {
    const ai = vi.fn(async () => ({ name: 'Ann', email: 'ann@ai.example', phone: '0411 222 333', suburb: 'Perth', service: 'Carpets', message: 'help', utm: { utm_source: 'g' } }));
    setLeadExtractorForTests(ai);
    await source();
    await ingest(acctA, inboxA, rawEmail({ from: 'WordPress <wordpress@officecleaners.com.au>', to: 'a@demo.test', subject: 'New quote request', body: 'A weird free-text submission with nothing labelled.' }), { isLive: true });
    expect(ai).toHaveBeenCalledTimes(1);
    expect((await api(cka, 'GET', '/api/leads')).json().items[0]).toMatchObject({ name: 'Ann', email: 'ann@ai.example', phone: '+61411222333' });
  });
  it('with no AI available the lead is still stored (no contact details)', async () => {
    setLeadExtractorForTests(async () => null);
    await source();
    await ingest(acctA, inboxA, rawEmail({ from: 'WordPress <wordpress@officecleaners.com.au>', to: 'a@demo.test', subject: 'New quote request', body: 'nothing here' }), { isLive: true });
    expect((await api(cka, 'GET', '/api/leads')).json().total).toBe(1);
  });
});

describe('status, reply and response time', () => {
  it('changes status inline, filters, and rejects unknown statuses', async () => {
    await source(); await form();
    const id = (await api(cka, 'GET', '/api/leads')).json().items[0].id;
    expect((await api(cka, 'PATCH', `/api/leads/${id}`, { status: 'won' })).json().status).toBe('won');
    expect((await api(cka, 'PATCH', `/api/leads/${id}`, { status: 'bogus' })).statusCode).toBe(400);
    expect((await api(cka, 'GET', '/api/leads?status=new')).json().total).toBe(0);
    expect((await api(cka, 'GET', '/api/leads?status=won&service=office%20cleaning')).json().total).toBe(1);
  });
  it('reply draft is addressed to the lead and uses the business identity', async () => {
    const biz = await insertId("INSERT INTO businesses(user_id, name, created_at) VALUES (?, 'Office Cleaners', 0)", [A]);
    await run("UPDATE identities SET business_id = ? WHERE account_id = ?", [biz, acctA]);
    await source(cka, { businessId: biz }); await form();
    const id = (await api(cka, 'GET', '/api/leads')).json().items[0].id;
    const d = (await api(cka, 'GET', `/api/leads/${id}/reply`)).json();
    expect(d.to).toEqual([{ name: 'Jane Citizen', email: 'jane@example.com' }]);
    expect(d.fromEmail).toBe('a@demo.test');
    expect(d.subject).toMatch(/^Re: /);
    expect(JSON.stringify(d)).not.toContain('officecleaners.com.au');
  });
  it('first_reply_at is stamped when a message is sent to the lead, and feeds the stats', async () => {
    await source(); await form();
    const lead = (await api(cka, 'GET', '/api/leads')).json().items[0];
    await run('UPDATE leads SET created_at = ? WHERE id = ?', [Date.now() - 600_000, lead.id]);   // lead arrived 10 minutes ago
    await sendEmail(A, { accountId: acctA, fromEmail: 'a@demo.test', to: [{ name: '', email: 'JANE@example.com' }], cc: [], bcc: [], subject: 'Re: quote', html: '<p>hi</p>', attachmentIds: [], track: false });
    const after = (await api(cka, 'GET', `/api/leads/${lead.id}`)).json();
    expect(after.firstReplyAt).toBeGreaterThan(Date.now() - 5_000);
    expect(after.status).toBe('contacted');
    const first = after.firstReplyAt;
    await sendEmail(A, { accountId: acctA, fromEmail: 'a@demo.test', to: [{ name: '', email: 'jane@example.com' }], cc: [], bcc: [], subject: 'again', html: '<p>hi</p>', attachmentIds: [], track: false });
    expect((await api(cka, 'GET', `/api/leads/${lead.id}`)).json().firstReplyAt).toBe(first);   // only the first reply counts
    const stats = (await api(cka, 'GET', '/api/leads/stats')).json().items;
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ count: 1, won: 0, wonPct: 0, replied: 1 });
    expect(stats[0].medianFirstReplyMs).toBeGreaterThan(590_000);
    expect(stats[0].medianFirstReplyMs).toBeLessThan(620_000);
  });
  it('a Sent-folder copy ingested later also stamps the reply (reply from another client)', async () => {
    await source(); await form();
    await ingest(acctA, sentA, rawEmail({ from: 'a@demo.test', to: 'jane@example.com', subject: 'Re: quote', date: new Date(Date.now() + 60_000).toUTCString() }), { isLive: true });
    expect((await api(cka, 'GET', '/api/leads')).json().items[0].firstReplyAt).not.toBeNull();
  });
  it('mail sent before the lead existed does not count as a reply', async () => {
    await source(); await form();
    const id = (await api(cka, 'GET', '/api/leads')).json().items[0].id;
    expect(await markLeadReplies(A, ['jane@example.com'], Date.now() - 86_400_000)).toBe(0);
    expect((await api(cka, 'GET', `/api/leads/${id}`)).json().firstReplyAt).toBeNull();
  });
});

describe('sources editor', () => {
  it('"test against recent mail" returns matches with parsed fields', async () => {
    await form();   // before any source exists
    const r = (await api(cka, 'POST', '/api/lead-sources/test', { query: 'from:wordpress@officecleaners.com.au' })).json();
    expect(r.total).toBe(1);
    expect(r.matches[0].fields).toMatchObject({ email: 'jane@example.com', phone: '+61412345678' });
    expect((await api(cka, 'GET', '/api/leads')).json().total).toBe(0);   // testing creates nothing
    expect((await api(cka, 'POST', '/api/lead-sources/test', { query: '' })).statusCode).toBe(400);
  });
  it('validates input and rejects another user\'s business', async () => {
    const bizB = await insertId("INSERT INTO businesses(user_id, name, created_at) VALUES (?, 'Other', 0)", [B]);
    expect((await api(cka, 'POST', '/api/lead-sources', { name: '', query: 'x' })).statusCode).toBe(400);
    expect((await api(cka, 'POST', '/api/lead-sources', { name: 'n', query: 'x', businessId: bizB })).statusCode).toBe(400);
  });
});

describe('isolation', () => {
  it('user B cannot read, change or delete user A\'s sources and leads, and A\'s sources do not capture B\'s mail', async () => {
    const s = await source(); await form();
    const id = (await api(cka, 'GET', '/api/leads')).json().items[0].id;
    expect((await api(ckb, 'GET', '/api/leads')).json().total).toBe(0);
    expect((await api(ckb, 'GET', `/api/leads/${id}`)).statusCode).toBe(404);
    expect((await api(ckb, 'PATCH', `/api/leads/${id}`, { status: 'won' })).statusCode).toBe(404);
    expect((await api(ckb, 'GET', `/api/leads/${id}/reply`)).statusCode).toBe(404);
    expect((await api(ckb, 'DELETE', `/api/leads/${id}`)).statusCode).toBe(404);
    expect((await api(ckb, 'GET', '/api/lead-sources')).json().items).toHaveLength(0);
    expect((await api(ckb, 'PUT', `/api/lead-sources/${s.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await api(ckb, 'DELETE', `/api/lead-sources/${s.id}`)).statusCode).toBe(404);
    expect((await api(ckb, 'GET', '/api/leads/stats')).json().items).toEqual([]);
    await ingest(acctB, inboxB, rawEmail({ from: 'WordPress <wordpress@officecleaners.com.au>', to: 'b@demo.test', subject: 'New quote request', body: 'Email: q@r.example' }), { isLive: true });
    expect((await api(ckb, 'GET', '/api/leads')).json().total).toBe(0);
    expect((await api(cka, 'GET', `/api/leads/${id}`)).statusCode).toBe(200);
  });
  it('a reply by user B to the same address does not stamp A\'s lead', async () => {
    await source(); await form();
    expect(await markLeadReplies(B, ['jane@example.com'], Date.now() + 1000)).toBe(0);
  });
});
