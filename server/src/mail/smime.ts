/**
 * S/MIME (T6.5 F-39 part 2), server-side mode like OpenPGP: the PKCS#12 private key is stored encrypted under
 * SEAMLESS_SECRET. Pure JS (pkijs + asn1js for ASN.1/CMS, node:crypto for the bulk crypto).
 *
 * - sign: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256 (detached CMS SignedData)
 * - verify: the signature must match the signer certificate; the certificate chain is NOT checked against a trust store
 * - encrypt: application/pkcs7-mime; smime-type=enveloped-data (CMS EnvelopedData, AES-256-CBC, RSA key transport,
 *   also encrypted to the sender); recipients' certs are auto-collected from verified signed mail they sent
 * - decrypt: on view only; the plaintext is held in memory and never stored or indexed
 */
import crypto from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { simpleParser, type ParsedMail } from 'mailparser';
import { q, one, run } from '../db.ts';
import { encrypt, decrypt, randomToken } from '../crypto.ts';
import { splitMessage, headerBlocks, hname, hvalue, ctParams, ENTITY_HEADERS, splitMultipart } from './pgp.ts';

export class SmimeError extends Error { constructor(public status: number, msg: string) { super(msg); } }

pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: crypto.webcrypto as unknown as Crypto, subtle: crypto.webcrypto.subtle as unknown as SubtleCrypto }));
const cryptoEngine = () => pkijs.getCrypto(true)!;

const CRLF = '\r\n';
const OID = {
  data: '1.2.840.113549.1.7.1', signedData: '1.2.840.113549.1.7.2', envelopedData: '1.2.840.113549.1.7.3',
  rsaEncryption: '1.2.840.113549.1.1.1', rsaOaep: '1.2.840.113549.1.1.7',
  aes128cbc: '2.16.840.1.101.3.4.1.2', aes192cbc: '2.16.840.1.101.3.4.1.22', aes256cbc: '2.16.840.1.101.3.4.1.42', des3cbc: '1.2.840.113549.3.7',
  keyBag: '1.2.840.113549.1.12.10.1.1', shroudedKeyBag: '1.2.840.113549.1.12.10.1.2', certBag: '1.2.840.113549.1.12.10.1.3',
  email: '1.2.840.113549.1.9.1', cn: '2.5.4.3', san: '2.5.29.17',
};

export interface SmimeCertRow {
  id: number; user_id: number; identity_id: number | null; kind: 'own' | 'contact'; email: string; fingerprint: string;
  subject: string; issuer: string; serial: string; cert_pem: string; key_enc: string | null; not_after: number; created_at: number;
}
export interface SmimeCertApi {
  id: number; kind: 'own' | 'contact'; identityId: number | null; email: string; fingerprint: string; subject: string; issuer: string;
  hasPrivate: boolean; notAfter: number; expired: boolean; createdAt: number;
}

// ---------- small ASN.1 / cert helpers ----------

const ab = (b: Buffer | Uint8Array): ArrayBuffer => { const u = new Uint8Array(b.length); u.set(b); return u.buffer; };
const buf = (a: ArrayBuffer | Uint8Array): Buffer => Buffer.from(a instanceof ArrayBuffer ? new Uint8Array(a) : a);
const sha256hex = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const toPem = (der: Buffer, label = 'CERTIFICATE') => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END ${label}-----\n`;

function certFromDer(der: Buffer): pkijs.Certificate {
  const a = asn1js.fromBER(ab(der));
  if (a.offset === -1) throw new SmimeError(400, 'That is not a valid certificate');
  return new pkijs.Certificate({ schema: a.result });
}
function certFromPem(pem: string): pkijs.Certificate {
  const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!m) throw new SmimeError(400, 'That is not a PEM certificate');
  return certFromDer(Buffer.from(m[1].replace(/\s+/g, ''), 'base64'));
}
const certDer = (c: pkijs.Certificate): Buffer => buf(c.toSchema(true).toBER(false));

function dnString(name: pkijs.RelativeDistinguishedNames): string {
  const short: Record<string, string> = { '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU', [OID.email]: 'emailAddress' };
  return name.typesAndValues.map((tv) => `${short[tv.type] ?? tv.type}=${String((tv.value as any).valueBlock?.value ?? '')}`).join(', ');
}
const cnOf = (name: pkijs.RelativeDistinguishedNames): string => String(name.typesAndValues.find((t) => t.type === OID.cn)?.value.valueBlock.value ?? '');

/** E-mail addresses a certificate is valid for: subjectAltName rfc822Name first, then subject emailAddress. */
export function certEmails(c: pkijs.Certificate): string[] {
  const out: string[] = [];
  const san = c.extensions?.find((e) => e.extnID === OID.san);
  const names = (san?.parsedValue as pkijs.GeneralNames | undefined)?.names ?? [];
  for (const n of names) if (n.type === 1) out.push(String(n.value).toLowerCase());
  for (const tv of c.subject.typesAndValues) if (tv.type === OID.email) out.push(String(tv.value.valueBlock.value).toLowerCase());
  return [...new Set(out.filter((e) => e.includes('@')))];
}
const serialHex = (c: pkijs.Certificate) => buf(c.serialNumber.valueBlock.valueHexView).toString('hex').replace(/^0+(?=.)/, '');
const notAfterMs = (c: pkijs.Certificate) => c.notAfter.value.getTime();

function toApi(r: SmimeCertRow): SmimeCertApi {
  return { id: r.id, kind: r.kind, identityId: r.identity_id, email: r.email, fingerprint: r.fingerprint, subject: r.subject, issuer: r.issuer,
    hasPrivate: !!r.key_enc, notAfter: Number(r.not_after), expired: Number(r.not_after) < Date.now(), createdAt: Number(r.created_at) };
}

export async function listCerts(userId: number): Promise<SmimeCertApi[]> {
  return (await q<SmimeCertRow>('SELECT * FROM smime_certs WHERE user_id = ? ORDER BY kind, email, id', [userId])).map(toApi);
}

async function saveCert(userId: number, o: { kind: 'own' | 'contact'; identityId?: number | null; cert: pkijs.Certificate; email: string; keyPkcs8?: Buffer | null }): Promise<SmimeCertRow> {
  const der = certDer(o.cert);
  await run(`INSERT INTO smime_certs(user_id, identity_id, kind, email, fingerprint, subject, issuer, serial, cert_pem, key_enc, not_after, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT (user_id, fingerprint) DO UPDATE SET
               identity_id = COALESCE(excluded.identity_id, smime_certs.identity_id),
               key_enc = COALESCE(excluded.key_enc, smime_certs.key_enc),
               kind = CASE WHEN excluded.key_enc IS NOT NULL OR smime_certs.key_enc IS NOT NULL THEN 'own' ELSE smime_certs.kind END`,
    [userId, o.identityId ?? null, o.kind, o.email, sha256hex(der), dnString(o.cert.subject), dnString(o.cert.issuer), serialHex(o.cert), toPem(der),
      o.keyPkcs8 ? encrypt(toPem(o.keyPkcs8, 'PRIVATE KEY')) : null, notAfterMs(o.cert), Date.now()]);
  return (await one<SmimeCertRow>('SELECT * FROM smime_certs WHERE user_id = ? AND fingerprint = ?', [userId, sha256hex(der)]))!;
}

// ---------- PKCS#12 import ----------

/** Pull the end-entity certificate, its private key (PKCS#8 DER) and the rest of the chain out of a .p12/.pfx. */
async function parsePkcs12(data: Buffer, password: string): Promise<{ cert: pkijs.Certificate; key: Buffer; chain: pkijs.Certificate[] }> {
  const pw = ab(Buffer.from(password, 'utf8'));
  let pfx: pkijs.PFX;
  try {
    const asn = asn1js.fromBER(ab(data));
    if (asn.offset === -1) throw new Error('asn1');
    pfx = new pkijs.PFX({ schema: asn.result });
  } catch { throw new SmimeError(400, 'That is not a PKCS#12 (.p12 / .pfx) file'); }
  try {
    await pfx.parseInternalValues({ password: pw, checkIntegrity: true });
    const auth = pfx.parsedValue!.authenticatedSafe!;
    await auth.parseInternalValues({ safeContents: auth.safeContents.map(() => ({ password: pw })) });
    const certs: pkijs.Certificate[] = []; const keys: Buffer[] = [];
    for (const sc of auth.parsedValue.safeContents) {
      for (const bag of sc.value.safeBags) {
        if (bag.bagId === OID.certBag) {
          const cb = bag.bagValue as pkijs.CertBag;
          if (cb.parsedValue instanceof pkijs.Certificate) certs.push(cb.parsedValue);
        } else if (bag.bagId === OID.shroudedKeyBag) {
          const kb = bag.bagValue as any;   // parseInternalValues is protected in the typings
          await kb.parseInternalValues({ password: pw });
          keys.push(buf(kb.parsedValue.toSchema().toBER(false)));
        } else if (bag.bagId === OID.keyBag) {
          keys.push(buf((bag.bagValue as pkijs.PrivateKeyInfo).toSchema().toBER(false)));
        }
      }
    }
    if (!keys.length) throw new SmimeError(400, 'The file holds no private key');
    // the end-entity cert is the one whose public key matches the private key
    const priv = crypto.createPrivateKey({ key: keys[0], format: 'der', type: 'pkcs8' });
    const pubDer = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
    const cert = certs.find((c) => buf(c.subjectPublicKeyInfo.toSchema().toBER(false)).equals(pubDer));
    if (!cert) throw new SmimeError(400, 'The file holds no certificate for its private key');
    return { cert, key: keys[0], chain: certs.filter((c) => c !== cert) };
  } catch (e: any) {
    if (e instanceof SmimeError) throw e;
    throw new SmimeError(400, /integrity|mac|password|decrypt/i.test(String(e?.message)) || !e?.message ? 'Wrong password, or an unsupported PKCS#12 encryption (re-export it with modern AES encryption)' : `Could not read the PKCS#12 file (${e.message}). If it uses old RC2 / 3DES encryption, re-export it with AES, e.g. without openssl's -legacy option`);
  }
}

/** Import a PKCS#12 bundle for an identity (the key is stored encrypted). */
export async function importPkcs12(userId: number, o: { identityId?: number | null; data: Buffer; password: string }): Promise<SmimeCertApi> {
  if (!o.data.length || o.data.length > 256 * 1024) throw new SmimeError(400, 'Choose a .p12 / .pfx file (under 256 KB)');
  const ident = o.identityId != null ? await one<{ id: number; email: string }>('SELECT id, email FROM identities WHERE id = ? AND user_id = ?', [Number(o.identityId), userId]) : null;
  if (o.identityId != null && !ident) throw new SmimeError(404, 'Unknown identity');
  const { cert, key } = await parsePkcs12(o.data, o.password ?? '');
  const emails = certEmails(cert);
  const email = ident && emails.includes(ident.email.toLowerCase()) ? ident.email.toLowerCase() : (emails[0] ?? ident?.email.toLowerCase() ?? '');
  if (!email) throw new SmimeError(400, 'The certificate has no email address');
  if (ident && !emails.includes(ident.email.toLowerCase())) throw new SmimeError(400, `That certificate is for ${emails.join(', ') || 'another address'}, not ${ident.email}`);
  return toApi(await saveCert(userId, { kind: 'own', identityId: ident?.id ?? null, cert, email, keyPkcs8: key }));
}

/** Import a contact's certificate (PEM or DER). */
export async function importCert(userId: number, data: Buffer): Promise<SmimeCertApi> {
  const text = data.toString('utf8');
  const cert = text.includes('BEGIN CERTIFICATE') ? certFromPem(text) : certFromDer(data);
  const email = certEmails(cert)[0];
  if (!email) throw new SmimeError(400, 'The certificate has no email address');
  return toApi(await saveCert(userId, { kind: 'contact', cert, email }));
}

export async function deleteCert(userId: number, id: number): Promise<void> {
  if (!(await run('DELETE FROM smime_certs WHERE id = ? AND user_id = ?', [id, userId]))) throw new SmimeError(404, 'Certificate not found');
}
export async function exportCert(userId: number, id: number): Promise<{ pem: string; filename: string }> {
  const r = await one<SmimeCertRow>('SELECT * FROM smime_certs WHERE id = ? AND user_id = ?', [id, userId]);
  if (!r) throw new SmimeError(404, 'Certificate not found');
  return { pem: r.cert_pem, filename: `${r.email}.pem` };
}

// ---------- which certs ----------

async function ownCertRow(userId: number, fromEmail: string, identityId?: number | null): Promise<SmimeCertRow | null> {
  const now = Date.now();
  if (identityId != null) {
    const r = await one<SmimeCertRow>('SELECT * FROM smime_certs WHERE user_id = ? AND identity_id = ? AND key_enc IS NOT NULL AND not_after > ? ORDER BY id DESC LIMIT 1', [userId, identityId, now]);
    if (r) return r;
  }
  return (await one<SmimeCertRow>('SELECT * FROM smime_certs WHERE user_id = ? AND key_enc IS NOT NULL AND lower(email) = ? AND not_after > ? ORDER BY id DESC LIMIT 1', [userId, fromEmail.trim().toLowerCase(), now])) ?? null;
}
/** A usable (not expired) certificate for a recipient, taken from the user's collected / imported certs. */
export async function certFor(userId: number, email: string): Promise<SmimeCertRow | null> {
  return (await one<SmimeCertRow>("SELECT * FROM smime_certs WHERE user_id = ? AND lower(email) = ? AND not_after > ? ORDER BY (kind = 'contact') DESC, id DESC LIMIT 1", [userId, email.trim().toLowerCase(), Date.now()])) ?? null;
}

export interface SmimeCompose { canSign: boolean; signReason?: string; canEncrypt: boolean; encryptReason?: string; missing: string[] }
export async function composeCheck(userId: number, o: { fromEmail: string; identityId?: number | null; to?: string[]; cc?: string[]; bcc?: string[] }): Promise<SmimeCompose> {
  const own = await ownCertRow(userId, o.fromEmail, o.identityId);
  const rcpts = [...new Set([...(o.to ?? []), ...(o.cc ?? []), ...(o.bcc ?? [])].map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  const missing: string[] = [];
  for (const r of rcpts) if (!(await certFor(userId, r))) missing.push(r);
  const res: SmimeCompose = { canSign: !!own, canEncrypt: true, missing };
  if (!own) res.signReason = `No S/MIME certificate for ${o.fromEmail} — import a .p12 in Settings → Encryption`;
  if (!rcpts.length) { res.canEncrypt = false; res.encryptReason = 'Add a recipient first'; }
  else if (missing.length) { res.canEncrypt = false; res.encryptReason = `No S/MIME certificate for ${missing.join(', ')} (one is collected when they send you signed mail)`; }
  else if (!own) { res.canEncrypt = false; res.encryptReason = `No S/MIME certificate for ${o.fromEmail} to read your own Sent copy`; }
  return res;
}

// ---------- sending ----------

const wrap64 = (b: Buffer) => b.toString('base64').replace(/(.{76})/g, '$1' + CRLF).replace(/\s+$/, '');

async function privateKeyOf(row: SmimeCertRow): Promise<{ node: crypto.KeyObject; pkcs8: Buffer }> {
  const pem = decrypt(row.key_enc!);
  return { node: crypto.createPrivateKey(pem), pkcs8: Buffer.from(pem.replace(/-----[A-Z ]+-----|\s+/g, ''), 'base64') };
}

async function signDetached(entity: Buffer, row: SmimeCertRow): Promise<Buffer> {
  const cert = certFromPem(row.cert_pem);
  const { pkcs8, node } = await privateKeyOf(row);
  const isEc = node.asymmetricKeyType === 'ec';
  const subtle = crypto.webcrypto.subtle;
  const keyAlg = isEc ? { name: 'ECDSA', namedCurve: (node.asymmetricKeyDetails as any)?.namedCurve === 'prime256v1' ? 'P-256' : String((node.asymmetricKeyDetails as any)?.namedCurve) } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const cryptoKey = await subtle.importKey('pkcs8', ab(pkcs8), keyAlg as any, false, ['sign']);

  const digest = crypto.createHash('sha256').update(entity).digest();
  const signed = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),   // detached: no eContent
    signerInfos: [new pkijs.SignerInfo({
      version: 1,
      sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
      signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: [
        new pkijs.Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
        new pkijs.Attribute({ type: '1.2.840.113549.1.9.5', values: [new asn1js.UTCTime({ valueDate: new Date() })] }),
        new pkijs.Attribute({ type: '1.2.840.113549.1.9.4', values: [new asn1js.OctetString({ valueHex: ab(digest) })] }),
      ] }),
    })],
    certificates: [cert],
  });
  await signed.sign(cryptoKey, 0, 'SHA-256', ab(entity));
  const ci = new pkijs.ContentInfo({ contentType: OID.signedData, content: signed.toSchema(true) });
  return buf(ci.toSchema().toBER(false));
}

/** AES-256-CBC enveloped data for the given RSA certificates. */
function envelope(content: Buffer, certs: pkijs.Certificate[]): Buffer {
  const cek = crypto.randomBytes(32); const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', cek, iv);
  const enc = Buffer.concat([c.update(content), c.final()]);
  const recipientInfos = certs.map((cert) => {
    const spki = crypto.createPublicKey({ key: buf(cert.subjectPublicKeyInfo.toSchema().toBER(false)), format: 'der', type: 'spki' });
    if (spki.asymmetricKeyType !== 'rsa') throw new SmimeError(400, 'Only RSA certificates can be used to encrypt');
    const wrapped = crypto.publicEncrypt({ key: spki, padding: crypto.constants.RSA_PKCS1_PADDING }, cek);   // RSAES-PKCS1-v1_5: what every S/MIME client reads
    return new pkijs.RecipientInfo({ variant: 1, value: new pkijs.KeyTransRecipientInfo({
      version: 0,
      rid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
      keyEncryptionAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.rsaEncryption, algorithmParams: new asn1js.Null() }),
      encryptedKey: new asn1js.OctetString({ valueHex: ab(wrapped) }),
    }) });
  });
  const env = new pkijs.EnvelopedData({
    version: 0, recipientInfos,
    encryptedContentInfo: new pkijs.EncryptedContentInfo({
      contentType: OID.data,
      contentEncryptionAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.aes256cbc, algorithmParams: new asn1js.OctetString({ valueHex: ab(iv) }) }),
      encryptedContent: new asn1js.OctetString({ valueHex: ab(enc) }),
    }),
  });
  return buf(new pkijs.ContentInfo({ contentType: OID.envelopedData, content: env.toSchema() }).toSchema().toBER(false));
}

/** Wrap a built RFC 5322 message in S/MIME multipart/signed and/or application/pkcs7-mime (signed, then encrypted). */
export async function protectMessage(userId: number, raw: Buffer, o: {
  sign: boolean; encrypt: boolean; fromEmail: string; identityId?: number | null; recipients: string[];
}): Promise<Buffer> {
  if (!o.sign && !o.encrypt) return raw;
  const own = await ownCertRow(userId, o.fromEmail, o.identityId);
  if (!own) throw new SmimeError(400, `No S/MIME certificate for ${o.fromEmail}`);
  const { head, body } = splitMessage(raw);
  const blocks = headerBlocks(head);
  const outer = blocks.filter((b) => !ENTITY_HEADERS.has(hname(b)));
  const inner = blocks.filter((b) => ENTITY_HEADERS.has(hname(b)));
  let entity = Buffer.concat([Buffer.from(inner.join(CRLF) + CRLF + CRLF), body]);

  if (o.sign) {
    const sig = await signDetached(entity, own);
    const b = `=-sms-${randomToken(12)}`;
    entity = Buffer.concat([
      Buffer.from(`Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="${b}"${CRLF}${CRLF}--${b}${CRLF}`),
      entity,
      Buffer.from(`${CRLF}--${b}${CRLF}Content-Type: application/pkcs7-signature; name="smime.p7s"${CRLF}Content-Transfer-Encoding: base64${CRLF}Content-Disposition: attachment; filename="smime.p7s"${CRLF}Content-Description: S/MIME Cryptographic Signature${CRLF}${CRLF}${wrap64(sig)}${CRLF}--${b}--${CRLF}`),
    ]);
  }
  if (o.encrypt) {
    const certs: pkijs.Certificate[] = [certFromPem(own.cert_pem)];
    for (const r of [...new Set(o.recipients.map((e) => e.trim().toLowerCase()).filter(Boolean))]) {
      const row = await certFor(userId, r);
      if (!row) throw new SmimeError(400, `No S/MIME certificate for ${r}`);
      certs.push(certFromPem(row.cert_pem));
    }
    const der = envelope(entity, certs);
    entity = Buffer.from([
      'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"', 'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="smime.p7m"', 'Content-Description: S/MIME Encrypted Message', '', wrap64(der), '',
    ].join(CRLF));
  }
  const outerHead = outer.filter((b) => hname(b) !== 'mime-version');
  return Buffer.concat([Buffer.from(['MIME-Version: 1.0', ...outerHead].join(CRLF) + CRLF), entity]);
}

// ---------- reading ----------

export interface SmimeStatus {
  encrypted: boolean;
  decrypted: boolean;
  signature: 'verified' | 'unverified' | 'bad' | 'none';
  signer?: string;          // "CN <email>"
  issuer?: string;
  fingerprint?: string;
  error?: string;
}

/** Bytes of an OCTET STRING, primitive or constructed (BER chunks, as openssl writes for streamed content). */
function octets(o: asn1js.OctetString): Buffer {
  if (!o.idBlock.isConstructed) return buf(o.valueBlock.valueHexView);
  return Buffer.concat((o.valueBlock.value as any[]).map((c) => octets(c)));
}

function contentInfo(der: Buffer): pkijs.ContentInfo | null {
  try { const a = asn1js.fromBER(ab(der)); return a.offset === -1 ? null : new pkijs.ContentInfo({ schema: a.result }); } catch { return null; }
}
const decodeBody = (partBody: Buffer, cte: string): Buffer => {
  const t = cte.toLowerCase();
  if (t === 'base64') return Buffer.from(partBody.toString('latin1').replace(/\s+/g, ''), 'base64');
  return partBody;
};

/** Certificates that travelled inside a SignedData -> the signer's. */
function signerCert(sd: pkijs.SignedData): pkijs.Certificate | null {
  const si = sd.signerInfos[0];
  if (!si || !(si.sid instanceof pkijs.IssuerAndSerialNumber)) return null;
  const sid = si.sid;
  for (const c of sd.certificates ?? []) {
    if (c instanceof pkijs.Certificate && c.serialNumber.isEqual(sid.serialNumber) && c.issuer.isEqual(sid.issuer)) return c;
  }
  return null;
}

async function verifySigned(userId: number, entity: Buffer | null, p7: Buffer, fromEmail: string | null): Promise<SmimeStatus> {
  const none = { encrypted: false, decrypted: false };
  const ci = contentInfo(p7);
  if (!ci || ci.contentType !== OID.signedData) return { ...none, signature: 'unverified', error: 'Signature part is not a CMS signature' };
  let sd: pkijs.SignedData;
  try { sd = new pkijs.SignedData({ schema: ci.content }); } catch { return { ...none, signature: 'bad', error: 'Damaged signature' }; }
  const cert = signerCert(sd);
  if (!cert) return { ...none, signature: 'unverified', error: 'The signature carries no signer certificate' };
  let ok = false;
  // checkChain stays off: the chain is deliberately not checked against a trust store
  const attempt = async (data: Buffer | null) => {
    try {
      const params: any = { signer: 0, checkChain: false, trustedCerts: [], extendedMode: true };
      if (data) params.data = ab(data);
      const res: any = await sd.verify(params);
      return res === true || res?.signatureVerified === true;
    } catch { return false; }
  };
  ok = await attempt(entity);
  // S/MIME signs the canonical CRLF form: mail that lost its CR on the way gets one retry with CRLF line ends
  if (!ok && entity && /[^\r]\n/.test(entity.toString('latin1'))) ok = await attempt(Buffer.from(entity.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1'));
  const emails = certEmails(cert);
  const signer = `${cnOf(cert.subject) || emails[0] || dnString(cert.subject)}${emails[0] ? ` <${emails[0]}>` : ''}`;
  const base = { ...none, signer, issuer: cnOf(cert.issuer) || dnString(cert.issuer), fingerprint: sha256hex(certDer(cert)) };
  if (!ok) return { ...base, signature: 'bad' };
  if (fromEmail && !emails.includes(fromEmail.toLowerCase())) {
    return { ...base, signature: 'unverified', error: `Signed by ${signer}, which is not the sender address (${fromEmail})` };
  }
  // collect the certificate for later encryption to this person
  if (fromEmail && notAfterMs(cert) > Date.now()) {
    await saveCert(userId, { kind: 'contact', cert, email: fromEmail.toLowerCase() }).catch(() => {});
  }
  return { ...base, signature: 'verified' };
}

const PKCS1_UNPAD = (em: Buffer): Buffer | null => {
  if (em[0] !== 0 || em[1] !== 2) return null;
  const i = em.indexOf(0, 2);
  return i < 10 ? null : em.subarray(i + 1);
};

function rsaUnwrap(key: crypto.KeyObject, wrapped: Buffer, alg: pkijs.AlgorithmIdentifier): Buffer | null {
  try {
    if (alg.algorithmId === OID.rsaOaep) {
      let hash = 'sha1';
      try {
        const p = new pkijs.RSAESOAEPParams({ schema: alg.algorithmParams });
        const h = p.hashAlgorithm.algorithmId;
        hash = h === '2.16.840.1.101.3.4.2.1' ? 'sha256' : h === '2.16.840.1.101.3.4.2.2' ? 'sha384' : h === '2.16.840.1.101.3.4.2.3' ? 'sha512' : 'sha1';
      } catch { /* defaults */ }
      return crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: hash }, wrapped);
    }
    // PKCS#1 v1.5: Node refuses RSA_PKCS1_PADDING for decryption (Marvin), so decrypt raw and unpad here
    return PKCS1_UNPAD(crypto.privateDecrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, wrapped));
  } catch { return null; }
}

function decryptEnveloped(userId: number, ci: pkijs.ContentInfo, rows: SmimeCertRow[]): Buffer | { error: string } {
  let env: pkijs.EnvelopedData;
  try { env = new pkijs.EnvelopedData({ schema: ci.content }); } catch { return { error: 'Damaged S/MIME message' }; }
  const eci = env.encryptedContentInfo;
  const cipherName = ({ [OID.aes128cbc]: 'aes-128-cbc', [OID.aes192cbc]: 'aes-192-cbc', [OID.aes256cbc]: 'aes-256-cbc', [OID.des3cbc]: 'des-ede3-cbc' } as Record<string, string>)[eci.contentEncryptionAlgorithm.algorithmId];
  if (!cipherName) return { error: `Unsupported content encryption (${eci.contentEncryptionAlgorithm.algorithmId})` };
  const iv = buf((eci.contentEncryptionAlgorithm.algorithmParams as asn1js.OctetString).valueBlock.valueHexView);
  const encrypted = eci.encryptedContent ? octets(eci.encryptedContent) : Buffer.alloc(0);
  let mine = false;
  for (const ri of env.recipientInfos) {
    if (ri.variant !== 1) continue;
    const ktri = ri.value as pkijs.KeyTransRecipientInfo;
    if (!(ktri.rid instanceof pkijs.IssuerAndSerialNumber)) continue;
    const rid = ktri.rid;
    for (const row of rows) {
      const cert = certFromPem(row.cert_pem);
      if (!(cert.serialNumber.isEqual(rid.serialNumber) && cert.issuer.isEqual(rid.issuer))) continue;
      mine = true;
      const cek = rsaUnwrap(crypto.createPrivateKey(decrypt(row.key_enc!)), buf(ktri.encryptedKey.valueBlock.valueHexView), ktri.keyEncryptionAlgorithm);
      if (!cek) continue;
      try {
        const d = crypto.createDecipheriv(cipherName, cek, iv);
        return Buffer.concat([d.update(encrypted), d.final()]);
      } catch { return { error: 'Could not decrypt: the message is damaged' }; }
    }
  }
  return { error: mine ? 'Could not decrypt with your S/MIME key' : 'This message was not encrypted to any of your S/MIME certificates' };
}

export function looksSmime(parsed: ParsedMail): boolean {
  const ct = (parsed.headers.get('content-type') as any);
  const type = String(ct?.value ?? '').toLowerCase();
  if (type === 'multipart/signed') return /pkcs7-signature/i.test(String(ct?.params?.protocol ?? ''));
  if (type === 'application/pkcs7-mime' || type === 'application/x-pkcs7-mime') return true;
  return false;
}

export interface SmimeOpened { status: SmimeStatus; parsed?: ParsedMail }

export async function openSmimeMessage(userId: number, raw: Buffer, parsed: ParsedMail): Promise<SmimeOpened | null> {
  if (!looksSmime(parsed)) return null;
  const { head, body } = splitMessage(raw);
  const blocks = headerBlocks(head);
  const ct = ctParams(hvalue(blocks.find((b) => hname(b) === 'content-type') ?? 'Content-Type: text/plain'));
  const cte = hvalue(blocks.find((b) => hname(b) === 'content-transfer-encoding') ?? 'x: 7bit');
  const outerHeaders = blocks.filter((b) => !ENTITY_HEADERS.has(hname(b)) && hname(b) !== 'mime-version');
  const from = (parsed.from?.value?.[0]?.address ?? '').toLowerCase() || null;

  if (ct.type === 'multipart/signed' && ct.params.boundary) {
    const parts = splitMultipart(body, ct.params.boundary);
    if (parts.length < 2) return { status: { encrypted: false, decrypted: false, signature: 'unverified', error: 'Signature part missing' } };
    const sp = splitMessage(parts[1]);
    const scte = hvalue(headerBlocks(sp.head).find((b) => hname(b) === 'content-transfer-encoding') ?? 'x: 7bit');
    return { status: await verifySigned(userId, parts[0], decodeBody(sp.body, scte), from) };
  }

  // application/pkcs7-mime: enveloped-data (or signed-data with the content inside)
  const der = decodeBody(body, cte);
  const ci = contentInfo(der);
  if (!ci) return { status: { encrypted: false, decrypted: false, signature: 'none', error: 'Damaged S/MIME message' } };
  if (ci.contentType === OID.signedData) {   // opaque-signed
    try {
      const sd = new pkijs.SignedData({ schema: ci.content });
      const inner = sd.encapContentInfo.eContent;
      const content = inner ? octets(inner) : null;
      if (!content) return { status: { encrypted: false, decrypted: false, signature: 'unverified', error: 'No signed content' } };
      const status = await verifySigned(userId, null, der, from);
      return { status, parsed: await simpleParser(Buffer.concat([Buffer.from(['MIME-Version: 1.0', ...outerHeaders].join(CRLF) + CRLF), content])) };
    } catch { return { status: { encrypted: false, decrypted: false, signature: 'bad', error: 'Damaged signature' } }; }
  }
  if (ci.contentType !== OID.envelopedData) return { status: { encrypted: false, decrypted: false, signature: 'none', error: 'Unsupported S/MIME content' } };
  const rows = await q<SmimeCertRow>('SELECT * FROM smime_certs WHERE user_id = ? AND key_enc IS NOT NULL', [userId]);
  if (!rows.length) return { status: { encrypted: true, decrypted: false, signature: 'none', error: 'You have no S/MIME private key to decrypt this' } };
  const dec = decryptEnveloped(userId, ci, rows);
  if (!Buffer.isBuffer(dec)) return { status: { encrypted: true, decrypted: false, signature: 'none', error: dec.error } };

  let status: SmimeStatus = { encrypted: true, decrypted: true, signature: 'none' };
  const inner = splitMessage(dec);
  const ict = ctParams(hvalue(headerBlocks(inner.head).find((b) => hname(b) === 'content-type') ?? 'Content-Type: text/plain'));
  if (ict.type === 'multipart/signed' && ict.params.boundary) {
    const sp = splitMultipart(inner.body, ict.params.boundary);
    if (sp.length >= 2) {
      const sig = splitMessage(sp[1]);
      const scte = hvalue(headerBlocks(sig.head).find((b) => hname(b) === 'content-transfer-encoding') ?? 'x: 7bit');
      status = { ...status, ...(await verifySigned(userId, sp[0], decodeBody(sig.body, scte), from)), encrypted: true, decrypted: true };
    }
  }
  return { status, parsed: await simpleParser(Buffer.concat([Buffer.from(['MIME-Version: 1.0', ...outerHeaders].join(CRLF) + CRLF), dec])) };
}
