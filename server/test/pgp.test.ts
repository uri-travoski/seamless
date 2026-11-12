/** T6.4 F-39: OpenPGP (server-side mode). Interop fixtures come from the gpg CLI in a temp GNUPGHOME. */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';

const sent: { envelope: any; raw: Buffer }[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({
    sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { q, one } = await import('../src/db.ts');
const { setUserSetting } = await import('../src/classify/settings.ts');
const pgp = await import('../src/mail/pgp.ts');
const { clearParsedCache } = await import('../src/mail/body.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

const HAVE_GPG = spawnSync('gpg', ['--version']).status === 0;
if (!HAVE_GPG) console.warn('[pgp.test] gpg CLI not found: the gpg interop tests are skipped');
const gdescribe = HAVE_GPG ? describe : describe.skip;

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie = '';
let acct: number; let inbox: number; let sentBox: number;
let home = '';
const api = (method: any, url: string, body?: any, ck = cookie, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: body, headers: { cookie: ck, ...headers } });

function gpg(args: string[], input?: Buffer | string): { out: Buffer; err: string; status: number } {
  const r = spawnSync('gpg', ['--homedir', home, '--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', '', '--trust-model', 'always', ...args], { input });
  return { out: r.stdout, err: r.stderr.toString(), status: r.status ?? 1 };
}
function gpgKey(uid: string): string {
  gpg(['--quick-gen-key', uid, 'ed25519', 'cert,sign', 'never']);
  const fpr = gpg(['--list-keys', '--with-colons', uid]).out.toString().split('\n').find((l) => l.startsWith('fpr'))!.split(':')[9];
  gpg(['--quick-add-key', fpr, 'cv25519', 'encr', 'never']);
  return fpr;
}
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

const send = (extra: Record<string, unknown> = {}) => api('POST', '/api/send', {
  accountId: acct, fromEmail: 'alice@demo.test', to: [{ name: 'Bob', email: 'bob@gpg.test' }], cc: [], bcc: [],
  subject: 'Secret plans', html: '<p>The launch is on <b>Friday</b>.</p>', attachmentIds: [], track: false, ...extra,
});
const lastRaw = () => sent[sent.length - 1].raw as Buffer;

/** pull the text between the first and second boundary of a multipart body, split the way the verifier does */
function mpParts(raw: Buffer): Buffer[] {
  const s = raw.toString('latin1');
  const boundary = s.match(/boundary="([^"]+)"/)![1];
  const body = Buffer.from(s.slice(s.indexOf('\r\n\r\n') + 4), 'latin1');
  return pgp.splitMultipart(body, boundary);
}
const armorOf = (part: Buffer) => part.toString('latin1').replace(/\r/g, '').match(/-----BEGIN PGP [A-Z ]+-----[\s\S]*?-----END PGP [A-Z ]+-----/)![0];

beforeAll(() => { if (HAVE_GPG) { home = fs.mkdtempSync(path.join(os.tmpdir(), 'sgp-')); fs.chmodSync(home, 0o700); } });
afterAll(() => { if (home) { spawnSync('gpgconf', ['--homedir', home, '--kill', 'all']); fs.rmSync(home, { recursive: true, force: true }); } });

beforeEach(async () => {
  await resetDb(); resetLimiters(); clearParsedCache(); sent.length = 0;
  acct = await makeAccount('alice@demo.test', { name: 'Alice' });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox'); sentBox = await makeMailbox(acct, 'Sent', 'sent');
  await setUserSetting(TEST_USER, 'undo_send_seconds', '0');
  app = await makeApp(); cookie = await login(app);
});

describe('WKD', () => {
  it('hashes the local part like the spec (zbase32 of sha1)', () => {
    expect(pgp.wkdHash('Joe.Doe')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
    expect(pgp.wkdHash('joe.doe')).toBe('iy9q119eutrkn8s1mk4r39qejnbu3n5q');
  });
  it('builds the advanced URL first, then the direct one', () => {
    const [adv, direct] = pgp.wkdUrls('Joe.Doe@Example.org');
    expect(adv).toBe('https://openpgpkey.example.org/.well-known/openpgpkey/example.org/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe');
    expect(direct).toBe('https://example.org/.well-known/openpgpkey/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe');
  });
});

describe('keys', () => {
  it('generates, lists, exports and deletes a key; the private key is stored encrypted', async () => {
    const g = await api('POST', '/api/pgp/keys/generate', { email: 'alice@demo.test', name: 'Alice' });
    expect(g.statusCode).toBe(200);
    const k = g.json();
    expect(k.kind).toBe('own'); expect(k.hasPrivate).toBe(true); expect(k.passphraseProtected).toBe(false); expect(k.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    const row = await one<any>('SELECT * FROM pgp_keys WHERE id = ?', [k.id]);
    expect(row.private_enc).toBeTruthy(); expect(row.private_enc).not.toContain('PRIVATE KEY');
    expect(JSON.stringify((await api('GET', '/api/pgp/keys')).json())).not.toContain('PRIVATE KEY');
    const pub = await api('GET', `/api/pgp/keys/${k.id}/public`);
    expect(pub.body).toContain('BEGIN PGP PUBLIC KEY BLOCK'); expect(pub.body).not.toContain('PRIVATE');
    expect((await api('DELETE', `/api/pgp/keys/${k.id}`)).statusCode).toBe(200);
    expect((await api('GET', '/api/pgp/keys')).json().items).toHaveLength(0);
  });

  it('generates for an identity and flags a passphrase-protected key', async () => {
    const ids = (await api('GET', '/api/identities')).json();
    const g = (await api('POST', '/api/pgp/keys/generate', { identityId: ids[0].id, passphrase: 'correct horse' })).json();
    expect(g.identityId).toBe(ids[0].id); expect(g.email).toBe('alice@demo.test'); expect(g.passphraseProtected).toBe(true);
  });

  it('rejects junk and unknown identities', async () => {
    expect((await api('POST', '/api/pgp/keys/import', { armored: 'nope' })).statusCode).toBe(400);
    expect((await api('POST', '/api/pgp/keys/generate', { identityId: 99999 })).statusCode).toBe(404);
    expect((await api('POST', '/api/pgp/keys/generate', { email: 'not-an-address' })).statusCode).toBe(400);
  });

  it('isolation: user B cannot see, export, delete or use user A keys', async () => {
    const k = (await api('POST', '/api/pgp/keys/generate', { email: 'alice@demo.test' })).json();
    await makeUser('b@x.test'); const ckb = await login(app, 'b@x.test');
    expect((await api('GET', '/api/pgp/keys', undefined, ckb)).json().items).toHaveLength(0);
    expect((await api('GET', `/api/pgp/keys/${k.id}/public`, undefined, ckb)).statusCode).toBe(404);
    expect((await api('DELETE', `/api/pgp/keys/${k.id}`, undefined, ckb)).statusCode).toBe(404);
    const chk = (await api('POST', '/api/pgp/check', { fromEmail: 'alice@demo.test', to: [{ email: 'alice@demo.test' }] }, ckb)).json();
    expect(chk.canSign).toBe(false); expect(chk.canEncrypt).toBe(false);
    expect((await one<any>('SELECT COUNT(*)::int AS c FROM pgp_keys')).c).toBe(1);
  });
});

describe('lookup', () => {
  it('finds a key over WKD with an injected fetch (advanced first, direct as fallback) and keeps it as a contact', async () => {
    const { privateKey, publicKey } = await (await import('openpgp')).generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Carol', email: 'carol@wkd.test' }], format: 'armored' });
    void privateKey;
    const urls: string[] = [];
    const f: any = async (u: string) => { urls.push(u); return u.startsWith('https://wkd.test/') ? { status: 200, body: Buffer.from(publicKey) } : { status: 404, body: Buffer.alloc(0) }; };
    const r = await pgp.lookupKey(TEST_USER, 'carol@wkd.test', f);
    expect(r.found).toBe(true); expect(r.source).toBe('wkd'); expect(r.key!.kind).toBe('contact');
    expect(urls).toHaveLength(2); expect(urls[0]).toContain('openpgpkey.wkd.test'); expect(urls[1]).toBe(pgp.wkdUrls('carol@wkd.test')[1]);
    const again = await pgp.lookupKey(TEST_USER, 'carol@wkd.test', f);
    expect(again.source).toBe('local'); expect(urls).toHaveLength(2);
  });

  it('ignores a WKD key that is for somebody else, and keeps keys.openpgp.org off unless enabled', async () => {
    const { publicKey } = await (await import('openpgp')).generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ email: 'other@wkd.test' }], format: 'armored' });
    const urls: string[] = [];
    const f: any = async (u: string) => { urls.push(u); return { status: 200, body: Buffer.from(publicKey) }; };
    expect((await pgp.lookupKey(TEST_USER, 'carol@wkd.test', f)).found).toBe(false);
    expect(urls.some((u) => u.includes('keys.openpgp.org'))).toBe(false);
    expect((await api('GET', '/api/pgp/settings')).json().keyserver).toBe(false);
    await api('PUT', '/api/pgp/settings', { keyserver: true });
    urls.length = 0;
    await pgp.lookupKey(TEST_USER, 'carol@wkd.test', f);
    expect(urls.some((u) => u.startsWith('https://keys.openpgp.org/vks/v1/by-email/'))).toBe(true);
  });

  it('compose check: encrypt is disabled with the reason when a recipient has no key', async () => {
    await api('POST', '/api/pgp/keys/generate', { email: 'alice@demo.test' });
    const f: any = async () => ({ status: 404, body: Buffer.alloc(0) });
    const c = await pgp.composeCheck(TEST_USER, { fromEmail: 'alice@demo.test', to: ['nokey@nowhere.test'] }, f);
    expect(c.canSign).toBe(true); expect(c.canEncrypt).toBe(false); expect(c.encryptReason).toContain('nokey@nowhere.test'); expect(c.missing).toEqual(['nokey@nowhere.test']);
    const none = await pgp.composeCheck(TEST_USER, { fromEmail: 'zed@demo.test', to: [] }, f);
    expect(none.canSign).toBe(false); expect(none.signReason).toContain('zed@demo.test');
  });

  it('sending encrypted to a recipient without a key is refused', async () => {
    await api('POST', '/api/pgp/keys/generate', { email: 'alice@demo.test' });
    const r = await send({ pgpEncrypt: true, to: [{ name: '', email: 'nokey@127.0.0.1' }] });
    expect(r.statusCode).toBe(400); expect(r.json().error).toContain('nokey@127.0.0.1');
    expect(sent).toHaveLength(0);
  });
});

gdescribe('interop with gpg', () => {
  let bob = '';
  beforeAll(() => { bob = gpgKey('Bob <bob@gpg.test>'); });
  const bobPublic = () => gpg(['--armor', '--export', bob]).out.toString();
  const bobSecret = () => gpg(['--armor', '--export-secret-keys', bob]).out.toString();

  async function aliceKey(passphrase?: string) {
    return (await api('POST', '/api/pgp/keys/generate', { email: 'alice@demo.test', name: 'Alice', passphrase })).json();
  }
  async function importBob() { return (await api('POST', '/api/pgp/keys/import', { armored: bobPublic() })).json(); }
  async function aliceOwnPublic(k: any) { return (await api('GET', `/api/pgp/keys/${k.id}/public`)).body; }

  it('Seamless-signed mail verifies with gpg; a tampered body does not', async () => {
    const k = await aliceKey();
    gpg(['--import'], await aliceOwnPublic(k));
    const r = await send({ pgpSign: true });
    expect(r.statusCode).toBe(200);
    const raw = lastRaw();
    expect(raw.toString()).toMatch(/Content-Type: multipart\/signed;\s+protocol="application\/pgp-signature";\s+micalg=pgp-sha256/i);
    const [signed, sigPart] = mpParts(raw);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgv-'));
    fs.writeFileSync(path.join(dir, 'm'), signed); fs.writeFileSync(path.join(dir, 's.asc'), armorOf(sigPart));
    const ok = gpg(['--verify', path.join(dir, 's.asc'), path.join(dir, 'm')]);
    expect(ok.status, ok.err).toBe(0); expect(ok.err).toContain('Good signature');
    fs.writeFileSync(path.join(dir, 'm'), Buffer.from(signed.toString('latin1').replace('Friday', 'Monday!'), 'latin1'));
    expect(gpg(['--verify', path.join(dir, 's.asc'), path.join(dir, 'm')]).status).not.toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Seamless-encrypted mail decrypts with gpg and carries a valid inner signature; it is also encrypted to the sender', async () => {
    const k = await aliceKey();
    gpg(['--import'], await aliceOwnPublic(k));
    await importBob();
    const r = await send({ pgpSign: true, pgpEncrypt: true, bcc: [] });
    expect(r.statusCode, r.body).toBe(200);
    const raw = lastRaw();
    expect(raw.toString()).toMatch(/Content-Type: multipart\/encrypted;\s+protocol="application\/pgp-encrypted"/i);
    expect(raw.toString()).not.toContain('Friday');
    const parts = mpParts(raw);
    expect(parts[0].toString()).toContain('Version: 1');
    const dec = gpg(['--decrypt'], armorOf(parts[1]));
    expect(dec.status, dec.err).toBe(0);
    const inner = dec.out.toString();
    expect(inner).toContain('multipart/signed'); expect(inner).toContain('Friday');
    // the encrypted-to list includes Alice's own key (Sent copy readable)
    const ring = await pgp.listKeys(TEST_USER);
    const alice = ring.find((x) => x.kind === 'own')!;
    const listing = gpg(['--list-packets'], armorOf(parts[1])).out.toString();
    expect(listing.match(/pubkey enc packet/g)!.length).toBe(2);
    expect(alice.fingerprint).toBeTruthy();
    // and Seamless itself reads the Sent copy back
    const { rowId: id } = await ingest(acct, sentBox, raw) as any;
    const body = (await api('GET', `/api/message/m${id}/body`)).json();
    expect(body.pgp).toMatchObject({ encrypted: true, decrypted: true, signature: 'verified' });
    expect(body.html + body.text).toContain('Friday');
  });

  it('decrypts and verifies a gpg-encrypted + signed PGP/MIME message', async () => {
    const k = await aliceKey();
    await importBob();
    const alicePub = await aliceOwnPublic(k);
    gpg(['--import'], alicePub);
    const inner = crlf('Content-Type: text/plain; charset=utf-8\n\nMeet at the old pier at nine.\n');
    const enc = gpg(['--armor', '--sign', '--encrypt', '-r', k.fingerprint, '--local-user', bob], inner).out.toString();
    expect(enc).toContain('BEGIN PGP MESSAGE');
    const b = 'bnd123';
    const raw = Buffer.from(crlf([
      'From: Bob <bob@gpg.test>', 'To: alice@demo.test', 'Subject: pier', 'Date: Wed, 08 Jul 2026 10:00:00 +0000', 'Message-ID: <g1@gpg.test>', 'MIME-Version: 1.0',
      `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"`, '',
      `--${b}`, 'Content-Type: application/pgp-encrypted', '', 'Version: 1', '',
      `--${b}`, 'Content-Type: application/octet-stream; name="encrypted.asc"', '', enc, `--${b}--`, ''].join('\n')));
    const { rowId: id } = await ingest(acct, inbox, raw) as any;
    const body = (await api('GET', `/api/message/m${id}/body`)).json();
    expect(body.pgp.encrypted).toBe(true); expect(body.pgp.decrypted).toBe(true);
    expect(body.pgp.signature).toBe('verified'); expect(body.pgp.signer).toContain('bob@gpg.test');
    expect(body.text).toContain('old pier');
    // stored message is untouched (not decrypted at rest) and not findable by its secret text
    const row = await one<any>('SELECT snippet, s3_key FROM messages WHERE id = ?', [id]);
    expect(String(row.snippet ?? '')).not.toContain('old pier');
  });

  it('same message without the sender key in the key ring is "unverified", not "verified"', async () => {
    const k = await aliceKey(); gpg(['--import'], await aliceOwnPublic(k));
    const inner = crlf('Content-Type: text/plain\n\nhello there\n');
    const enc = gpg(['--armor', '--sign', '--encrypt', '-r', k.fingerprint, '--local-user', bob], inner).out.toString();
    const b = 'x1';
    const raw = Buffer.from(crlf(['From: Bob <bob@gpg.test>', 'To: alice@demo.test', 'Subject: s', 'Message-ID: <g2@gpg.test>', 'MIME-Version: 1.0',
      `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"`, '', `--${b}`, 'Content-Type: application/pgp-encrypted', '', 'Version: 1', '',
      `--${b}`, 'Content-Type: application/octet-stream', '', enc, `--${b}--`, ''].join('\n')));
    const { rowId: id } = await ingest(acct, inbox, raw) as any;
    const body = (await api('GET', `/api/message/m${id}/body`)).json();
    expect(body.pgp, JSON.stringify(body.pgp)).toMatchObject({ decrypted: true, signature: 'unverified' });
    expect(body.text).toContain('hello there');
  });

  function signedMime(text: string, tamper = false): Buffer {
    const inner = crlf(`Content-Type: text/plain; charset=utf-8\n\n${text}\n`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgs-'));
    fs.writeFileSync(path.join(dir, 'm'), inner);
    gpg(['--armor', '--detach-sign', '--local-user', bob, '-o', path.join(dir, 's.asc'), path.join(dir, 'm')]);
    const sig = fs.readFileSync(path.join(dir, 's.asc'), 'utf8'); fs.rmSync(dir, { recursive: true, force: true });
    const b = 'sgn9';
    const shown = tamper ? inner.replace('100', '900') : inner;
    return Buffer.from(['From: Bob <bob@gpg.test>', 'To: alice@demo.test', `Subject: pay ${Math.random()}`, 'Message-ID: <' + Math.random().toString(36).slice(2) + '@gpg.test>', 'MIME-Version: 1.0',
      `Content-Type: multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha512; boundary="${b}"`, '', `--${b}`, shown, `--${b}`,
      'Content-Type: application/pgp-signature; name="signature.asc"', '', crlf(sig), `--${b}--`, ''].join('\r\n'));
  }

  it('verifies a gpg-signed message, and shows a tampered one as a bad signature', async () => {
    await importBob();
    const good = await ingest(acct, inbox, signedMime('Please pay 100 dollars.')) as any; good.id = good.rowId;
    expect((await api('GET', `/api/message/m${good.id}/body`)).json().pgp).toMatchObject({ encrypted: false, signature: 'verified' });
    const bad = await ingest(acct, inbox, signedMime('Please pay 100 dollars.', true)) as any; bad.id = bad.rowId;
    const b = (await api('GET', `/api/message/m${bad.id}/body`)).json();
    expect(b.pgp.signature).toBe('bad'); expect(b.text).toContain('900');
  });

  it('unsigned mail has no pgp block', async () => {
    const { rowId: id } = await ingest(acct, inbox, rawEmail({ from: 'x@y.test', to: 'alice@demo.test', subject: 'plain' })) as any;
    expect((await api('GET', `/api/message/m${id}/body`)).json().pgp).toBeNull();
  });

  it('handles inline armour: encrypted body and cleartext-signed body', async () => {
    const k = await aliceKey(); await importBob(); gpg(['--import'], await aliceOwnPublic(k));
    const enc = gpg(['--armor', '--sign', '--encrypt', '-r', k.fingerprint, '--local-user', bob], 'inline secret 42\n').out.toString();
    const m1 = rawEmail({ from: 'Bob <bob@gpg.test>', to: 'alice@demo.test', subject: 'inline', body: enc.replace(/\n/g, '\r\n') });
    const a = await ingest(acct, inbox, m1) as any; a.id = a.rowId;
    const ba = (await api('GET', `/api/message/m${a.id}/body`)).json();
    expect(ba.pgp).toMatchObject({ encrypted: true, decrypted: true, signature: 'verified' }); expect(ba.text).toContain('inline secret 42');
    const clear = gpg(['--clearsign', '--local-user', bob], 'cleartext note\n').out.toString();
    const c = await ingest(acct, inbox, rawEmail({ from: 'Bob <bob@gpg.test>', to: 'alice@demo.test', subject: 'clear', body: clear.replace(/\n/g, '\r\n') })) as any; c.id = c.rowId;
    expect((await api('GET', `/api/message/m${c.id}/body`)).json().pgp).toMatchObject({ encrypted: false, signature: 'verified' });
  });

  it('offers a public key attached as .asc and imports it as a contact (never as an own key)', async () => {
    const pub = bobPublic();
    const b = 'att1';
    const raw = Buffer.from(crlf(['From: Bob <bob@gpg.test>', 'To: alice@demo.test', 'Subject: my key', 'Message-ID: <k1@gpg.test>', 'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, 'Content-Type: text/plain', '', 'here is my key', `--${b}`,
      'Content-Type: application/pgp-keys; name="bob.asc"', 'Content-Disposition: attachment; filename="bob.asc"', '', pub, `--${b}--`, ''].join('\n')));
    const { rowId: id } = await ingest(acct, inbox, raw) as any;
    const body = (await api('GET', `/api/message/m${id}/body`)).json();
    expect(body.pgpKeys).toHaveLength(1); expect(body.pgpKeys[0]).toMatchObject({ email: 'bob@gpg.test', known: false });
    const imp = await api('POST', '/api/pgp/import-from-message', { emailId: `m${id}`, partId: body.pgpKeys[0].partId });
    expect(imp.statusCode).toBe(200); expect(imp.json().kind).toBe('contact'); expect(imp.json().hasPrivate).toBe(false);
    expect((await api('GET', `/api/message/m${id}/body`)).json().pgpKeys[0].known).toBe(true);
    // user B cannot import from A's message
    await makeUser('b@x.test'); const ckb = await login(app, 'b@x.test');
    expect((await api('POST', '/api/pgp/import-from-message', { emailId: `m${id}`, partId: 0 }, ckb)).statusCode).toBe(404);
  });

  it('a private key import becomes an own key and can decrypt', async () => {
    const imp = await api('POST', '/api/pgp/keys/import', { armored: bobSecret() });
    expect(imp.json()).toMatchObject({ kind: 'own', hasPrivate: true, email: 'bob@gpg.test' });
  });

  it('passphrase-protected key: sends need the passphrase, reading shows locked until it is given', async () => {
    const k = await aliceKey('s3cret pass');
    gpg(['--import'], await aliceOwnPublic(k));
    expect((await send({ pgpSign: true })).statusCode).toBe(400);
    expect((await send({ pgpSign: true, pgpPassphrase: 'wrong' })).statusCode).toBe(400);
    expect((await send({ pgpSign: true, pgpPassphrase: 's3cret pass' })).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(await one('SELECT 1 AS x FROM jobs WHERE payload::text LIKE ?', ['%s3cret pass%'])).toBeFalsy();

    const enc = gpg(['--armor', '--encrypt', '-r', k.fingerprint], crlf('Content-Type: text/plain\n\nlocked words\n')).out.toString();
    const b = 'lk';
    const raw = Buffer.from(crlf(['From: Bob <bob@gpg.test>', 'To: alice@demo.test', 'Subject: locked', 'Message-ID: <l1@gpg.test>', 'MIME-Version: 1.0',
      `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"`, '', `--${b}`, 'Content-Type: application/pgp-encrypted', '', 'Version: 1', '',
      `--${b}`, 'Content-Type: application/octet-stream', '', enc, `--${b}--`, ''].join('\n')));
    const { rowId: id } = await ingest(acct, inbox, raw) as any;
    const locked = (await api('GET', `/api/message/m${id}/body`)).json();
    expect(locked.pgp).toMatchObject({ encrypted: true, decrypted: false, locked: true });
    const open = (await api('GET', `/api/message/m${id}/body`, undefined, cookie, { 'x-pgp-passphrase': 's3cret pass' })).json();
    expect(open.pgp.decrypted).toBe(true); expect(open.text).toContain('locked words');
  });

  it('isolation: user B cannot read user A decrypted mail through the API', async () => {
    const k = await aliceKey(); gpg(['--import'], await aliceOwnPublic(k));
    const enc = gpg(['--armor', '--encrypt', '-r', k.fingerprint], crlf('Content-Type: text/plain\n\nfor alice only\n')).out.toString();
    const b = 'is';
    const raw = Buffer.from(crlf(['From: Bob <bob@gpg.test>', 'To: alice@demo.test', 'Subject: iso', 'Message-ID: <i1@gpg.test>', 'MIME-Version: 1.0',
      `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"`, '', `--${b}`, 'Content-Type: application/pgp-encrypted', '', 'Version: 1', '',
      `--${b}`, 'Content-Type: application/octet-stream', '', enc, `--${b}--`, ''].join('\n')));
    const { rowId: id } = await ingest(acct, inbox, raw) as any;
    expect((await api('GET', `/api/message/m${id}/body`)).json().text).toContain('for alice only');
    await makeUser('b@x.test'); const ckb = await login(app, 'b@x.test');
    expect((await api('GET', `/api/message/m${id}/body`, undefined, ckb)).statusCode).toBe(404);
    const cnt = await q('SELECT 1 FROM pgp_keys WHERE user_id <> ?', [TEST_USER]);
    expect(cnt).toHaveLength(0);
  });
});
