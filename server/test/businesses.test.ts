import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, TEST_USER } from './helpers.ts';

const sent: { envelope: any; raw: Buffer }[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { sendEmail } = await import('../src/mail/send.ts');
const { q, one, run, MIGRATIONS } = await import('../src/db.ts');
const { renderSignature } = await import('../src/business/signature.ts');
const { syncAccountIdentities } = await import('../src/business/identities.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let acct: number;

beforeEach(async () => {
  await resetDb(); resetLimiters(); sent.length = 0;
  acct = await makeAccount('alice@demo.test', { aliases: ['info@demo.test', 'quotes@demo.test'], name: 'Alice' });
  await makeMailbox(acct, 'INBOX', 'inbox');
  app = await makeApp(); cookie = await login(app);
});

const api = (method: any, url: string, body?: any, ck = cookie) => app.inject({ method, url, payload: body, headers: { cookie: ck } });

function upload(url: string, data: Buffer, filename = 'logo.png', ck = cookie) {
  const b = '----x';
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data, Buffer.from(`\r\n--${b}--\r\n`)]);
  return app.inject({ method: 'POST', url, payload, headers: { cookie: ck, 'content-type': `multipart/form-data; boundary=${b}` } });
}

describe('F-30 identities backfill + sync', () => {
  it('the migration backfill creates an identity for the account and each alias', async () => {
    await run('DELETE FROM identities');
    await run("UPDATE accounts SET signature = '<p>Cheers</p>' WHERE id = ?", [acct]);
    const sql = MIGRATIONS.find((m) => m.id === 24)!.sql;
    await run(sql.slice(sql.indexOf('INSERT INTO identities')));
    const rows = await q<any>('SELECT * FROM identities WHERE account_id = ? ORDER BY is_default DESC, email', [acct]);
    expect(rows.map((r) => r.email)).toEqual(['alice@demo.test', 'info@demo.test', 'quotes@demo.test']);
    expect(rows[0]).toMatchObject({ is_default: true, display_name: 'Alice', signature_html: '<p>Cheers</p>' });
    expect(rows[1].is_default).toBe(false);
  });

  it('creating an account creates its identities; changing aliases adds and removes them', async () => {
    expect((await q('SELECT id FROM identities WHERE account_id = ?', [acct]))).toHaveLength(3);
    await run('UPDATE accounts SET aliases = ? WHERE id = ?', [JSON.stringify(['info@demo.test', 'new@demo.test']), acct]);
    await syncAccountIdentities(acct);
    const emails = (await q<any>('SELECT email FROM identities WHERE account_id = ? ORDER BY email', [acct])).map((r) => r.email);
    expect(emails).toEqual(['alice@demo.test', 'info@demo.test', 'new@demo.test']);
  });

  it('the accounts API keeps identities in sync', async () => {
    const acc = (await api('GET', '/api/accounts')).json().find((a: any) => a.id === acct);
    const res = await api('PUT', `/api/accounts/${acct}`, { ...acc, aliases: ['only@demo.test'], imapPass: '', smtpPass: '' });
    expect(res.statusCode).toBe(200);
    const emails = (await q<any>('SELECT email FROM identities WHERE account_id = ? ORDER BY email', [acct])).map((r) => r.email);
    expect(emails).toEqual(['alice@demo.test', 'only@demo.test']);
  });
});

describe('F-30 signature', () => {
  const biz: any = { id: 7, name: 'Office Cleaners R Us', phone: '0400 000 000', website: 'https://ocr.test', abn: '11 222 333 444', address: '1 High St\nPerth', logo_key: 'logo/1/x.png', default_signature_html: '', disclaimer_html: '<p>Confidential</p>' };
  it('renders every variable, the CID logo and the disclaimer', () => {
    const html = renderSignature(
      { email: 'info@ocr.test', display_name: 'Sam <S>', signature_html: '{{identity.name}} | {{identity.email}} | {{business.name}} | {{business.phone}} | {{business.website}} | {{business.abn}} | {{business.address}} {{logo}} {{unknown}}' }, biz);
    expect(html).toContain('Sam &lt;S&gt; | info@ocr.test | Office Cleaners R Us | 0400 000 000 | https://ocr.test | 11 222 333 444 | 1 High St<br>Perth');
    expect(html).toContain('<img src="cid:logo-7"');
    expect(html).toContain('{{unknown}}');
    expect(html.endsWith('<div class="disclaimer"><p>Confidential</p></div>')).toBe(true);
  });
  it('falls back to the business default when the identity has none', () => {
    const html = renderSignature({ email: 'a@b.c', display_name: 'A', signature_html: null }, { ...biz, default_signature_html: 'Hi {{business.name}}', disclaimer_html: '' });
    expect(html).toBe('Hi Office Cleaners R Us');
  });
});

describe('F-30 businesses API + logo', () => {
  async function mkBusiness(name = 'Office Cleaners R Us', ck = cookie) {
    const res = await api('POST', '/api/businesses', { name, brandColor: '#aa2200', phone: '123' }, ck);
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('CRUD + validation', async () => {
    expect((await api('POST', '/api/businesses', { name: '' })).statusCode).toBe(400);
    expect((await api('POST', '/api/businesses', { name: 'x', brandColor: 'red' })).statusCode).toBe(400);
    const b = await mkBusiness();
    const put = await api('PUT', `/api/businesses/${b.id}`, { website: 'https://x.test', defaultSignatureHtml: '<p>hi</p><script>x()</script>' });
    expect(put.json()).toMatchObject({ website: 'https://x.test', defaultSignatureHtml: '<p>hi</p>', name: 'Office Cleaners R Us' });
    expect((await api('GET', '/api/businesses')).json()).toHaveLength(1);
    expect((await api('DELETE', `/api/businesses/${b.id}`)).statusCode).toBe(200);
    expect((await api('GET', '/api/businesses')).json()).toHaveLength(0);
  });

  it('logo upload: accepts png, rejects oversize / unknown / scripted svg, serves it back', async () => {
    const b = await mkBusiness();
    expect((await upload(`/api/businesses/${b.id}/logo`, PNG)).statusCode).toBe(200);
    const got = await api('GET', `/api/businesses/${b.id}/logo`);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(Buffer.from(got.rawPayload).equals(PNG)).toBe(true);
    expect((await api('GET', '/api/businesses')).json()[0].hasLogo).toBe(true);
    expect((await upload(`/api/businesses/${b.id}/logo`, Buffer.from('hello'))).statusCode).toBe(400);
    expect((await upload(`/api/businesses/${b.id}/logo`, Buffer.concat([PNG, Buffer.alloc(600 * 1024)]))).statusCode).toBe(413);
    expect((await upload(`/api/businesses/${b.id}/logo`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).statusCode).toBe(400);
    expect((await upload(`/api/businesses/${b.id}/logo`, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>'))).statusCode).toBe(200);
    expect((await api('GET', `/api/businesses/${b.id}/logo`)).headers['content-type']).toBe('image/svg+xml');
  });

  it('identities can be assigned a business and edited; foreign ids are refused', async () => {
    const b = await mkBusiness();
    const ids = (await api('GET', '/api/identities')).json();
    const info = ids.find((i: any) => i.email === 'info@demo.test');
    expect(info.id).toBeTruthy();
    const res = await api('PUT', `/api/identities/${info.id}`, { businessId: b.id, displayName: 'OCR Info', replyTo: 'office@demo.test', bccSelf: true, isDefault: true });
    expect(res.statusCode).toBe(200);
    const after = (await api('GET', '/api/identities')).json();
    expect(after.find((i: any) => i.id === info.id)).toMatchObject({ businessId: b.id, name: 'OCR Info', replyTo: 'office@demo.test', bccSelf: true, isDefault: true });
    expect(after.filter((i: any) => i.isDefault && i.accountId === acct)).toHaveLength(1);
    expect((await api('PUT', `/api/identities/${info.id}`, { businessId: 9999 })).statusCode).toBe(400);
    expect((await api('PUT', `/api/identities/${info.id}`, { replyTo: 'nope' })).statusCode).toBe(400);
  });

  it('the logo becomes an inline CID attachment in the raw message', async () => {
    const b = await mkBusiness();
    await upload(`/api/businesses/${b.id}/logo`, PNG);
    await sendEmail(TEST_USER, {
      accountId: acct, fromEmail: 'alice@demo.test', to: [{ name: '', email: 'bob@x.test' }], cc: [], bcc: [],
      subject: 'Hi', html: `<p>hi</p><img src="cid:logo-${b.id}">`, attachmentIds: [], track: false,
    });
    expect(sent).toHaveLength(1);
    const raw = sent[0].raw.toString();
    expect(raw).toContain(`Content-ID: <logo-${b.id}>`);
    expect(raw).toMatch(/Content-Type: image\/png/);
  });

  it("another user's logo id is not attached", async () => {
    const other = await makeUser('b@local');
    const { createBusiness, setLogo } = await import('../src/business/businesses.ts');
    const bid = await createBusiness(other, { name: 'Theirs' });
    await setLogo(other, bid, PNG);
    await sendEmail(TEST_USER, {
      accountId: acct, fromEmail: 'alice@demo.test', to: [{ name: '', email: 'bob@x.test' }], cc: [], bcc: [],
      subject: 'Hi', html: `<img src="cid:logo-${bid}">`, attachmentIds: [], track: false,
    });
    expect(sent[0].raw.toString()).not.toContain(`Content-ID: <logo-${bid}>`);
  });
});

describe('F-30 isolation', () => {
  it("user B can't read or change A's businesses, logo or identities", async () => {
    const bid = (await api('POST', '/api/businesses', { name: 'A Biz' })).json().id;
    await upload(`/api/businesses/${bid}/logo`, PNG);
    const aIdent = (await q<any>('SELECT id FROM identities WHERE user_id = ?', [TEST_USER]))[0].id;

    await makeUser('b@local');
    const ckB = await login(app, 'b@local');
    const bAcct = await makeAccount('bob@demo.test', { userId: (await one<any>("SELECT id FROM users WHERE email = 'b@local'"))!.id });
    expect((await api('GET', '/api/businesses', undefined, ckB)).json()).toEqual([]);
    expect((await api('PUT', `/api/businesses/${bid}`, { name: 'hacked' }, ckB)).statusCode).toBe(404);
    expect((await api('DELETE', `/api/businesses/${bid}`, undefined, ckB)).statusCode).toBe(404);
    expect((await api('GET', `/api/businesses/${bid}/logo`, undefined, ckB)).statusCode).toBe(404);
    expect((await upload(`/api/businesses/${bid}/logo`, PNG, 'l.png', ckB)).statusCode).toBe(404);
    expect((await api('POST', `/api/businesses/${bid}/signature-preview`, {}, ckB)).statusCode).toBe(404);
    const idsB = (await api('GET', '/api/identities', undefined, ckB)).json();
    expect(idsB.every((i: any) => i.accountId === bAcct)).toBe(true);
    expect((await api('PUT', `/api/identities/${aIdent}`, { displayName: 'hacked' }, ckB)).statusCode).toBe(404);
    // B can't attach A's business to B's identity
    const bIdent = idsB[0].id;
    expect((await api('PUT', `/api/identities/${bIdent}`, { businessId: bid }, ckB)).statusCode).toBe(400);
    expect((await one<any>('SELECT name FROM businesses WHERE id = ?', [bid]))!.name).toBe('A Biz');
  });
});
