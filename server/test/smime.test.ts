/** T6.5 F-39 part 2: S/MIME. Fixtures (certs, signed and encrypted mail) come from the openssl CLI. */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, TEST_USER } from './helpers.ts';

const sent: { envelope: any; raw: Buffer }[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({
    sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { q, one } = await import('../src/db.ts');
const { setUserSetting } = await import('../src/classify/settings.ts');
const { clearParsedCache } = await import('../src/mail/body.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

const HAVE = spawnSync('openssl', ['version']).status === 0;
if (!HAVE) console.warn('[smime.test] openssl CLI not found: S/MIME tests are skipped');
const sdescribe = HAVE ? describe : describe.skip;

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie = '';
let acct: number; let inbox: number;
let dir = '';
const api = (method: any, url: string, body?: any, ck = cookie, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: body, headers: { cookie: ck, ...headers } });
const crlf = (s: string | Buffer) => Buffer.from(String(s.toString('latin1')).replace(/\r?\n/g, '\r\n'), 'latin1');
const f = (n: string) => path.join(dir, n);

function ossl(args: string[], input?: Buffer | string): { out: Buffer; err: string; status: number } {
  const r = spawnSync('openssl', args, { input, cwd: dir });
  return { out: r.stdout, err: r.stderr.toString(), status: r.status ?? 1 };
}
/** self-signed cert + key + .p12 for an address */
function makeId(name: string, email: string, p12pass = 'pw', extra: string[] = []) {
  const r = ossl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-days', '30', '-subj', `/CN=${name} Test/emailAddress=${email}`, '-addext', `subjectAltName=email:${email}`]);
  expect(r.status, r.err).toBe(0);
  const p = ossl(['pkcs12', '-export', '-inkey', `${name}.key`, '-in', `${name}.pem`, '-out', `${name}.p12`, '-passout', `pass:${p12pass}`, ...extra]);
  expect(p.status, p.err).toBe(0);
}
const p12b64 = (name: string) => fs.readFileSync(f(`${name}.p12`)).toString('base64');

const send = (extra: Record<string, unknown> = {}) => api('POST', '/api/send', {
  accountId: acct, fromEmail: 'alice@demo.test', to: [{ name: 'Bob', email: 'bob@smime.test' }], cc: [], bcc: [],
  subject: 'Quarterly numbers', html: '<p>Revenue is <b>up</b> 12%.</p>', attachmentIds: [], track: false, ...extra,
});
const lastRaw = () => sent[sent.length - 1].raw as Buffer;
const importAlice = async () => (await api('POST', '/api/smime/certs/import-p12', { data: p12b64('alice'), password: 'pw', identityId: (await api('GET', '/api/identities')).json()[0].id })).json();

/** openssl-signed message from bob to alice, as it would arrive over SMTP (CRLF) */
function opensslSigned(text: string, signer = 'bob', from = 'bob@smime.test', extra: string[] = []): Buffer {
  fs.writeFileSync(f('in.txt'), text);
  const r = ossl(['smime', '-sign', '-text', '-in', 'in.txt', '-signer', `${signer}.pem`, '-inkey', `${signer}.key`, '-from', from, '-to', 'alice@demo.test', '-subject', `signed ${Math.random()}`, ...extra]);
  expect(r.status, r.err).toBe(0);
  return crlf(Buffer.concat([r.out, Buffer.from('\n')]).toString('latin1').replace(/^(MIME-Version)/m, `Message-ID: <${Math.random().toString(36).slice(2)}@smime.test>\n$1`));
}
const bodyOf = async (rowId: number, ck = cookie) => (await api('GET', `/api/message/m${rowId}/body`, undefined, ck)).json();

beforeAll(() => {
  if (!HAVE) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssm-'));
  makeId('alice', 'alice@demo.test'); makeId('bob', 'bob@smime.test'); makeId('mallory', 'mallory@smime.test');
});
afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

beforeEach(async () => {
  await resetDb(); resetLimiters(); clearParsedCache(); sent.length = 0;
  acct = await makeAccount('alice@demo.test', { name: 'Alice' });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox'); await makeMailbox(acct, 'Sent', 'sent');
  await setUserSetting(TEST_USER, 'undo_send_seconds', '0');
  app = await makeApp(); cookie = await login(app);
});

sdescribe('certificates', () => {
  it('imports a password-protected PKCS#12 for an identity; the key is stored encrypted and never returned', async () => {
    const c = await importAlice();
    expect(c).toMatchObject({ kind: 'own', hasPrivate: true, email: 'alice@demo.test', expired: false });
    expect(c.subject).toContain('alice@demo.test');
    const row = await one<any>('SELECT * FROM smime_certs WHERE id = ?', [c.id]);
    expect(row.key_enc).toBeTruthy(); expect(row.key_enc).not.toContain('PRIVATE KEY'); expect(row.cert_pem).not.toContain('PRIVATE');
    expect(JSON.stringify((await api('GET', '/api/smime/certs')).json())).not.toContain('PRIVATE KEY');
    const pem = await api('GET', `/api/smime/certs/${c.id}/pem`);
    expect(pem.body).toContain('BEGIN CERTIFICATE'); expect(pem.body).not.toContain('PRIVATE');
    expect((await api('DELETE', `/api/smime/certs/${c.id}`)).statusCode).toBe(200);
    expect((await api('GET', '/api/smime/certs')).json().items).toHaveLength(0);
  });

  it('rejects a wrong password, junk, a cert for another address and an unknown identity', async () => {
    const idn = (await api('GET', '/api/identities')).json()[0].id;
    const wrong = await api('POST', '/api/smime/certs/import-p12', { data: p12b64('alice'), password: 'nope', identityId: idn });
    expect(wrong.statusCode).toBe(400); expect(wrong.json().error).toMatch(/password/i);
    expect((await api('POST', '/api/smime/certs/import-p12', { data: Buffer.from('junk junk').toString('base64'), password: 'pw' })).statusCode).toBe(400);
    const other = await api('POST', '/api/smime/certs/import-p12', { data: p12b64('bob'), password: 'pw', identityId: idn });
    expect(other.statusCode).toBe(400); expect(other.json().error).toContain('bob@smime.test');
    expect((await api('POST', '/api/smime/certs/import-p12', { data: p12b64('alice'), password: 'pw', identityId: 99999 })).statusCode).toBe(404);
  });

  it('a legacy RC2/3DES-encrypted PKCS#12 either imports or fails with a clear message (never a 500)', async () => {
    makeId('legacy', 'alice@demo.test', 'pw', ['-legacy']);
    const idn = (await api('GET', '/api/identities')).json()[0].id;
    const r = await api('POST', '/api/smime/certs/import-p12', { data: p12b64('legacy'), password: 'pw', identityId: idn });
    expect([200, 400]).toContain(r.statusCode);
    if (r.statusCode === 400) expect(r.json().error).toMatch(/AES|password|unsupported/i);
    else expect(r.json().hasPrivate).toBe(true);
  });

  it('imports a contact certificate (PEM)', async () => {
    const r = await api('POST', '/api/smime/certs/import', { pem: fs.readFileSync(f('bob.pem'), 'utf8') });
    expect(r.json()).toMatchObject({ kind: 'contact', hasPrivate: false, email: 'bob@smime.test' });
  });

  it('isolation: user B cannot see, export, delete or use user A certificates', async () => {
    const c = await importAlice();
    await makeUser('b@x.test'); const ckb = await login(app, 'b@x.test');
    expect((await api('GET', '/api/smime/certs', undefined, ckb)).json().items).toHaveLength(0);
    expect((await api('GET', `/api/smime/certs/${c.id}/pem`, undefined, ckb)).statusCode).toBe(404);
    expect((await api('DELETE', `/api/smime/certs/${c.id}`, undefined, ckb)).statusCode).toBe(404);
    const chk = (await api('POST', '/api/smime/check', { fromEmail: 'alice@demo.test', to: [{ email: 'alice@demo.test' }] }, ckb)).json();
    expect(chk.canSign).toBe(false); expect(chk.canEncrypt).toBe(false);
    expect((await one<any>('SELECT COUNT(*)::int AS c FROM smime_certs')).c).toBe(1);
  });
});

sdescribe('sending', () => {
  it('Seamless-signed mail verifies with openssl; a tampered body does not', async () => {
    await importAlice();
    const r = await send({ smimeSign: true });
    expect(r.statusCode, r.body).toBe(200);
    const raw = lastRaw();
    expect(raw.toString()).toMatch(/Content-Type: multipart\/signed;\s+protocol="application\/pkcs7-signature";\s+micalg=sha-256/i);
    expect(raw.toString()).toContain('smime.p7s');
    fs.writeFileSync(f('out.eml'), raw);
    const ok = ossl(['smime', '-verify', '-noverify', '-in', 'out.eml']);
    expect(ok.status, ok.err).toBe(0); expect(ok.out.toString()).toContain('Revenue is');
    fs.writeFileSync(f('out.eml'), Buffer.from(raw.toString('latin1').replace('Revenue is', 'Revenue was'), 'latin1'));
    expect(ossl(['smime', '-verify', '-noverify', '-in', 'out.eml']).status).not.toBe(0);
  });

  it('Seamless can verify its own sent signature (round trip through ingest)', async () => {
    await importAlice();
    await send({ smimeSign: true });
    const { rowId } = await ingest(acct, inbox, lastRaw()) as any;
    expect((await bodyOf(rowId)).smime).toMatchObject({ encrypted: false, signature: 'verified', signer: expect.stringContaining('alice@demo.test') });
  });

  it('encrypted mail decrypts with openssl for the recipient; signed+encrypted carries a valid inner signature', async () => {
    await importAlice();
    await api('POST', '/api/smime/certs/import', { pem: fs.readFileSync(f('bob.pem'), 'utf8') });
    const r = await send({ smimeSign: true, smimeEncrypt: true });
    expect(r.statusCode, r.body).toBe(200);
    const raw = lastRaw();
    expect(raw.toString()).toMatch(/Content-Type: application\/pkcs7-mime;\s+smime-type=enveloped-data/i);
    expect(raw.toString()).not.toContain('Revenue is');
    fs.writeFileSync(f('enc.eml'), raw);
    for (const who of ['bob', 'alice']) {   // recipient and sender (own Sent copy)
      const d = ossl(['smime', '-decrypt', '-in', 'enc.eml', '-recip', `${who}.pem`, '-inkey', `${who}.key`]);
      expect(d.status, d.err).toBe(0);
      expect(d.out.toString()).toContain('multipart/signed');
      fs.writeFileSync(f('inner.eml'), d.out);
      const v = ossl(['smime', '-verify', '-noverify', '-in', 'inner.eml']);
      expect(v.status, v.err).toBe(0); expect(v.out.toString()).toContain('Revenue is');
    }
    expect(ossl(['smime', '-decrypt', '-in', 'enc.eml', '-recip', 'mallory.pem', '-inkey', 'mallory.key']).status).not.toBe(0);
  });

  it('Seamless decrypts what it encrypted (the Sent copy) and shows the plaintext', async () => {
    await importAlice();
    await api('POST', '/api/smime/certs/import', { pem: fs.readFileSync(f('bob.pem'), 'utf8') });
    await send({ smimeEncrypt: true });
    const { rowId } = await ingest(acct, inbox, lastRaw()) as any;
    const b = await bodyOf(rowId);
    expect(b.smime, JSON.stringify(b.smime)).toMatchObject({ encrypted: true, decrypted: true, signature: 'none' });
    expect(b.text).toContain('Revenue is');
  });

  it('refuses to encrypt without a certificate for every recipient, to sign without own cert, and to mix with OpenPGP', async () => {
    const noOwn = await send({ smimeSign: true });
    expect(noOwn.statusCode).toBe(400); expect(noOwn.json().error).toContain('alice@demo.test');
    await importAlice();
    const noRcpt = await send({ smimeEncrypt: true });
    expect(noRcpt.statusCode).toBe(400); expect(noRcpt.json().error).toContain('bob@smime.test');
    const both = await send({ smimeSign: true, pgpSign: true });
    expect(both.statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('compose check explains why encrypt is unavailable', async () => {
    await importAlice();
    const c = (await api('POST', '/api/smime/check', { fromEmail: 'alice@demo.test', to: [{ email: 'bob@smime.test' }] })).json();
    expect(c.canSign).toBe(true); expect(c.canEncrypt).toBe(false); expect(c.encryptReason).toContain('bob@smime.test'); expect(c.missing).toEqual(['bob@smime.test']);
    const none = (await api('POST', '/api/smime/check', { fromEmail: 'zed@demo.test', to: [] })).json();
    expect(none.canSign).toBe(false); expect(none.signReason).toContain('zed@demo.test');
  });

  it('turns open tracking off for S/MIME mail', async () => {
    await importAlice();
    await send({ smimeSign: true, track: true });
    expect(lastRaw().toString()).not.toMatch(/\/t\/|tracking/i);
  });
});

sdescribe('reading', () => {
  it('verifies an openssl-signed message, collects the sender certificate, and flags a tampered one as bad', async () => {
    const good = await ingest(acct, inbox, opensslSigned('Please approve invoice 77.\n')) as any;
    const b = await bodyOf(good.rowId);
    expect(b.smime).toMatchObject({ encrypted: false, signature: 'verified', signer: 'bob Test <bob@smime.test>' });
    expect(b.smime.issuer).toBeTruthy(); expect(b.text).toContain('invoice 77');
    const certs = (await api('GET', '/api/smime/certs')).json().items;
    expect(certs).toHaveLength(1); expect(certs[0]).toMatchObject({ kind: 'contact', email: 'bob@smime.test', hasPrivate: false });
    // the collected cert now lets the user encrypt to Bob
    await importAlice();
    const chk = (await api('POST', '/api/smime/check', { fromEmail: 'alice@demo.test', to: [{ email: 'bob@smime.test' }] })).json();
    expect(chk.canEncrypt).toBe(true);

    const tampered = Buffer.from(opensslSigned('Please approve invoice 77.\n').toString('latin1').replace('invoice 77', 'invoice 99'), 'latin1');
    const t = await ingest(acct, inbox, tampered) as any;
    const tb = await bodyOf(t.rowId);
    expect(tb.smime.signature).toBe('bad'); expect(tb.text).toContain('invoice 99');
  });

  it('a valid signature from a different address than From is not "verified" and its cert is not collected', async () => {
    const m = await ingest(acct, inbox, opensslSigned('I am Bob, honest.\n', 'mallory', 'bob@smime.test')) as any;
    const b = await bodyOf(m.rowId);
    expect(b.smime.signature).toBe('unverified'); expect(b.smime.error).toContain('not the sender');
    expect((await q('SELECT 1 FROM smime_certs'))).toHaveLength(0);
  });

  it('decrypts an openssl-encrypted message (AES-256) and an OAEP/AES-128 cms one with the imported key', async () => {
    await importAlice();
    for (const [cmd, extra] of [['smime', ['-aes256']], ['cms', ['-aes128', '-recip', 'alice.pem', '-keyopt', 'rsa_padding_mode:oaep']], ['smime', ['-des3']]] as const) {
      fs.writeFileSync(f('plain.txt'), 'The vault code is 4417.\n');
      const e = ossl([cmd, '-encrypt', '-text', '-in', 'plain.txt', '-from', 'bob@smime.test', '-to', 'alice@demo.test', '-subject', 'vault', ...extra, ...(cmd === 'cms' ? [] : ['alice.pem'])]);
      expect(e.status, e.err).toBe(0);
      const raw = crlf(e.out.toString('latin1').replace(/^(MIME-Version)/m, `Message-ID: <${Math.random().toString(36).slice(2)}@smime.test>\n$1`));
      const m = await ingest(acct, inbox, raw) as any;
      const b = await bodyOf(m.rowId);
      expect(b.smime, `${cmd} ${extra}`).toMatchObject({ encrypted: true, decrypted: true });
      expect(b.text).toContain('vault code is 4417');
    }
  });

  it('openssl sign + encrypt (the usual order) shows both the lock and the verified signature', async () => {
    await importAlice();
    const signed = opensslSigned('Signed and sealed.\n');
    const inner = signed.toString('latin1').split(/\r\n\r\n/).slice(0);
    // strip transport headers: keep only the MIME entity (Content-Type onwards) as the thing to encrypt
    const entity = signed.toString('latin1').replace(/^[\s\S]*?(Content-Type: multipart\/signed)/, '$1');
    void inner;
    fs.writeFileSync(f('entity.eml'), entity);
    const e = ossl(['smime', '-encrypt', '-aes256', '-in', 'entity.eml', '-from', 'bob@smime.test', '-to', 'alice@demo.test', '-subject', 'both', 'alice.pem']);
    expect(e.status, e.err).toBe(0);
    const raw = crlf(e.out.toString('latin1').replace(/^(MIME-Version)/m, `Message-ID: <${Math.random().toString(36).slice(2)}@smime.test>\n$1`));
    const m = await ingest(acct, inbox, raw) as any;
    const b = await bodyOf(m.rowId);
    expect(b.smime).toMatchObject({ encrypted: true, decrypted: true, signature: 'verified' });
    expect(b.text).toContain('Signed and sealed');
  });

  it('shows a clear error when the message is not for any of your certificates, or you have no key', async () => {
    fs.writeFileSync(f('plain.txt'), 'secret\n');
    const e = ossl(['smime', '-encrypt', '-aes256', '-in', 'plain.txt', '-from', 'bob@smime.test', '-to', 'mallory@smime.test', '-subject', 'm', 'mallory.pem']);
    const raw = crlf(e.out.toString('latin1').replace(/^(MIME-Version)/m, `Message-ID: <a${Math.random().toString(36).slice(2)}@smime.test>\n$1`));
    const m1 = await ingest(acct, inbox, raw) as any;
    expect((await bodyOf(m1.rowId)).smime).toMatchObject({ encrypted: true, decrypted: false, error: expect.stringContaining('no S/MIME private key') });
    await importAlice();
    const m2 = await ingest(acct, inbox, crlf(e.out.toString('latin1').replace(/^(MIME-Version)/m, `Message-ID: <b${Math.random().toString(36).slice(2)}@smime.test>\n$1`))) as any;
    expect((await bodyOf(m2.rowId)).smime).toMatchObject({ encrypted: true, decrypted: false, error: expect.stringContaining('not encrypted to any') });
  });

  it('unsigned mail has no smime block', async () => {
    const { rowId } = await ingest(acct, inbox, Buffer.from('From: x@y.test\r\nTo: alice@demo.test\r\nSubject: plain\r\nMessage-ID: <p1@y.test>\r\n\r\nhi\r\n')) as any;
    expect((await bodyOf(rowId)).smime).toBeUndefined();
  });

  it('isolation: user B cannot read user A decrypted mail, and collected certs stay with user A', async () => {
    await importAlice();
    fs.writeFileSync(f('plain.txt'), 'for alice only\n');
    const e = ossl(['smime', '-encrypt', '-text', '-aes256', '-in', 'plain.txt', '-from', 'bob@smime.test', '-to', 'alice@demo.test', '-subject', 'iso', 'alice.pem']);
    const raw = crlf(e.out.toString('latin1').replace(/^(MIME-Version)/m, `Message-ID: <iso1@smime.test>\n$1`));
    const { rowId } = await ingest(acct, inbox, raw) as any;
    expect((await bodyOf(rowId)).text).toContain('for alice only');
    await ingest(acct, inbox, opensslSigned('hello\n'));
    await makeUser('b@x.test'); const ckb = await login(app, 'b@x.test');
    expect((await api('GET', `/api/message/m${rowId}/body`, undefined, ckb)).statusCode).toBe(404);
    expect((await q('SELECT 1 FROM smime_certs WHERE user_id <> ?', [TEST_USER]))).toHaveLength(0);
  });
});
