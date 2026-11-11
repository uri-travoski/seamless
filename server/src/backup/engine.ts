import { gzipSync, gunzipSync } from 'node:zlib';
import { pool, q, one, migrate } from '../db.ts';
import { config } from '../config.ts';
import { encryptBuffer, decryptBuffer, sha256 } from '../crypto.ts';
import { backupStore, backupStoreConfig, mailStoreLocation, type BlobStore, type S3Config } from '../s3.ts';
import { saveMailStoreConfig, adoptRestoredMailStore, verifyMailBlobs, type BlobCheck } from './mailref.ts';
import { mirrorBlobs, writeKeysFile, adoptMirrorMailStore, mailStoreIsMirror, type BlobsManifest } from './mirror.ts';

/** Logical backup of the whole Postgres database.
 *
 *  Why not pg_dump: the app image is node:20-slim and reaches Postgres over TCP,
 *  so it has no pg_dump binary and no way to exec one in the database container.
 *  Instead every table is read through the pool the app already owns, streamed as
 *  NDJSON, gzipped, then AES-256-GCM encrypted with SEAMLESS_SECRET (DESIGN.md §0
 *  credential-at-rest pattern) before it is written to the BACKUP store.
 *
 *  Layout, one directory per run:
 *    <prefix><iso>/manifest.json      plaintext, so backups list + verify without the secret
 *    <prefix><iso>/data.ndjson.gz.enc ciphertext
 *
 *  The .eml blobs are NOT copied. They live in the MAIL store, which may be a different
 *  bucket (or provider) entirely — the backup only carries the database, and the restored
 *  rows reach the blobs through the mail store's own config by key. This backup is the
 *  index, not the archive. */

/** v2 adds `schemaVersion`, `blobs` (the mail mirror) and the optional blobs.keys.gz. v1 manifests still restore. */
export const FORMAT_VERSION = 2;
const SECRET_CHECK = 'seamless-backup-v1';
/** Never a bare "backup/": an omitted prefix must still land inside the app folder,
 *  or a caller that forgets to pass one silently writes to the bucket root. */
const DEFAULT_PREFIX = config.backupPrefix;
const INSERT_CHUNK = 500;

export interface BackupManifest {
  v: number;
  schemaVersion?: number;     // v2+: same as v
  createdAt: number;
  appVersion: string;
  tables: Record<string, number>;
  rows: number;
  bytes: number;              // ciphertext size
  sha256: string;             // of the ciphertext, so a truncated upload is caught
  enc: 'aes-256-gcm';
  secretCheck: string;        // SECRET_CHECK encrypted; wrong key is reported as such
  key: string;                // this backup's directory
  /** Where this backup's mail blobs live — location only, never credentials: the manifest
   *  is plaintext so backups can be listed without the secret. The credentials ride inside
   *  the encrypted payload (settings.mail_s3). Lets you see which bucket a backup expects
   *  BEFORE restoring it. */
  /** v2: present when the run mirrored mail blobs to <prefix>blobs/. */
  blobs?: BlobsManifest;
  mailStore?: { endpoint: string; region: string; bucket: string; forcePathStyle: boolean };
}

export interface BackupSummary {
  key: string;
  createdAt: number;
  rows: number;
  bytes: number;
  tables: number;
}

interface Column { name: string; generated: boolean }

async function tableNames(): Promise<string[]> {
  const rows = await q<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return rows.map((r) => r.table_name);
}

/** Generated columns (message_fts.tsv) must be skipped: Postgres rejects an explicit
 *  value for them, and they rebuild themselves from the restored source columns. */
async function columnsOf(table: string): Promise<Column[]> {
  const rows = await q<{ column_name: string; is_generated: string }>(`
    SELECT column_name, is_generated FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ?
    ORDER BY ordinal_position
  `, [table]);
  return rows.map((r) => ({ name: r.column_name, generated: r.is_generated === 'ALWAYS' }));
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function createBackup(opts: { prefix?: string; store?: BlobStore; appVersion?: string; includeEmails?: boolean; mailSource?: (key: string) => Promise<Buffer> } = {}): Promise<BackupManifest> {
  const store = opts.store ?? backupStore;
  const prefix = opts.prefix ?? DEFAULT_PREFIX;

  // record where the mail lives BEFORE the dump is taken, so the config travels inside the
  // encrypted payload and a restore can find the blobs without being told where they are
  await saveMailStoreConfig();

  // mirror BEFORE the dump so backup_blob_index inside the dump matches what is in the store
  let blobs: BlobsManifest | undefined;
  let mirrorKeys: string[] = [];
  if (opts.includeEmails && !mailStoreIsMirror()) {
    const res = await mirrorBlobs({ store, prefix, source: opts.mailSource });
    blobs = res.manifest;
    mirrorKeys = res.keys;
  }

  const tables = await tableNames();

  const lines: string[] = [];
  const counts: Record<string, number> = {};
  let rows = 0;

  for (const table of tables) {
    const cols = (await columnsOf(table)).filter((c) => !c.generated);
    if (!cols.length) continue;
    const names = cols.map((c) => c.name);
    // header line names the columns, so a restore stays correct even if a later
    // migration reorders or adds columns to the live schema
    lines.push(JSON.stringify({ __table: table, cols: names }));

    const data = await q<Record<string, unknown>>(
      `SELECT ${names.map(ident).join(', ')} FROM ${ident(table)}`);
    for (const row of data) lines.push(JSON.stringify(names.map((n) => row[n] ?? null)));
    counts[table] = data.length;
    rows += data.length;
  }

  const plain = Buffer.from(lines.join('\n'), 'utf8');
  const cipher = encryptBuffer(gzipSync(plain, { level: 6 }));

  const createdAt = Date.now();
  const dir = `${prefix}${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}/`;
  const manifest: BackupManifest = {
    v: FORMAT_VERSION,
    schemaVersion: FORMAT_VERSION,
    createdAt,
    appVersion: opts.appVersion ?? 'unknown',
    tables: counts,
    rows,
    bytes: cipher.length,
    sha256: sha256(cipher),
    enc: 'aes-256-gcm',
    secretCheck: encryptBuffer(Buffer.from(SECRET_CHECK)).toString('base64'),
    key: dir,
    mailStore: mailStoreLocation(),
    ...(blobs ? { blobs } : {}),
  };

  // data first: a manifest only ever exists once its payload is durably uploaded,
  // so a crash mid-run leaves an orphan blob rather than a manifest pointing at nothing
  if (blobs) await writeKeysFile(store, dir, mirrorKeys);
  await store.put(`${dir}data.ndjson.gz.enc`, cipher, 'application/octet-stream');
  await store.put(`${dir}manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');
  return manifest;
}

export async function listBackups(opts: { prefix?: string; store?: BlobStore } = {}): Promise<BackupSummary[]> {
  const store = opts.store ?? backupStore;
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const keys = (await store.list(prefix)).filter((k) => k.endsWith('/manifest.json'));

  const out: BackupSummary[] = [];
  for (const key of keys) {
    try {
      const m = JSON.parse((await store.get(key)).toString('utf8')) as BackupManifest;
      out.push({ key: m.key, createdAt: m.createdAt, rows: m.rows, bytes: m.bytes, tables: Object.keys(m.tables).length });
    } catch {
      // a half-written or foreign object in the prefix must not hide the good backups
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

async function loadManifest(store: BlobStore, dir: string): Promise<BackupManifest> {
  const m = JSON.parse((await store.get(`${dir}manifest.json`)).toString('utf8')) as BackupManifest;
  if (!(m.v >= 1 && m.v <= FORMAT_VERSION)) throw new Error(`unsupported backup format v${m.v} (this server reads v${FORMAT_VERSION})`);
  return m;
}

/** Reads the backup end to end without touching the database: checksum, then the
 *  secret, then a full decrypt+gunzip+parse. This is what "Verify" in Settings runs,
 *  and what the scheduler runs after every write — an unverified backup is a rumour. */
export async function verifyBackup(dir: string, opts: { store?: BlobStore } = {}): Promise<{ ok: true; manifest: BackupManifest; rows: number }> {
  const store = opts.store ?? backupStore;
  const manifest = await loadManifest(store, dir);

  const cipher = await store.get(`${dir}data.ndjson.gz.enc`);
  if (sha256(cipher) !== manifest.sha256) throw new Error('checksum mismatch: backup payload is corrupt or truncated');

  try {
    if (decryptBuffer(Buffer.from(manifest.secretCheck, 'base64')).toString('utf8') !== SECRET_CHECK) throw new Error('bad');
  } catch {
    throw new Error('SEAMLESS_SECRET does not match the one this backup was written with');
  }

  const lines = gunzipSync(decryptBuffer(cipher)).toString('utf8');
  const rows = lines ? lines.split('\n').filter((l) => l && !l.startsWith('{"__table"')).length : 0;
  if (rows !== manifest.rows) throw new Error(`row count mismatch: manifest says ${manifest.rows}, payload holds ${rows}`);
  return { ok: true, manifest, rows };
}

export interface RestoreReport {
  key: string;
  createdAt: number;
  tables: Record<string, number>;
  rows: number;
  skippedColumns: string[];
  /** Mail is not in the backup — only the pointer to it. These say whether the restored
   *  server actually reached the blobs, so "restored" never means "rows are back but every
   *  message body 404s". */
  mailStore: { bucket: string; endpoint: string; adopted: boolean; fromMirror?: boolean };
  /** Set when the primary mail bucket could not serve the check but this backup carries a mirror. */
  mirrorAvailable?: boolean;
  blobs: BlobCheck;
}

/** Destructive: truncates every table, then replays the dump.
 *
 *  FK order is sidestepped with session_replication_role=replica (the same switch
 *  pg_restore uses) rather than a topological sort, so the dump can be replayed in
 *  any order and a future table with a new FK needs no code change here. Runs in one
 *  transaction: a failure part-way leaves the existing database untouched. */
export async function restoreBackup(dir: string, opts: { store?: BlobStore; mailFromMirror?: boolean; storeConfig?: S3Config } = {}): Promise<RestoreReport> {
  const store = opts.store ?? backupStore;
  const { manifest } = await verifyBackup(dir, { store });

  await migrate(); // a bare disaster-recovery database has no schema yet

  const cipher = await store.get(`${dir}data.ndjson.gz.enc`);
  const text = gunzipSync(decryptBuffer(cipher)).toString('utf8');
  const lines = text ? text.split('\n') : [];

  const live = new Set(await tableNames());
  const skippedColumns: string[] = [];
  const applied: Record<string, number> = {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');

    const truncatable = [...live].map(ident).join(', ');
    if (truncatable) await client.query(`TRUNCATE ${truncatable} RESTART IDENTITY CASCADE`);

    let table = '';
    let cols: string[] = [];
    let keep: number[] = [];   // indexes of dump columns that still exist in the live schema
    let batch: unknown[][] = [];

    const flush = async () => {
      if (!batch.length || !table) return;
      const names = keep.map((i) => ident(cols[i])).join(', ');
      const values: unknown[] = [];
      const tuples = batch.map((row, r) => {
        const ps = keep.map((_, c) => `$${r * keep.length + c + 1}`);
        // node-pg turns a JS array into a Postgres array literal, which a jsonb column rejects:
        // jsonb values that happen to be arrays (message_risk.reasons) must go in as JSON text
        for (const i of keep) values.push(Array.isArray(row[i]) ? JSON.stringify(row[i]) : row[i]);
        return `(${ps.join(', ')})`;
      });
      await client.query(`INSERT INTO ${ident(table)} (${names}) VALUES ${tuples.join(', ')}`, values);
      applied[table] = (applied[table] ?? 0) + batch.length;
      batch = [];
    };

    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('{"__table"')) {
        await flush();
        const head = JSON.parse(line) as { __table: string; cols: string[] };
        table = live.has(head.__table) ? head.__table : '';
        cols = head.cols;
        keep = [];
        if (table) {
          const liveCols = new Set((await columnsOf(table)).filter((c) => !c.generated).map((c) => c.name));
          cols.forEach((c, i) => {
            if (liveCols.has(c)) keep.push(i);
            else skippedColumns.push(`${head.__table}.${c}`);
          });
        } else {
          skippedColumns.push(`${head.__table} (table no longer exists)`);
        }
        applied[head.__table] = applied[head.__table] ?? 0;
        continue;
      }
      if (!table || !keep.length) continue;
      batch.push(JSON.parse(line) as unknown[]);
      if (batch.length >= INSERT_CHUNK) await flush();
    }
    await flush();

    // TRUNCATE ... RESTART IDENTITY rewound every sequence to 1, and the rows went back
    // in with explicit ids — without this the next insert collides on the PK. Only tables
    // that actually own an id sequence: link tables (message_labels, email_vectors) have
    // no id column at all, and naming one in the query is a parse error even when guarded.
    const withId = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id'
    `);
    for (const { table_name: t } of withId.rows) {
      if (!live.has(t)) continue;
      const seq = (await client.query<{ seq: string | null }>(
        "SELECT pg_get_serial_sequence($1, 'id') AS seq", [t])).rows[0]?.seq;
      if (!seq) continue;   // schema_migrations and friends: id is supplied, not generated
      await client.query(
        `SELECT setval($1, COALESCE((SELECT MAX(id) FROM ${ident(t)}), 1), (SELECT COUNT(*) FROM ${ident(t)}) > 0)`,
        [seq]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const rows = Object.values(applied).reduce((a, b) => a + b, 0);

  // the restored settings say where the mail lives: point the store there, then prove it —
  // fetch one blob and match it against the sha256 embedded in its key
  let mailStore: RestoreReport['mailStore'] = await adoptRestoredMailStore();
  if (opts.mailFromMirror) {
    if (!manifest.blobs) throw new Error('this backup has no mail mirror (it was taken without "include emails")');
    const prefix = dir.replace(/[^/]+\/$/, '');
    const m = await adoptMirrorMailStore(opts.storeConfig ?? backupStoreConfig(), prefix);
    mailStore = { adopted: true, bucket: m.bucket, endpoint: m.endpoint, fromMirror: true };
  }
  const blobs = await verifyMailBlobs();

  return {
    key: dir, createdAt: manifest.createdAt, tables: applied, rows, skippedColumns, mailStore, blobs,
    ...(!opts.mailFromMirror && manifest.blobs && blobs.checked && !blobs.ok ? { mirrorAvailable: true } : {}),
  };
}

/** Keep the newest `keep` runs; delete the rest. Returns the directories removed. */
export async function pruneBackups(keep: number, opts: { prefix?: string; store?: BlobStore } = {}): Promise<string[]> {
  const store = opts.store ?? backupStore;
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  if (keep < 1) return [];

  const backups = await listBackups({ prefix, store });
  const doomed = backups.slice(keep);
  for (const b of doomed) {
    for (const key of await store.list(b.key)) await store.del(key);
  }
  return doomed.map((b) => b.key);
}

/** True when the database holds no users — i.e. a fresh box that may be restored
 *  into without authentication, because there is nobody who could authenticate. */
export async function databaseIsEmpty(): Promise<boolean> {
  const row = await one('SELECT 1 FROM users LIMIT 1');
  return !row;
}
