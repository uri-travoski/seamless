import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';

const sent: { envelope: any; raw: Buffer }[] = [];
const transportsUsed: string[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: (o: any) => ({
    sendMail: async (m: any) => { transportsUsed.push(o?.host ?? ''); sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { q, one, run } = await import('../src/db.ts');
const { queryEmails } = await import('../src/mail/store.ts');
const { checkWrongBusiness } = await import('../src/business/guard.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let acct: number;
let inbox: number;
let sentBox: number;
let ocr: number; let swan: number;       // business ids
let infoId: number; let mainId: number;  // identity ids (info@ → OCR, alice@ → Swan)

const api = (method: any, url: string, body?: any, ck = cookie) => app.inject({ method, url, payload: body, headers: { cookie: ck } });
const raw = () => sent[sent.length - 1].raw.toString();

beforeEach(async () => {
  await resetDb(); resetLimiters(); sent.length = 0; transportsUsed.length = 0;
  acct = await makeAccount('alice@demo.test', { aliases: ['info@demo.test'], name: 'Alice' });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  sentBox = await makeMailbox(acct, 'Sent', 'sent');
  app = await makeApp(); cookie = await login(app);
  ocr = (await api('POST', '/api/businesses', { name: 'Office Cleaners R Us', phone: '0400' })).json().id;
  swan = (await api('POST', '/api/businesses', { name: 'Swan Office Cleaners' })).json().id;
  const ids = (await api('GET', '/api/identities')).json();
  infoId = ids.find((i: any) => i.email === 'info@demo.test').id;
  mainId = ids.find((i: any) => i.email === 'alice@demo.test').id;
  await api('PUT', `/api/identities/${infoId}`, { businessId: ocr, displayName: 'OCR Team', replyTo: 'office@demo.test', bccSelf: true, signatureHtml: '<p>OCR {{business.phone}}</p>' });
  await api('PUT', `/api/identities/${mainId}`, { businessId: swan });
});

const payload = (over: any = {}) => ({
  accountId: acct, fromEmail: 'alice@demo.test', to: [{ name: '', email: 'bob@client.com.au' }], cc: [], bcc: [],
  subject: 'Hi', html: '<p>hi</p>', attachmentIds: [], track: false, ...over,
});

async function sendHistory(from: string, to: string, n: number) {
  for (let i = 0; i < n; i++) await ingest(acct, sentBox, rawEmail({ from, to, subject: `s${i}-${from}-${to}`, date: 'Wed, 08 Jul 2026 10:00:00 +0000' }), { flags: ['\\Seen'] });
}

describe('F-30 identity send', () => {
  it('uses the identity display name, reply-to and bcc-self, and its address', async () => {
    const { sendEmail } = await import('../src/mail/send.ts');
    await sendEmail(TEST_USER, payload({ identityId: infoId, fromEmail: 'ignored@x.test' }));
    const r = raw();
    expect(r).toMatch(/From: "?OCR Team"? <info@demo.test>/);
    expect(r).toContain('Reply-To: office@demo.test');
    expect(sent[0].envelope.to).toContain('info@demo.test'); // bcc-self
    expect(sent[0].envelope.from).toBe('info@demo.test');
  });

  it('old payloads without identityId still send from fromEmail with the account name', async () => {
    const { sendEmail } = await import('../src/mail/send.ts');
    await sendEmail(TEST_USER, payload({ fromEmail: 'info@demo.test' }));
    expect(raw()).toMatch(/From: "?Alice"? <info@demo.test>/);
    expect(raw()).not.toContain('Reply-To');
    expect(sent[0].envelope.to).not.toContain('info@demo.test');
  });

  it('refuses an identity of another mailbox or user', async () => {
    const { sendEmail } = await import('../src/mail/send.ts');
    const other = await makeUser('b@local');
    const bAcct = await makeAccount('bob@demo.test', { userId: other });
    const bIdent = (await one<any>('SELECT id FROM identities WHERE account_id = ?', [bAcct]))!.id;
    await expect(sendEmail(TEST_USER, payload({ identityId: bIdent }))).rejects.toThrow(/Unknown identity/);
  });

  it('the identity transport override wins over the account SMTP', async () => {
    const { sendEmail } = await import('../src/mail/send.ts');
    const t = await api('POST', '/api/transports', { name: 'Relay', kind: 'smtp', config: { host: 'relay.override.test', port: 587, secure: false, user: 'u', pass: 'p' } });
    expect(t.statusCode).toBe(200);
    await api('PUT', `/api/identities/${infoId}`, { transportId: t.json().id });
    await sendEmail(TEST_USER, payload({ identityId: infoId }));
    await sendEmail(TEST_USER, payload({ identityId: mainId }));
    expect(transportsUsed).toEqual(['relay.override.test', 'smtp.test']);
  });

  it('a signature logo URL in the editor html becomes a CID attachment', async () => {
    const { sendEmail } = await import('../src/mail/send.ts');
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const { setLogo } = await import('../src/business/businesses.ts');
    await setLogo(TEST_USER, ocr, PNG);
    await sendEmail(TEST_USER, payload({ identityId: infoId, html: `<div data-seamless-signature><img src="/api/businesses/${ocr}/logo"></div>` }));
    expect(raw()).toContain(`Content-ID: <logo-${ocr}>`);
    expect(raw()).not.toContain('/api/businesses/');
  });

  it('GET /api/identities/:id/signature renders a replaceable block', async () => {
    const res = (await api('GET', `/api/identities/${infoId}/signature`)).json();
    expect(res.html).toBe('<div data-seamless-signature><p>OCR 0400</p></div>');
    expect((await api('GET', `/api/identities/${mainId}/signature`)).json().html).toBe('');
  });
});

describe('F-30 reply picks the delivered-to identity', () => {
  it('returns the alias identity with its business and signature', async () => {
    await ingest(acct, inbox, rawEmail({ from: 'Client <c@client.com.au>', to: 'info@demo.test', subject: 'Quote?', deliveredTo: 'info@demo.test' }));
    const id = (await q<any>('SELECT id FROM messages'))[0].id;
    const m = (await api('POST', '/api/identity/match', { emailId: `m${id}` })).json();
    expect(m).toMatchObject({ email: 'info@demo.test', id: infoId, businessId: ocr, name: 'OCR Team', replyTo: 'office@demo.test', isAlias: true });
    expect(m.signatureHtml).toContain('OCR');
  });

  it('falls back to the account default when nothing matches', async () => {
    await ingest(acct, inbox, rawEmail({ from: 'c@client.com.au', to: 'list@elsewhere.test', subject: 'Hello' }));
    const id = (await q<any>('SELECT id FROM messages'))[0].id;
    const m = (await api('POST', '/api/identity/match', { emailId: `m${id}` })).json();
    expect(m).toMatchObject({ email: 'alice@demo.test', id: mainId });
  });
});

describe('F-30 wrong-business guard', () => {
  it('fires when ≥3 of the sends to a domain came from another business (≥70%)', async () => {
    await sendHistory('alice@demo.test', 'bob@client.com.au', 3);
    const w = await checkWrongBusiness(TEST_USER, infoId, ['bob@client.com.au']);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ domain: 'client.com.au', usualBusiness: 'Swan Office Cleaners', currentBusiness: 'Office Cleaners R Us', sends: 3, switchIdentityId: mainId });
    expect(w[0].message).toBe('You usually email @client.com.au from Swan Office Cleaners. Send from Office Cleaners R Us anyway?');
    // the HTTP endpoint
    const res = (await api('POST', '/api/compose/check', { identityId: infoId, to: [{ email: 'bob@client.com.au' }] })).json();
    expect(res.warnings).toHaveLength(1);
  });

  it('is quiet when sending from the usual business, below 3 sends, below 70%, or without a business', async () => {
    await sendHistory('alice@demo.test', 'bob@client.com.au', 2);
    expect(await checkWrongBusiness(TEST_USER, infoId, ['bob@client.com.au'])).toEqual([]);  // only 2
    await sendHistory('alice@demo.test', 'bob@client.com.au', 1);
    expect(await checkWrongBusiness(TEST_USER, mainId, ['bob@client.com.au'])).toEqual([]);  // usual business
    await sendHistory('info@demo.test', 'bob@client.com.au', 2);                              // 3 of 5 = 60%
    expect(await checkWrongBusiness(TEST_USER, infoId, ['bob@client.com.au'])).toEqual([]);
    await run('UPDATE identities SET business_id = NULL WHERE id = ?', [infoId]);
    expect(await checkWrongBusiness(TEST_USER, infoId, ['bob@client.com.au'])).toEqual([]);
  });

  it('skips free-mail domains and contacts with the guard turned off', async () => {
    await sendHistory('alice@demo.test', 'pal@gmail.com', 5);
    expect(await checkWrongBusiness(TEST_USER, infoId, ['pal@gmail.com'])).toEqual([]);
    await sendHistory('alice@demo.test', 'bob@client.com.au', 4);
    expect(await checkWrongBusiness(TEST_USER, infoId, ['bob@client.com.au'])).toHaveLength(1);
    const cid = (await one<any>("INSERT INTO contacts(user_id, display_name, created_at, updated_at) VALUES (?,?,?,?) RETURNING id", [TEST_USER, 'Bob', 1, 1]))!.id;
    await run('INSERT INTO contact_emails(contact_id, email) VALUES (?,?)', [cid, 'bob@client.com.au']);
    const put = await api('PUT', `/api/contacts/${cid}`, { displayName: 'Bob', noBusinessGuard: true });
    expect(put.statusCode).toBe(200);
    expect(await checkWrongBusiness(TEST_USER, infoId, ['bob@client.com.au'])).toEqual([]);
  });

  it("only counts the user's own history and identities", async () => {
    await sendHistory('alice@demo.test', 'bob@client.com.au', 5);
    const other = await makeUser('b@local');
    const bAcct = await makeAccount('bob@demo.test', { userId: other });
    const bBiz = (await one<any>("INSERT INTO businesses(user_id, name, created_at) VALUES (?,?,?) RETURNING id", [other, 'B Biz', 1]))!.id;
    const bIdent = (await one<any>('SELECT id FROM identities WHERE account_id = ?', [bAcct]))!.id;
    await run('UPDATE identities SET business_id = ? WHERE id = ?', [bBiz, bIdent]);
    expect(await checkWrongBusiness(other, bIdent, ['bob@client.com.au'])).toEqual([]);   // A's history is invisible
    expect(await checkWrongBusiness(other, infoId, ['bob@client.com.au'])).toEqual([]);   // A's identity is not theirs
  });
});

describe('F-30 business: search', () => {
  it('finds mail delivered to an identity of the business or in its mailbox; other users see nothing', async () => {
    const other = await makeAccount('carol@demo.test', { name: 'Carol' });
    const oIn = await makeMailbox(other, 'INBOX', 'inbox');
    const cIdent = (await one<any>('SELECT id FROM identities WHERE account_id = ?', [other]))!.id;
    const tmp = (await api('POST', '/api/businesses', { name: 'Carols' })).json().id;
    await api('PUT', `/api/identities/${cIdent}`, { businessId: tmp });
    await ingest(other, oIn, rawEmail({ from: 'x@y.test', to: 'carol@demo.test', subject: 'for carol' }));
    await ingest(acct, inbox, rawEmail({ from: 'x@y.test', to: 'info@demo.test', subject: 'for info', deliveredTo: 'info@demo.test' }));
    const search = async (text: string, user = TEST_USER) => (await queryEmails(user, { filter: { text }, position: 0, limit: 20 })).total;
    // account alice has identities in both OCR (info@) and Swan (alice@)
    expect(await search('business:"Office Cleaners R Us"')).toBe(1);
    expect(await search('business:"office cleaners r us" info')).toBe(1);
    expect(await search('business:"Carols"')).toBe(1);
    expect(await search('business:"Nope"')).toBe(0);
    const u2 = await makeUser('b@local');
    expect(await search('business:"Carols"', u2)).toBe(0);
  });
});
