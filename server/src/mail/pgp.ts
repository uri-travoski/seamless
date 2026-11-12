/**
 * OpenPGP (T6.4 F-39), server-side mode: the private key is stored encrypted under SEAMLESS_SECRET (and, if the
 * user gave a passphrase, is still passphrase-locked inside). Browser-only decryption is deferred.
 *
 * - key management per user: generate (curve25519) / import / export public / delete; contact keys from manual
 *   import, `.asc` attachments, WKD (advanced then direct) and, only if the user turned it on, keys.openpgp.org
 * - sending: PGP/MIME (RFC 3156) multipart/signed and multipart/encrypted (also encrypted to the sender)
 * - reading: PGP/MIME + inline armour, verify -> badge, decrypt on view (never stored decrypted, never indexed)
 */
import crypto from 'node:crypto';
import * as openpgp from 'openpgp';
import { simpleParser, type ParsedMail } from 'mailparser';
import { q, one, run } from '../db.ts';
import { encrypt, decrypt, randomToken } from '../crypto.ts';
import { getUserSetting, setUserSetting } from '../classify/settings.ts';
import { safeRequest } from '../integrations/ssrf.ts';

export class PgpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export interface PgpKeyRow {
  id: number; user_id: number; identity_id: number | null; kind: 'own' | 'contact'; email: string;
  fingerprint: string; public_armored: string; private_enc: string | null; created_at: number;
}
export interface PgpKeyApi {
  id: number; kind: 'own' | 'contact'; identityId: number | null; email: string; name: string; fingerprint: string;
  hasPrivate: boolean; passphraseProtected: boolean; createdAt: number; expires: number | null;
}

const HASH = openpgp.enums.hash.sha256;
const SIGN_CONFIG = { preferredHashAlgorithm: HASH };

export const fmtFingerprint = (fp: string) => fp.toUpperCase().replace(/(.{4})/g, '$1 ').trim();

// ---------- parsing / key helpers ----------

async function readPublic(armored: string): Promise<openpgp.Key> {
  try { return await openpgp.readKey({ armoredKey: armored }); }
  catch { throw new PgpError(400, 'That is not a valid OpenPGP public key'); }
}

function primaryUser(key: openpgp.Key): { name: string; email: string } {
  const u = key.getUserIDs()[0] ?? '';
  const m = u.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].replace(/^"|"$/g, ''), email: m[2].toLowerCase() };
  return { name: '', email: u.includes('@') ? u.trim().toLowerCase() : '' };
}
export function keyEmails(key: openpgp.Key): string[] {
  const out: string[] = [];
  for (const u of key.getUserIDs()) { const m = u.match(/<([^>]+)>/); const e = (m ? m[1] : u).trim().toLowerCase(); if (e.includes('@')) out.push(e); }
  return out;
}

async function toApi(r: PgpKeyRow): Promise<PgpKeyApi> {
  let name = ''; let expires: number | null = null; let prot = false;
  try {
    const k = await openpgp.readKey({ armoredKey: r.public_armored });
    name = primaryUser(k).name;
    const e = await k.getExpirationTime(); expires = e instanceof Date ? e.getTime() : null;
  } catch { /* unreadable: still list it */ }
  if (r.private_enc) {
    try { prot = !(await openpgp.readPrivateKey({ armoredKey: decrypt(r.private_enc) })).isDecrypted(); } catch { /* ignore */ }
  }
  return { id: r.id, kind: r.kind, identityId: r.identity_id, email: r.email, name, fingerprint: r.fingerprint,
    hasPrivate: !!r.private_enc, passphraseProtected: prot, createdAt: Number(r.created_at), expires };
}

export async function listKeys(userId: number): Promise<PgpKeyApi[]> {
  const rows = await q<PgpKeyRow>('SELECT * FROM pgp_keys WHERE user_id = ? ORDER BY kind, email, id', [userId]);
  return Promise.all(rows.map(toApi));
}

async function identityOf(userId: number, identityId: number | null | undefined): Promise<{ id: number; email: string; display_name: string } | null> {
  if (identityId == null) return null;
  const r = await one<{ id: number; email: string; display_name: string }>('SELECT id, email, display_name FROM identities WHERE id = ? AND user_id = ?', [Number(identityId), userId]);
  if (!r) throw new PgpError(404, 'Unknown identity');
  return r;
}

async function saveKey(userId: number, o: { kind: 'own' | 'contact'; identityId?: number | null; email: string; fingerprint: string; pub: string; priv?: string | null }): Promise<PgpKeyRow> {
  await run(`INSERT INTO pgp_keys(user_id, identity_id, kind, email, fingerprint, public_armored, private_enc, created_at)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT (user_id, fingerprint) DO UPDATE SET public_armored = excluded.public_armored,
               identity_id = COALESCE(excluded.identity_id, pgp_keys.identity_id),
               private_enc = COALESCE(excluded.private_enc, pgp_keys.private_enc),
               kind = CASE WHEN excluded.private_enc IS NOT NULL OR pgp_keys.private_enc IS NOT NULL THEN 'own' ELSE pgp_keys.kind END`,
    [userId, o.identityId ?? null, o.kind, o.email, o.fingerprint, o.pub, o.priv ? encrypt(o.priv) : null, Date.now()]);
  return (await one<PgpKeyRow>('SELECT * FROM pgp_keys WHERE user_id = ? AND fingerprint = ?', [userId, o.fingerprint]))!;
}

/** Generate a curve25519 key for an identity (or a bare address). */
export async function generateKey(userId: number, o: { identityId?: number | null; email?: string; name?: string; passphrase?: string }): Promise<PgpKeyApi> {
  const ident = await identityOf(userId, o.identityId);
  const email = (ident?.email ?? o.email ?? '').trim().toLowerCase();
  if (!email.includes('@')) throw new PgpError(400, 'An email address (or identity) is required');
  const name = (o.name ?? ident?.display_name ?? '').trim();
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: name || undefined, email }],
    passphrase: o.passphrase || undefined, format: 'armored',
  });
  const pk = await openpgp.readKey({ armoredKey: publicKey });
  const row = await saveKey(userId, { kind: 'own', identityId: ident?.id ?? null, email, fingerprint: pk.getFingerprint(), pub: publicKey, priv: privateKey });
  return toApi(row);
}

/** Import armored key material: a private key becomes an 'own' key, a public key a contact key. */
export async function importKey(userId: number, armored: string, o: { identityId?: number | null; kind?: 'own' | 'contact' } = {}): Promise<PgpKeyApi> {
  const text = String(armored ?? '').trim();
  if (!text) throw new PgpError(400, 'Paste an armored key');
  const ident = await identityOf(userId, o.identityId);
  if (/-----BEGIN PGP PRIVATE KEY BLOCK-----/.test(text)) {
    let k: openpgp.PrivateKey;
    try { k = await openpgp.readPrivateKey({ armoredKey: text }); } catch { throw new PgpError(400, 'That is not a valid OpenPGP private key'); }
    const pub = k.toPublic().armor();
    const email = ident?.email.toLowerCase() ?? primaryUser(k).email;
    if (!email) throw new PgpError(400, 'The key has no email address');
    return toApi(await saveKey(userId, { kind: 'own', identityId: ident?.id ?? null, email, fingerprint: k.getFingerprint(), pub, priv: k.armor() }));
  }
  const k = await readPublic(text);
  const email = primaryUser(k).email;
  if (!email) throw new PgpError(400, 'The key has no email address');
  return toApi(await saveKey(userId, { kind: 'contact', email, fingerprint: k.getFingerprint(), pub: k.armor() }));
}

export async function deleteKey(userId: number, id: number): Promise<void> {
  const n = await run('DELETE FROM pgp_keys WHERE id = ? AND user_id = ?', [id, userId]);
  if (!n) throw new PgpError(404, 'Key not found');
}

export async function exportPublic(userId: number, id: number): Promise<{ armored: string; filename: string }> {
  const r = await one<PgpKeyRow>('SELECT * FROM pgp_keys WHERE id = ? AND user_id = ?', [id, userId]);
  if (!r) throw new PgpError(404, 'Key not found');
  return { armored: r.public_armored, filename: `${r.email}-${r.fingerprint.slice(-16).toUpperCase()}.asc` };
}

// ---------- contact key lookup (local, WKD, keyserver) ----------

const ZB32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
export function zbase32(buf: Buffer): string {
  let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += ZB32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
/** WKD hash of the local part: zbase32(sha1(lower-cased local part)). */
export function wkdHash(local: string): string { return zbase32(crypto.createHash('sha1').update(local.toLowerCase()).digest()); }
export function wkdUrls(email: string): string[] {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at); const domain = email.slice(at + 1).toLowerCase();
  const h = wkdHash(local); const l = encodeURIComponent(local);
  return [`https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${h}?l=${l}`, `https://${domain}/.well-known/openpgpkey/hu/${h}?l=${l}`];
}

export type PgpFetch = (url: string) => Promise<{ status: number; body: Buffer }>;
export const defaultFetch: PgpFetch = async (url) => {
  const r = await safeRequest(url, { method: 'GET', timeoutMs: 5000, maxResponseBytes: 512 * 1024 });
  return { status: r.status, body: r.body ?? Buffer.from(r.text) };
};

async function parseRemoteKey(body: Buffer, email: string): Promise<openpgp.Key | null> {
  try {
    const text = body.toString('utf8');
    const key = text.includes('BEGIN PGP PUBLIC KEY') ? await openpgp.readKey({ armoredKey: text }) : await openpgp.readKey({ binaryKey: body });
    return keyEmails(key).includes(email) ? key : null;   // a key for somebody else is not a key for this address
  } catch { return null; }
}

/** Find a contact (or own) public key for an address in the user's key ring. */
export async function localKeyFor(userId: number, email: string): Promise<PgpKeyRow | null> {
  const e = email.trim().toLowerCase();
  const hit = await one<PgpKeyRow>('SELECT * FROM pgp_keys WHERE user_id = ? AND lower(email) = ? ORDER BY (kind = \'contact\') DESC, id DESC LIMIT 1', [userId, e]);
  if (hit) return hit;
  for (const r of await q<PgpKeyRow>('SELECT * FROM pgp_keys WHERE user_id = ?', [userId])) {   // multi-UID keys
    try { if (keyEmails(await openpgp.readKey({ armoredKey: r.public_armored })).includes(e)) return r; } catch { /* skip */ }
  }
  return null;
}

/** Local key ring first, then WKD, then (only when the user switched it on) keys.openpgp.org. Remote hits are saved as contact keys. */
export async function lookupKey(userId: number, emailIn: string, fetchImpl: PgpFetch = defaultFetch): Promise<{ found: boolean; source?: 'local' | 'wkd' | 'keyserver'; key?: PgpKeyApi }> {
  const email = emailIn.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PgpError(400, 'Not an email address');
  const local = await localKeyFor(userId, email);
  if (local) return { found: true, source: 'local', key: await toApi(local) };
  const tryUrl = async (url: string) => {
    try { const r = await fetchImpl(url); return r.status === 200 && r.body.length ? await parseRemoteKey(r.body, email) : null; } catch { return null; }
  };
  let key: openpgp.Key | null = null; let source: 'wkd' | 'keyserver' = 'wkd';
  for (const u of wkdUrls(email)) { key = await tryUrl(u); if (key) break; }
  if (!key && (await getUserSetting(userId, 'pgp_keyserver')) === 'true') {
    key = await tryUrl(`https://keys.openpgp.org/vks/v1/by-email/${encodeURIComponent(email)}`); source = 'keyserver';
  }
  if (!key) return { found: false };
  const row = await saveKey(userId, { kind: 'contact', email, fingerprint: key.getFingerprint(), pub: key.armor() });
  return { found: true, source, key: await toApi(row) };
}

export async function getSettings(userId: number): Promise<{ keyserver: boolean }> { return { keyserver: (await getUserSetting(userId, 'pgp_keyserver')) === 'true' }; }
export async function putSettings(userId: number, b: { keyserver?: boolean }): Promise<{ keyserver: boolean }> {
  if (b.keyserver !== undefined) await setUserSetting(userId, 'pgp_keyserver', b.keyserver ? 'true' : 'false');
  return getSettings(userId);
}

// ---------- compose: what can be signed / encrypted ----------

export interface PgpCompose { needsPassphrase: boolean; canSign: boolean; signReason?: string; canEncrypt: boolean; encryptReason?: string; missing: string[] }

async function ownKeyRow(userId: number, fromEmail: string, identityId?: number | null): Promise<PgpKeyRow | null> {
  if (identityId != null) {
    const r = await one<PgpKeyRow>("SELECT * FROM pgp_keys WHERE user_id = ? AND identity_id = ? AND private_enc IS NOT NULL ORDER BY id DESC LIMIT 1", [userId, identityId]);
    if (r) return r;
  }
  return (await one<PgpKeyRow>("SELECT * FROM pgp_keys WHERE user_id = ? AND private_enc IS NOT NULL AND lower(email) = ? ORDER BY id DESC LIMIT 1", [userId, fromEmail.trim().toLowerCase()])) ?? null;
}

/** Pre-send check for the compose toggles. Missing recipient keys are looked up via WKD (and the keyserver if enabled). */
export async function composeCheck(userId: number, o: { fromEmail: string; identityId?: number | null; to?: string[]; cc?: string[]; bcc?: string[] }, fetchImpl: PgpFetch = defaultFetch): Promise<PgpCompose> {
  const own = await ownKeyRow(userId, o.fromEmail, o.identityId);
  const rcpts = [...new Set([...(o.to ?? []), ...(o.cc ?? []), ...(o.bcc ?? [])].map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  const missing: string[] = [];
  for (const r of rcpts) {
    const hit = await lookupKey(userId, r, fetchImpl).catch(() => ({ found: false }));
    if (!hit.found) missing.push(r);
  }
  let needsPassphrase = false;
  if (own) { try { needsPassphrase = !(await openpgp.readPrivateKey({ armoredKey: decrypt(own.private_enc!) })).isDecrypted(); } catch { /* ignore */ } }
  const res: PgpCompose = { needsPassphrase, canSign: !!own, canEncrypt: true, missing };
  if (!own) res.signReason = `No OpenPGP key for ${o.fromEmail} — create or import one in Settings → Encryption`;
  if (!rcpts.length) { res.canEncrypt = false; res.encryptReason = 'Add a recipient first'; }
  else if (missing.length) { res.canEncrypt = false; res.encryptReason = `No public key for ${missing.join(', ')}`; }
  else if (!own) { res.canEncrypt = false; res.encryptReason = `No OpenPGP key for ${o.fromEmail} to read your own Sent copy`; }
  return res;
}

// ---------- MIME helpers ----------

const CRLF = '\r\n';
function splitMessage(raw: Buffer): { head: string; body: Buffer } {
  const i = raw.indexOf('\r\n\r\n');
  if (i < 0) return { head: raw.toString('utf8'), body: Buffer.alloc(0) };
  return { head: raw.subarray(0, i).toString('utf8'), body: raw.subarray(i + 4) };
}
function headerBlocks(head: string): string[] { return head.replace(/\r?\n(?=[ \t])/g, '\u0000').split(/\r?\n/).filter(Boolean).map((l) => l.replace(/\u0000/g, '\r\n')); }
const hname = (b: string) => b.slice(0, b.indexOf(':')).toLowerCase();
const hvalue = (b: string) => b.slice(b.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim();
function ctParams(v: string): { type: string; params: Record<string, string> } {
  const parts = v.split(';'); const params: Record<string, string> = {};
  for (const p of parts.slice(1)) { const m = p.match(/^\s*([\w-]+)\s*=\s*(?:"([^"]*)"|([^;]*))\s*$/); if (m) params[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').trim(); }
  return { type: parts[0].trim().toLowerCase(), params };
}
const ENTITY_HEADERS = new Set(['content-type', 'content-transfer-encoding', 'content-disposition', 'content-id', 'content-description']);

/** Split a multipart body into its raw parts (headers + body, no boundary lines, no trailing CRLF). */
export function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const text = body.toString('latin1');
  const delim = `--${boundary}`;
  const parts: Buffer[] = [];
  let pos = text.indexOf(delim);
  while (pos >= 0) {
    const lineEnd = text.indexOf('\n', pos);
    if (lineEnd < 0) break;
    if (text.slice(pos + delim.length, pos + delim.length + 2) === '--') break;
    const next = text.indexOf(`\n${delim}`, lineEnd);
    if (next < 0) break;
    let end = next; if (text[end - 1] === '\r') end--;
    parts.push(Buffer.from(text.slice(lineEnd + 1, end), 'latin1'));
    pos = next + 1;
  }
  return parts;
}

const wrap = (s: string) => s.replace(/\r?\n/g, CRLF);

// ---------- sending ----------

async function unlockedPrivate(userId: number, row: PgpKeyRow, passphrase?: string): Promise<openpgp.PrivateKey> {
  let k = await openpgp.readPrivateKey({ armoredKey: decrypt(row.private_enc!) });
  if (!k.isDecrypted()) {
    if (!passphrase) throw new PgpError(400, 'This key is protected: enter its passphrase');
    try { k = await openpgp.decryptKey({ privateKey: k, passphrase }); } catch { throw new PgpError(400, 'Wrong passphrase for your OpenPGP key'); }
  }
  return k;
}

/** Wrap a built RFC 5322 message (from nodemailer) in PGP/MIME multipart/signed and/or multipart/encrypted. */
export async function protectMessage(userId: number, raw: Buffer, o: {
  sign: boolean; encrypt: boolean; fromEmail: string; identityId?: number | null; recipients: string[]; passphrase?: string;
}, fetchImpl: PgpFetch = defaultFetch): Promise<Buffer> {
  if (!o.sign && !o.encrypt) return raw;
  const own = await ownKeyRow(userId, o.fromEmail, o.identityId);
  if (!own) throw new PgpError(400, `No OpenPGP key for ${o.fromEmail}`);
  const { head, body } = splitMessage(raw);
  const blocks = headerBlocks(head);
  const outer = blocks.filter((b) => !ENTITY_HEADERS.has(hname(b)));
  const inner = blocks.filter((b) => ENTITY_HEADERS.has(hname(b)));
  let entity = Buffer.concat([Buffer.from(inner.join(CRLF) + CRLF + CRLF), body]);   // the part that is signed / encrypted

  if (o.sign) {
    const priv = await unlockedPrivate(userId, own, o.passphrase);
    const sig = await openpgp.sign({ message: await openpgp.createMessage({ binary: entity }), signingKeys: priv, detached: true, format: 'armored', config: SIGN_CONFIG });
    const b = `=-sig-${randomToken(12)}`;
    entity = Buffer.concat([
      Buffer.from(`Content-Type: multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256; boundary="${b}"${CRLF}${CRLF}--${b}${CRLF}`),
      entity,
      Buffer.from(`${CRLF}--${b}${CRLF}Content-Type: application/pgp-signature; name="signature.asc"${CRLF}Content-Description: OpenPGP digital signature${CRLF}Content-Disposition: attachment; filename="signature.asc"${CRLF}${CRLF}${wrap(String(sig))}${CRLF}--${b}--${CRLF}`),
    ]);
  }
  if (o.encrypt) {
    const keys: openpgp.Key[] = [await openpgp.readKey({ armoredKey: own.public_armored })];
    for (const r of [...new Set(o.recipients.map((e) => e.trim().toLowerCase()).filter(Boolean))]) {
      const hit = await lookupKey(userId, r, fetchImpl);
      if (!hit.found) throw new PgpError(400, `No public key for ${r}`);
      const row = (await localKeyFor(userId, r))!;
      keys.push(await openpgp.readKey({ armoredKey: row.public_armored }));
    }
    let enc: string;
    try { enc = String(await openpgp.encrypt({ message: await openpgp.createMessage({ binary: entity }), encryptionKeys: keys, format: 'armored', config: SIGN_CONFIG })); }
    catch (e: any) { throw new PgpError(400, `Could not encrypt: ${e?.message ?? e}`); }
    const b = `=-enc-${randomToken(12)}`;
    entity = Buffer.from([
      `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"`, '',
      `--${b}`, 'Content-Type: application/pgp-encrypted', 'Content-Description: PGP/MIME version identification', '', 'Version: 1', '',
      `--${b}`, 'Content-Type: application/octet-stream; name="encrypted.asc"', 'Content-Description: OpenPGP encrypted message', 'Content-Disposition: inline; filename="encrypted.asc"', '', wrap(enc), '',
      `--${b}--`, '',
    ].join(CRLF));
  }
  const outerHead = outer.filter((b) => hname(b) !== 'mime-version');
  return Buffer.concat([Buffer.from(['MIME-Version: 1.0', ...outerHead].join(CRLF) + CRLF), entity]);
}

// ---------- reading ----------

export interface PgpStatus {
  encrypted: boolean;
  decrypted: boolean;
  signature: 'verified' | 'unverified' | 'bad' | 'none';
  signer?: string;          // name <email> of the verifying key
  fingerprint?: string;
  locked?: boolean;         // a passphrase is needed
  error?: string;
}

async function keyRing(userId: number): Promise<{ pub: openpgp.Key[]; own: PgpKeyRow[] }> {
  const rows = await q<PgpKeyRow>('SELECT * FROM pgp_keys WHERE user_id = ?', [userId]);
  const pub: openpgp.Key[] = [];
  for (const r of rows) { try { pub.push(await openpgp.readKey({ armoredKey: r.public_armored })); } catch { /* skip */ } }
  return { pub, own: rows.filter((r) => r.private_enc) };
}

async function sigResult(sigs: { keyID: openpgp.KeyID; verified: Promise<boolean> }[], pub: openpgp.Key[]): Promise<Pick<PgpStatus, 'signature' | 'signer' | 'fingerprint'>> {
  if (!sigs.length) return { signature: 'none' };
  let unknown = false;
  for (const s of sigs) {
    try {
      await s.verified;
      const key = pub.find((k) => k.getKeys(s.keyID).length > 0);
      const u = key ? primaryUser(key) : { name: '', email: '' };
      return { signature: 'verified', signer: u.name ? `${u.name} <${u.email}>` : u.email, fingerprint: key?.getFingerprint() };
    } catch (e: any) {
      if (/Could not find signing key|No signature|not found/i.test(String(e?.message))) unknown = true;
      else return { signature: 'bad' };
    }
  }
  return { signature: unknown ? 'unverified' : 'bad' };
}

async function verifyDetached(entity: Buffer, armoredSig: string, pub: openpgp.Key[]) {
  try {
    const res = await openpgp.verify({ message: await openpgp.createMessage({ binary: entity }), signature: await openpgp.readSignature({ armoredSignature: armoredSig }), verificationKeys: pub });
    return sigResult(res.signatures, pub);
  } catch { return { signature: 'bad' as const }; }
}

async function decryptArmored(userId: number, armored: string, passphrase: string | undefined, ring: Awaited<ReturnType<typeof keyRing>>):
  Promise<{ data: Buffer; sig: Pick<PgpStatus, 'signature' | 'signer' | 'fingerprint'> } | { error: string; locked?: boolean }> {
  let message: openpgp.Message<string>;
  try { message = await openpgp.readMessage({ armoredMessage: armored }); } catch { return { error: 'Damaged OpenPGP message' }; }
  if (!ring.own.length) return { error: 'You have no OpenPGP private key to decrypt this' };
  const keys: openpgp.PrivateKey[] = []; let locked = false;
  const wanted = new Set(message.getEncryptionKeyIDs().map((k) => k.toHex()));
  for (const r of ring.own) {
    let k = await openpgp.readPrivateKey({ armoredKey: decrypt(r.private_enc!) });
    if (wanted.size && !k.getKeys().some((sub) => wanted.has(sub.getKeyID().toHex()))) continue;
    if (!k.isDecrypted()) {
      if (!passphrase) { locked = true; continue; }
      try { k = await openpgp.decryptKey({ privateKey: k, passphrase }); } catch { return { error: 'Wrong passphrase', locked: true }; }
    }
    keys.push(k);
  }
  if (!keys.length) return locked ? { error: 'Enter the passphrase of your OpenPGP key to read this', locked: true } : { error: 'This message was not encrypted to any of your keys' };
  try {
    const res = await openpgp.decrypt({ message, decryptionKeys: keys, verificationKeys: ring.pub, format: 'binary' });
    return { data: Buffer.from(res.data as Uint8Array), sig: await sigResult(res.signatures, ring.pub) };
  } catch (e: any) { return { error: `Could not decrypt: ${e?.message ?? e}` }; }
}

const ARMOR_RE = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/;
const CLEAR_RE = /-----BEGIN PGP SIGNED MESSAGE-----[\s\S]*?-----END PGP SIGNATURE-----/;

export function looksPgp(parsed: ParsedMail): boolean {
  const ct = String((parsed.headers.get('content-type') as any)?.value ?? '').toLowerCase();
  if (ct === 'multipart/encrypted' || (ct === 'multipart/signed' && /pgp/i.test(String((parsed.headers.get('content-type') as any)?.params?.protocol ?? '')))) return true;
  const t = parsed.text ?? '';
  return t.includes('-----BEGIN PGP MESSAGE-----') || t.includes('-----BEGIN PGP SIGNED MESSAGE-----');
}

export interface PgpOpened { status: PgpStatus; parsed?: ParsedMail }

/** Detect and process PGP in a message: returns the badge status and, when decrypted, the parsed plaintext message (held in memory only). */
export async function openPgpMessage(userId: number, raw: Buffer, parsed: ParsedMail, passphrase?: string): Promise<PgpOpened | null> {
  if (!looksPgp(parsed)) return null;
  const ring = await keyRing(userId);
  const { head, body } = splitMessage(raw);
  const blocks = headerBlocks(head);
  const ct = ctParams(hvalue(blocks.find((b) => hname(b) === 'content-type') ?? 'Content-Type: text/plain'));
  const outerHeaders = blocks.filter((b) => !ENTITY_HEADERS.has(hname(b)) && hname(b) !== 'mime-version');

  // PGP/MIME encrypted
  if (ct.type === 'multipart/encrypted' && ct.params.boundary) {
    const parts = splitMultipart(body, ct.params.boundary);
    const encPart = parts[1] ? splitMessage(parts[1]) : null;
    const m = encPart?.body.toString('utf8').match(ARMOR_RE);
    if (!m) return { status: { encrypted: true, decrypted: false, signature: 'none', error: 'No encrypted data found' } };
    const dec = await decryptArmored(userId, m[0], passphrase, ring);
    if ('error' in dec) return { status: { encrypted: true, decrypted: false, signature: 'none', error: dec.error, locked: dec.locked } };
    let status: PgpStatus = { encrypted: true, decrypted: true, ...dec.sig };
    let entity = dec.data;
    const inner = splitMessage(entity);
    const ict = ctParams(hvalue(headerBlocks(inner.head).find((b) => hname(b) === 'content-type') ?? 'Content-Type: text/plain'));
    if (ict.type === 'multipart/signed' && ict.params.boundary) {
      const sp = splitMultipart(inner.body, ict.params.boundary);
      const sigBody = sp[1] ? splitMessage(sp[1]).body.toString('utf8') : '';
      if (sp[0]) status = { ...status, ...(await verifyDetached(sp[0], sigBody.match(/-----BEGIN PGP SIGNATURE-----[\s\S]*?-----END PGP SIGNATURE-----/)?.[0] ?? '', ring.pub)) };
    }
    const full = Buffer.concat([Buffer.from(['MIME-Version: 1.0', ...outerHeaders].join(CRLF) + CRLF), entity]);
    return { status, parsed: await simpleParser(full) };
  }

  // PGP/MIME signed
  if (ct.type === 'multipart/signed' && ct.params.boundary) {
    const parts = splitMultipart(body, ct.params.boundary);
    const sigBody = parts[1] ? splitMessage(parts[1]).body.toString('utf8') : '';
    const armored = sigBody.match(/-----BEGIN PGP SIGNATURE-----[\s\S]*?-----END PGP SIGNATURE-----/)?.[0];
    if (!parts[0] || !armored) return { status: { encrypted: false, decrypted: false, signature: 'unverified', error: 'Signature part missing' } };
    return { status: { encrypted: false, decrypted: false, ...(await verifyDetached(parts[0], armored, ring.pub)) } };
  }

  // inline armour in the text body
  const text = parsed.text ?? '';
  const enc = text.match(ARMOR_RE);
  if (enc) {
    const dec = await decryptArmored(userId, enc[0], passphrase, ring);
    if ('error' in dec) return { status: { encrypted: true, decrypted: false, signature: 'none', error: dec.error, locked: dec.locked } };
    const clone = Object.assign(Object.create(Object.getPrototypeOf(parsed)), parsed, { text: dec.data.toString('utf8'), html: false, textAsHtml: undefined });
    return { status: { encrypted: true, decrypted: true, ...dec.sig }, parsed: clone as ParsedMail };
  }
  const clear = text.match(CLEAR_RE);
  if (clear) {
    try {
      const cm = await openpgp.readCleartextMessage({ cleartextMessage: clear[0] });
      const res = await openpgp.verify({ message: cm, verificationKeys: ring.pub });
      return { status: { encrypted: false, decrypted: false, ...(await sigResult(res.signatures, ring.pub)) } };
    } catch { return { status: { encrypted: false, decrypted: false, signature: 'bad' } }; }
  }
  return null;
}

// ---------- .asc attachments ----------

export interface KeyOffer { partId: string; filename: string; fingerprint: string; email: string; name: string; known: boolean }

/** Public keys attached to a received message (`.asc` / application/pgp-keys) that could be imported. */
export async function keyOffers(userId: number, parsed: ParsedMail): Promise<KeyOffer[]> {
  const out: KeyOffer[] = [];
  const atts = parsed.attachments ?? [];
  for (let i = 0; i < atts.length; i++) {
    const a = atts[i];
    if (!/\.(asc|gpg|pgp)$/i.test(a.filename ?? '') && !/pgp-keys/i.test(a.contentType ?? '')) continue;
    if (a.content.length > 512 * 1024) continue;
    try {
      const text = a.content.toString('utf8');
      const key = text.includes('BEGIN PGP PUBLIC KEY') ? await openpgp.readKey({ armoredKey: text }) : null;
      if (!key) continue;
      const fp = key.getFingerprint(); const u = primaryUser(key);
      const known = !!(await one('SELECT 1 AS x FROM pgp_keys WHERE user_id = ? AND fingerprint = ?', [userId, fp]));
      out.push({ partId: String(i), filename: a.filename ?? 'key.asc', fingerprint: fp, email: u.email, name: u.name, known });
    } catch { /* not a key */ }
  }
  return out;
}

export async function importKeyFromParts(userId: number, parsed: ParsedMail, partId: number): Promise<PgpKeyApi> {
  const a = parsed.attachments?.[partId];
  if (!a) throw new PgpError(404, 'Attachment not found');
  const text = a.content.toString('utf8');
  if (!text.includes('BEGIN PGP PUBLIC KEY')) throw new PgpError(400, 'That attachment is not an armored public key');
  return importKey(userId, text, { kind: 'contact' });   // never treat a mailed key as one of your own
}
