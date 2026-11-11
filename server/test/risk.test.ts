import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, TEST_USER, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';
import { makeApp, resetLimiters, login } from './app.ts';
import { assessRisk, registrable, skeleton, damerau, type RiskInput } from '../src/mail/risk.ts';
import { q, one, run } from '../src/db.ts';
import { getEmails, queryEmails } from '../src/mail/store.ts';

const app = await makeApp();
afterAll(() => app.close());

const base = (over: Partial<RiskInput> = {}): RiskInput => ({
  fromAddr: 'sam@shop.com', fromName: 'Sam', replyTo: [], auth: {}, subject: 'Hello', text: 'Just saying hi.', html: null,
  attachments: [], ownDomains: ['officecleaners.com.au'], contactDomains: ['paypal.com', 'acmecleaning.test'],
  knownContactNames: new Map(), firstTimeSender: false, knownContact: true, trusted: false, ...over,
});
const codes = (i: RiskInput) => assessRisk(i).reasons.map((r) => r.code);

describe('F-20 helpers', () => {
  it('registrable domains and skeletons', () => {
    expect(registrable('mail.example.com.au')).toBe('example.com.au');
    expect(registrable('a.b.example.com')).toBe('example.com');
    expect(skeleton('pаypal.com')).toBe(skeleton('paypal.com'));       // Cyrillic а
    expect(skeleton('0fficecleaners.com.au')).toBe(skeleton('officecleaners.com.au'));
    expect(damerau('paypal', 'paypla')).toBe(1);
  });
});

describe('F-20 rules (pure)', () => {
  it('auth_fail', () => {
    expect(codes(base({ auth: { dmarc: 'fail' } }))).toContain('auth_fail');
    expect(codes(base({ auth: { spf: 'fail', dkim: 'fail' } }))).toContain('auth_fail');
    expect(codes(base({ auth: { spf: 'fail', dkim: 'pass' } }))).not.toContain('auth_fail');
  });
  it('display_spoof: name shows another domain, or a contact’s name from a new address', () => {
    expect(codes(base({ fromName: 'PayPal support@paypal.com', fromAddr: 'x@evil.test' }))).toContain('display_spoof');
    expect(codes(base({ fromName: 'Priya Shah', fromAddr: 'priya@other.test', knownContactNames: new Map([['priya shah', ['priya@acmecleaning.test']]]) }))).toContain('display_spoof');
    expect(codes(base({ fromName: 'Priya Shah', fromAddr: 'priya@acmecleaning.test', knownContactNames: new Map([['priya shah', ['priya@acmecleaning.test']]]) }))).not.toContain('display_spoof');
  });
  it('lookalike: typo, digit swap and Cyrillic', () => {
    expect(codes(base({ fromAddr: 'a@0fficecleaners.com.au' }))).toContain('lookalike');
    expect(codes(base({ fromAddr: 'a@acmec1eaning.test' }))).toContain('lookalike');
    expect(codes(base({ fromAddr: 'a@pаypal.com' }))).toContain('lookalike');
    expect(codes(base({ fromAddr: 'a@paypal.com' }))).not.toContain('lookalike');          // the real one
    expect(codes(base({ fromAddr: 'a@somethingelse.com' }))).not.toContain('lookalike');
  });
  it('first_time_money and bank_change', () => {
    expect(codes(base({ firstTimeSender: true, knownContact: false, text: 'Please pay the overdue invoice' }))).toContain('first_time_money');
    expect(codes(base({ firstTimeSender: false, text: 'invoice attached' }))).not.toContain('first_time_money');
    expect(codes(base({ knownContact: false, text: 'Our new bank details: BSB 123-456' }))).toContain('bank_change');
    expect(codes(base({ knownContact: true, text: 'Our new bank details: BSB 123-456' }))).not.toContain('bank_change');
  });
  it('reply_to_mismatch ignores mail services', () => {
    expect(codes(base({ replyTo: ['boss@gmail.com'] }))).toContain('reply_to_mismatch');
    expect(codes(base({ fromAddr: 'news@shop.com', replyTo: ['reply@mcsv.net'] }))).not.toContain('reply_to_mismatch');
    expect(assessRisk(base({ fromAddr: 'news@shop.com', replyTo: ['reply@mcsv.net'] })).level).not.toBe('high');
  });
  it('bad_attachment', () => {
    expect(codes(base({ attachments: [{ filename: 'invoice.html', contentType: 'text/html' }] }))).toContain('bad_attachment');
    expect(codes(base({ attachments: [{ filename: 'q.xlsm', contentType: '' }] }))).toContain('bad_attachment');
    expect(codes(base({ attachments: [{ filename: 'a.zip', contentType: '' }], text: 'password is 1234' }))).toContain('bad_attachment');
    expect(codes(base({ attachments: [{ filename: 'a.zip', contentType: '' }] }))).not.toContain('bad_attachment');
    expect(codes(base({ attachments: [{ filename: 'photo.jpg', contentType: 'image/jpeg' }] }))).toEqual([]);
  });
  it('link_mismatch', () => {
    expect(codes(base({ html: '<a href="http://evil.test/x">www.mybank.com</a>' }))).toContain('link_mismatch');
    expect(codes(base({ html: '<a href="https://mybank.com/login">www.mybank.com</a>' }))).not.toContain('link_mismatch');
    expect(codes(base({ html: '<a href="https://click.mailchimp.com/a">shop.com/sale</a>' }))).not.toContain('link_mismatch');
  });
  it('trusted sender skips everything; scoring and levels', () => {
    expect(assessRisk(base({ trusted: true, auth: { dmarc: 'fail' } })).level).toBe('none');
    const hi = assessRisk(base({ auth: { dmarc: 'fail' }, replyTo: ['x@gmail.com'] }));
    expect(hi.level).toBe('high');
    expect(hi.score).toBe(85);
    expect(assessRisk(base({ replyTo: ['x@gmail.com'] })).level).toBe('medium');
  });
});

describe('F-20 stored at ingest', () => {
  let acct: number, inbox: number;
  beforeEach(async () => {
    await resetDb(); resetLimiters();
    acct = await makeAccount('alice@officecleaners.com.au');
    inbox = await makeMailbox(acct, 'INBOX', 'inbox');
    await makeMailbox(acct, 'Junk', 'junk');
    await makeMailbox(acct, 'Sent', 'sent');
  });
  const risk = async (subject: string) => (await one<any>('SELECT r.* FROM message_risk r JOIN messages m ON m.id = r.message_id WHERE m.subject = ?', [subject]));

  it('flags a lookalike of your own domain and shows it in the API and in risk: search', async () => {
    await ingest(acct, inbox, rawEmail({ from: 'Accounts <pay@0fficecleaners.com.au>', to: 'alice@officecleaners.com.au', subject: 'Update bank details', body: 'Please use our new bank details. BSB 062-000' }));
    const r = await risk('Update bank details');
    expect(r.level).toBe('high');
    expect(r.reasons.map((x: any) => x.code)).toEqual(expect.arrayContaining(['lookalike', 'bank_change']));
    const id = (await one<any>('SELECT id FROM messages WHERE subject = ?', ['Update bank details'])).id;
    expect((await getEmails(TEST_USER, [`m${id}`]))[0].risk?.level).toBe('high');
    expect((await queryEmails(TEST_USER, { filter: { text: 'risk:high' }, position: 0, limit: 10 })).ids).toEqual([`m${id}`]);
  });

  it('a Cyrillic а in paypal.com is flagged against a contact you have written to', async () => {
    const cid = (await q<any>("INSERT INTO contacts(user_id, display_name, sent_count, created_at, updated_at) VALUES (?, 'PayPal', 3, 1, 1) RETURNING id", [TEST_USER]))[0].id;
    await run("INSERT INTO contact_emails(contact_id, email, is_primary) VALUES (?, 'service@paypal.com', true)", [cid]);
    await ingest(acct, inbox, rawEmail({ from: 'PayPal <service@pаypal.com>', to: 'alice@officecleaners.com.au', subject: 'Your account', body: 'hello' }));
    expect((await risk('Your account')).reasons.map((x: any) => x.code)).toContain('lookalike');
  });

  it('sent mail is never assessed; a newsletter with an ESP Reply-To is not high', async () => {
    const sentBox = (await one<any>("SELECT id FROM mailboxes WHERE role = 'sent'")).id;
    await ingest(acct, sentBox, rawEmail({ from: 'alice@officecleaners.com.au', to: 'bob@x.test', subject: 'Sent one' }));
    expect(await risk('Sent one')).toBeUndefined();
    await ingest(acct, inbox, rawEmail({ from: 'Shop <news@shop.com>', to: 'alice@officecleaners.com.au', subject: 'Weekly deals', body: 'Invoice-free deals!' }));
    expect((await risk('Weekly deals')).level).not.toBe('high');
  });

  it('HTTP: mark safe trusts the sender; report moves to Junk; trusted list is per user', async () => {
    const cookie = await login(app);
    await ingest(acct, inbox, rawEmail({ from: 'pay@0fficecleaners.com.au', to: 'alice@officecleaners.com.au', subject: 'Suspicious', body: 'hi' }));
    const id = (await one<any>('SELECT id FROM messages WHERE subject = ?', ['Suspicious'])).id;
    expect((await risk('Suspicious')).level).toBe('high');
    const safe = await app.inject({ method: 'POST', url: `/api/risk/m${id}/safe`, headers: { cookie } });
    expect(safe.statusCode).toBe(200);
    expect((await risk('Suspicious')).level).toBe('none');
    await ingest(acct, inbox, rawEmail({ from: 'pay@0fficecleaners.com.au', to: 'alice@officecleaners.com.au', subject: 'Second', body: 'hi' }));
    expect((await risk('Second')).level).toBe('none');            // address is trusted now
    const list = await app.inject({ method: 'GET', url: '/api/trusted-senders', headers: { cookie } });
    expect(list.json()).toHaveLength(1);
    await ingest(acct, inbox, rawEmail({ from: 'x@bad.test', to: 'alice@officecleaners.com.au', subject: 'Report me', body: 'hi' }));
    const rid = (await one<any>('SELECT id FROM messages WHERE subject = ?', ['Report me'])).id;
    const rep = await app.inject({ method: 'POST', url: `/api/risk/m${rid}/report`, headers: { cookie } });
    expect(rep.statusCode).toBe(200);
    expect((await one<any>('SELECT mb.role FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?', [rid])).role).toBe('junk');
    const other = await makeUser('b@x.test');
    expect(await q('SELECT 1 FROM trusted_senders WHERE user_id = ?', [other])).toHaveLength(0);
    const del = await app.inject({ method: 'DELETE', url: `/api/trusted-senders/${list.json()[0].id}`, headers: { cookie } });
    expect(del.statusCode).toBe(200);
  });

  it('false-positive guard: 200 ordinary messages produce no high-risk warning', async () => {
    const cid = (await q<any>("INSERT INTO contacts(user_id, display_name, sent_count, created_at, updated_at) VALUES (?, 'Pat', 5, 1, 1) RETURNING id", [TEST_USER]))[0].id;
    await run("INSERT INTO contact_emails(contact_id, email, is_primary) VALUES (?, 'pat@acmecleaning.test', true)", [cid]);
    const senders = ['news@shop.com', 'orders@bunnings.com.au', 'noreply@github.com', 'hello@canva.com', 'billing@xero.com', 'team@notion.so', 'pat@acmecleaning.test',
      'support@telstra.com.au', 'info@wa.gov.au', 'updates@linkedin.com', 'jo@gmail.com', 'ann@outlook.com', 'accounts@bigclient.com', 'bob@x.test'];
    const subjects = ['Your invoice #{n}', 'Weekly newsletter', 'Meeting tomorrow', 'Receipt for your payment', 'Quote request', 'Re: site visit', 'Your order has shipped', 'Welcome!'];
    for (let n = 0; n < 200; n++) {
      const from = senders[n % senders.length];
      const esp = n % 5 === 0 ? { html: `<p>Hi <a href="https://click.mailchimp.com/${n}">see the sale</a></p>` } : { body: `Hi, here is item ${n}. Thanks, see you soon.` };
      await ingest(acct, inbox, rawEmail({ from: `Someone <${from}>`, to: 'alice@officecleaners.com.au', subject: `${subjects[n % subjects.length].replace('{n}', String(n))} ${n}`, ...esp }));
    }
    expect(await q("SELECT 1 FROM message_risk WHERE level = 'high'")).toHaveLength(0);
  });
});
