import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type pg from 'pg';
import { q, pool, migrate } from '../db.ts';
import { keyFromSecret, encryptWith, decryptWith, LOCAL_KEY } from '../crypto.ts';
import { getBlob, putBlob } from '../s3.ts';
import {
  dumpDatabase, replayDump, queryFnOf,
  type QueryFn, type RowTransform,
} from './engine.ts';
import { referencedKeys } from './mirror.ts';
import { saveMailStoreConfig, adoptRestoredMailStore, verifyMailBlobs, type BlobCheck } from './mailref.ts';

/** Portable export (F-28 part 2): ONE password-protected file that carries the whole instance, so it
 *  can be imported on a server that has a different SEAMLESS_SECRET.
 *
 *    "SEAMLESS-EXPORT v1\n" | salt(16) | log2N(1) r(1) p(1) | iv(12) | tag(16) | AES-256-GCM ciphertext
 *    key = scrypt(password, salt, N, r, p); the header up to and including iv is the GCM AAD.
 *    plaintext = gzip( container ),  container = repeated [u32 nameLen][name][u32 dataLen][data]
 *      manifest.json        schemaVersion, appVersion, createdAt, counts per table, blob count
 *      data.ndjson          the backup engine's table dump; every secret re-encrypted password-key
 *      blobs/<mail key>     optional .eml objects (includeMail)
 *
 *  Secrets inside the dump (`*_enc` columns and settings.mail_s3) are re-encrypted from the local
 *  SEAMLESS_SECRET to a key derived from the export password, and back to the importing server's
 *  secret on import — so the file never depends on either server's secret. */

const MAGIC = Buffer.from('SEAMLESS-EXPORT v1\n', 'utf8');
const SCRYPT = { logN: 15, r: 8, p: 1 };
export const MIN_PASSWORD = 12;
const BLOB_CONCURRENCY = 8;

export class ExportError extends Error {
  constructor(message: string, public code: 'password' | 'format' | 'schema' | 'not-empty' | 'bad-request' = 'bad-request') { super(message); }
}

export interface ExportManifest {
  format: 'seamless-export';
  v: 1;
  schemaVersion: number;
  appVersion: string;
  createdAt: number;
  tables: Record<string, number>;
  rows: number;
  blobs: number;
  includesMail: boolean;
}

// ---- container ----

function pack(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const h = Buffer.alloc(4); h.writeUInt32BE(name.length);
    const l = Buffer.alloc(4); l.writeUInt32BE(e.data.length);
    parts.push(h, name, l, e.data);
  }
  return Buffer.concat(parts);
}

function unpack(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let o = 0;
  while (o < buf.length) {
    if (o + 4 > buf.length) throw new ExportError('export file is truncated', 'format');
    const nl = buf.readUInt32BE(o); o += 4;
    const name = buf.subarray(o, o + nl).toString('utf8'); o += nl;
    if (o + 4 > buf.length) throw new ExportError('export file is truncated', 'format');
    const dl = buf.readUInt32BE(o); o += 4;
    if (o + dl > buf.length) throw new ExportError('export file is truncated', 'format');
    out.set(name, buf.subarray(o, o + dl)); o += dl;
  }
  return out;
}

const deriveKey = (password: string, salt: Buffer, logN: number, r: number, p: number) =>
  crypto.scryptSync(password, salt, 32, { N: 2 ** logN, r, p, maxmem: 256 * 1024 * 1024 });

function seal(password: string, plain: Buffer): Buffer {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const head = Buffer.concat([MAGIC, salt, Buffer.from([SCRYPT.logN, SCRYPT.r, SCRYPT.p]), iv]);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(password, salt, SCRYPT.logN, SCRYPT.r, SCRYPT.p), iv);
  c.setAAD(head);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([head, c.getAuthTag(), ct]);
}

function open(password: string, file: Buffer): Buffer {
  const headLen = MAGIC.length + 16 + 3 + 12;
  if (file.length < headLen + 16 || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ExportError('this is not a Seamless export file', 'format');
  }
  const head = file.subarray(0, headLen);
  const salt = head.subarray(MAGIC.length, MAGIC.length + 16);
  const [logN, r, p] = head.subarray(MAGIC.length + 16, MAGIC.length + 19);
  if (logN > 20 || r > 16 || p > 4) throw new ExportError('export file has unsupported key parameters', 'format');
  const iv = head.subarray(headLen - 12);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(password, salt, logN, r, p), iv);
    d.setAAD(head);
    d.setAuthTag(file.subarray(headLen, headLen + 16));
    return Buffer.concat([d.update(file.subarray(headLen + 16)), d.final()]);
  } catch {
    throw new ExportError('wrong password, or the export file is damaged', 'password');
  }
}

// ---- secrets ----

/** Rewrites every secret in a dump row from one key to another. */
function reencryptor(from: Buffer, to: Buffer): RowTransform {
  const swap = (v: unknown, where: string) => {
    if (typeof v !== 'string' || v === '') return v;
    try { return encryptWith(to, decryptWith(from, v)); }
    catch { throw new ExportError(`cannot re-encrypt ${where}: the secret does not match (is SEAMLESS_SECRET the one this data was written with?)`, 'format'); }
  };
  return (table, names, row) => {
    const out = row.slice();
    names.forEach((n, i) => { if (n.endsWith('_enc')) out[i] = swap(row[i], `${table}.${n}`); });
    if (table === 'settings') {
      const k = names.indexOf('key'), v = names.indexOf('value');
      if (k >= 0 && v >= 0 && row[k] === 'mail_s3') out[v] = swap(row[v], 'settings.mail_s3');
    }
    return out;
  };
}

async function schemaVersionOf(query: QueryFn): Promise<number> {
  const rows = await query('SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations');
  return Number(rows[0]?.v ?? 0);
}

async function pool_<T>(items: T[], fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, items.length) }, async () => {
    while (i < items.length) { const x = items[i++]; await fn(x); }
  }));
}

// ---- export ----

export interface CreateExportOpts {
  password: string;
  includeMail?: boolean;
  appVersion?: string;
  /** injectable for tests: the secret the local database was written with (default: SEAMLESS_SECRET) */
  secret?: string;
  query?: QueryFn;
  mailSource?: (key: string) => Promise<Buffer>;
  mailKeys?: string[];
}

export async function createExport(opts: CreateExportOpts): Promise<{ file: Buffer; manifest: ExportManifest }> {
  if (!opts.password || opts.password.length < MIN_PASSWORD) throw new ExportError(`password must be at least ${MIN_PASSWORD} characters`);
  const query = opts.query ?? q;
  const local = opts.secret ? keyFromSecret(opts.secret) : LOCAL_KEY;
  const { text, counts, rows } = await dumpDatabase({ query, transform: reencryptor(local, keyFromSecret(opts.password)) });

  const entries: { name: string; data: Buffer }[] = [{ name: 'data.ndjson', data: Buffer.from(text, 'utf8') }];
  let blobs = 0;
  if (opts.includeMail) {
    const read = opts.mailSource ?? getBlob;
    const keys = opts.mailKeys ?? await referencedKeys();
    await pool_(keys, async (key) => {
      try { entries.push({ name: `blobs/${key}`, data: await read(key) }); blobs++; }
      catch { /* a blob the store no longer has is skipped; the import reports the shortfall */ }
    });
  }
  const manifest: ExportManifest = {
    format: 'seamless-export', v: 1, schemaVersion: await schemaVersionOf(query),
    appVersion: opts.appVersion ?? 'unknown', createdAt: Date.now(), tables: counts, rows, blobs, includesMail: !!opts.includeMail,
  };
  entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  return { file: seal(opts.password, gzipSync(pack(entries), { level: 6 })), manifest };
}

// ---- import ----

interface Parsed { manifest: ExportManifest; lines: string[]; blobs: Map<string, Buffer> }

function parse(file: Buffer, password: string): Parsed {
  let entries: Map<string, Buffer>;
  try { entries = unpack(gunzipSync(open(password, file))); }
  catch (err) { if (err instanceof ExportError) throw err; throw new ExportError('export file is damaged', 'format'); }
  const m = entries.get('manifest.json'), d = entries.get('data.ndjson');
  if (!m || !d) throw new ExportError('export file is incomplete', 'format');
  const manifest = JSON.parse(m.toString('utf8')) as ExportManifest;
  if (manifest.format !== 'seamless-export' || manifest.v !== 1) throw new ExportError('unsupported export version', 'format');
  const text = d.toString('utf8');
  const blobs = new Map<string, Buffer>();
  for (const [name, data] of entries) if (name.startsWith('blobs/')) blobs.set(name.slice(6), data);
  return { manifest, lines: text ? text.split('\n') : [], blobs };
}

export interface ImportReport {
  mode: 'full' | 'settings';
  manifest: ExportManifest;
  tables?: Record<string, number>;
  rows?: number;
  blobsWritten?: number;
  mailStore?: { bucket: string; endpoint: string; adopted: boolean };
  blobCheck?: BlobCheck;
  added?: Record<string, number>;
  skipped?: Record<string, number>;
}

export interface ImportOpts {
  mode: 'full' | 'settings';
  /** other database (tests); default is the app pool, in which case the mail store is reconnected + verified */
  db?: pg.Pool;
  /** secret of the importing server (default SEAMLESS_SECRET) */
  secret?: string;
  /** settings mode: user receiving the settings */
  userId?: number;
  putMailBlob?: (key: string, body: Buffer) => Promise<void>;
}

/** Decrypts + validates the whole file BEFORE touching any table, so a wrong password writes nothing. */
export async function importExport(file: Buffer, password: string, opts: ImportOpts): Promise<ImportReport> {
  const parsed = parse(file, password);
  const db = opts.db ?? pool;
  const dbq = queryFnOf(db);
  if (opts.db === undefined) await migrate(); // a fresh box has no schema yet
  const localAfter = await schemaVersionOf(dbq);
  if (parsed.manifest.schemaVersion > localAfter) {
    throw new ExportError(`this export was made by a newer Seamless (schema ${parsed.manifest.schemaVersion}, this server knows ${localAfter}); upgrade first`, 'schema');
  }
  const exportKey = keyFromSecret(password);
  const localKey = opts.secret ? keyFromSecret(opts.secret) : LOCAL_KEY;

  if (opts.mode === 'settings') {
    if (!opts.userId) throw new ExportError('settings import needs a user');
    const r = await mergeSettings(dbq, parsed.lines, opts.userId, reencryptor(exportKey, localKey));
    return { mode: 'settings', manifest: parsed.manifest, ...r };
  }

  const empty = !(await dbq('SELECT 1 FROM users LIMIT 1'))[0];
  if (!empty) throw new ExportError('a full import only works on an empty database (no users yet)', 'not-empty');

  const { applied, skippedColumns } = await replayDump(db, parsed.lines, { transform: reencryptor(exportKey, localKey) });
  void skippedColumns;
  const report: ImportReport = {
    mode: 'full', manifest: parsed.manifest, tables: applied, rows: Object.values(applied).reduce((a, b) => a + b, 0),
  };

  if (opts.db === undefined) {
    // blobs go into THIS server's configured mail store; otherwise follow the restored config
    if (parsed.blobs.size) {
      const put = opts.putMailBlob ?? ((k: string, b: Buffer) => putBlob(k, b, 'message/rfc822'));
      await pool_([...parsed.blobs], async ([k, b]) => { await put(k, b); });
      report.blobsWritten = parsed.blobs.size;
      await saveMailStoreConfig();
      report.mailStore = { adopted: false, bucket: '', endpoint: '' };
    } else {
      report.mailStore = await adoptRestoredMailStore();
    }
    report.blobCheck = await verifyMailBlobs();
  } else if (parsed.blobs.size && opts.putMailBlob) {
    await pool_([...parsed.blobs], async ([k, b]) => { await opts.putMailBlob!(k, b); });
    report.blobsWritten = parsed.blobs.size;
  }
  return report;
}

// ---- settings-only merge ----

type Rec = Record<string, any>;

function tableRows(lines: string[]): Record<string, Rec[]> {
  const out: Record<string, Rec[]> = {};
  let table = '', cols: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('{"__table"')) {
      const h = JSON.parse(line) as { __table: string; cols: string[] };
      table = h.__table; cols = h.cols; out[table] = []; continue;
    }
    const arr = JSON.parse(line) as unknown[];
    out[table].push(Object.fromEntries(cols.map((c, i) => [c, arr[i]])));
  }
  return out;
}

/** Merges the exporting user's settings/rules/filters/labels/templates/transports/categories into
 *  `userId`, skipping anything with the same name. The source user is the one with the same email,
 *  else the first admin, else the first user in the file. */
async function mergeSettings(query: QueryFn, lines: string[], userId: number, enc: RowTransform): Promise<{ added: Record<string, number>; skipped: Record<string, number> }> {
  const t = tableRows(lines);
  const users = t.users ?? [];
  const me = (await query('SELECT email FROM users WHERE id = ?', [userId]))[0] as { email: string } | undefined;
  const src = users.find((u) => u.email === me?.email) ?? users.find((u) => u.role === 'admin') ?? users[0];
  if (!src) throw new ExportError('the export holds no users');
  const mine = (table: string) => (t[table] ?? []).filter((r) => r.user_id === src.id);
  const added: Record<string, number> = {}, skipped: Record<string, number> = {};
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const now = Date.now();

  // labels first: rules point at them
  const labelMap = new Map<number, number>();
  for (const l of mine('labels')) {
    const ex = (await query('SELECT id FROM labels WHERE user_id = ? AND name = ?', [userId, l.name]))[0];
    if (ex) { labelMap.set(l.id, ex.id); bump(skipped, 'labels'); continue; }
    const row = (await query('INSERT INTO labels(user_id, name, color, description, sort) VALUES (?,?,?,?,?) RETURNING id',
      [userId, l.name, l.color, l.description, l.sort]))[0];
    labelMap.set(l.id, row.id); bump(added, 'labels');
  }

  for (const r of mine('rules')) {
    const labelId = r.label_id == null ? null : labelMap.get(r.label_id) ?? null;
    if (r.action === 'label' && labelId == null) { bump(skipped, 'rules'); continue; }
    const ex = await query(
      'SELECT 1 FROM rules WHERE user_id = ? AND match_field = ? AND match_value = ? AND action = ? AND label_id IS NOT DISTINCT FROM ?',
      [userId, r.match_field, r.match_value, r.action, labelId]);
    if (ex.length) { bump(skipped, 'rules'); continue; }
    await query(`INSERT INTO rules(user_id, enabled, ord, match_field, match_value, exclude_contains, action, label_id, stop, note, source, hit_count, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [userId, r.enabled, r.ord, r.match_field, r.match_value, r.exclude_contains ?? '', r.action, labelId, r.stop, r.note ?? '', 'imported', 0, now]);
    bump(added, 'rules');
  }

  for (const f of mine('filters')) {
    if ((await query('SELECT 1 FROM filters WHERE user_id = ? AND name = ?', [userId, f.name])).length) { bump(skipped, 'filters'); continue; }
    await query('INSERT INTO filters(user_id, name, enabled, sort, match, conditions, actions, stop) VALUES (?,?,?,?,?,?,?,?)',
      [userId, f.name, f.enabled, f.sort, f.match, f.conditions, f.actions, f.stop]);
    bump(added, 'filters');
  }

  for (const tp of mine('templates')) {
    if ((await query('SELECT 1 FROM templates WHERE user_id = ? AND name = ?', [userId, tp.name])).length) { bump(skipped, 'templates'); continue; }
    let shortcut: string | null = tp.shortcut || null;
    if (shortcut && (await query('SELECT 1 FROM templates WHERE user_id = ? AND shortcut = ?', [userId, shortcut])).length) shortcut = null;
    await query(`INSERT INTO templates(user_id, name, category, subject, body_html, account_id, shortcut, use_count, created_at, updated_at)
                 VALUES (?,?,?,?,?,NULL,?,0,?,?)`,
      [userId, tp.name, tp.category ?? '', tp.subject ?? '', tp.body_html, shortcut, now, now]);
    bump(added, 'templates');
  }

  const transportCols = ['id', 'user_id', 'kind', 'name', 'config_enc', 'fallback_id', 'daily_limit', 'created_at'];
  for (const tr of mine('transports')) {
    if ((await query('SELECT 1 FROM transports WHERE user_id = ? AND name = ?', [userId, tr.name])).length) { bump(skipped, 'transports'); continue; }
    const row = enc('transports', transportCols, transportCols.map((c) => tr[c]));
    await query('INSERT INTO transports(user_id, kind, name, config_enc, fallback_id, daily_limit, created_at) VALUES (?,?,?,?,NULL,?,?)',
      [userId, tr.kind, tr.name, row[4], tr.daily_limit ?? null, now]);
    bump(added, 'transports');
  }

  for (const c of mine('mailbox_categories')) {
    if ((await query('SELECT 1 FROM mailbox_categories WHERE user_id = ? AND (key = ? OR name = ?)', [userId, c.key, c.name])).length) { bump(skipped, 'categories'); continue; }
    await query('INSERT INTO mailbox_categories(user_id, key, name, icon, color, sort_order, builtin, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [userId, c.key, c.name, c.icon, c.color, c.sort_order, c.builtin, now]);
    bump(added, 'categories');
  }

  for (const s of mine('user_settings')) {
    const r = await query('INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING key', [userId, s.key, s.value]);
    bump(r.length ? added : skipped, 'settings');
  }
  return { added, skipped };
}
