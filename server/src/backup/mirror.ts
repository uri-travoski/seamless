import { gzipSync, gunzipSync } from 'node:zlib';
import { q, run } from '../db.ts';
import { sha256 } from '../crypto.ts';
import { getBlob, mailStoreConfig, setMailStore, withKeyPrefix, type BlobStore, type S3Config } from '../s3.ts';
import { saveMailStoreConfig } from './mailref.ts';

/**
 * Email backups: a mirror of the mail blobs (.eml) inside the backup store.
 *
 * Layout:  <prefix>blobs/<same key as the mail store>   (e.g. seamless/blobs/msg/3/<sha>.eml)
 *          <prefix><iso>/blobs.keys.gz                 per-backup list of the keys that backup's DB rows reference
 *
 * `backup_blob_index` remembers what is already mirrored, so the second run copies only new keys
 * without listing the whole bucket. The keys file per backup is what retention uses to decide
 * which mirror objects are still wanted (mark-and-sweep), without re-reading any dump.
 */

export interface BlobsManifest {
  mirrored: number;        // objects copied this run
  total: number;           // distinct mail blobs referenced by messages
  lastKey: string;
  verifiedSample: number;  // objects re-read from the mirror and checked by sha256
  missing: number;         // referenced by the DB but absent from the mail store (not copied)
}

export const SAMPLE_SIZE = 20;
const CONCURRENCY = 8;

export const mirrorPrefix = (backupPrefix: string) => `${backupPrefix}blobs/`;
export const keysFileOf = (dir: string) => `${dir}blobs.keys.gz`;

export async function referencedKeys(): Promise<string[]> {
  const rows = await q<{ s3_key: string }>(
    "SELECT DISTINCT s3_key FROM messages WHERE s3_key IS NOT NULL AND s3_key <> '' ORDER BY s3_key");
  return rows.map((r) => r.s3_key);
}

async function pool_<T>(items: T[], fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) { const x = items[i++]; await fn(x); }
  }));
}

/** Copy new mail blobs into <prefix>blobs/ and verify a random sample by sha256. */
export async function mirrorBlobs(opts: {
  store: BlobStore; prefix: string; source?: (key: string) => Promise<Buffer>; sample?: number;
}): Promise<{ manifest: BlobsManifest; keys: string[] }> {
  const dest = mirrorPrefix(opts.prefix);
  const read = opts.source ?? getBlob;
  const keys = await referencedKeys();

  const done = new Set((await q<{ key: string }>('SELECT key FROM backup_blob_index WHERE prefix = ?', [dest])).map((r) => r.key));
  const todo = keys.filter((k) => !done.has(k));
  let mirrored = 0, missing = 0, lastKey = '';
  const present: string[] = keys.filter((k) => done.has(k));

  await pool_(todo, async (key) => {
    let body: Buffer;
    try { body = await read(key); } catch { missing++; return; }
    await opts.store.put(dest + key, body, 'message/rfc822');
    await run(`INSERT INTO backup_blob_index(key, size, mirrored_at, prefix) VALUES (?,?,?,?)
               ON CONFLICT (key) DO UPDATE SET size = EXCLUDED.size, mirrored_at = EXCLUDED.mirrored_at, prefix = EXCLUDED.prefix`,
      [key, body.length, Date.now(), dest]);
    mirrored++;
    present.push(key);
    if (key > lastKey) lastKey = key;
  });

  // verify a sample of the mirror (new and old alike): content must hash to the key's sha256,
  // or — when the key carries no hash — to what the mail store holds
  const pickFrom = [...present].sort(() => Math.random() - 0.5).slice(0, opts.sample ?? SAMPLE_SIZE);
  let verifiedSample = 0;
  for (const key of pickFrom) {
    const copy = await opts.store.get(dest + key).catch(() => null);
    if (!copy) throw new Error(`mirror verification failed: ${key} is not readable from the backup store`);
    const want = key.match(/([a-f0-9]{64})\.eml$/)?.[1] ?? sha256(await read(key));
    if (sha256(copy) !== want) throw new Error(`mirror verification failed: ${key} does not match its checksum`);
    verifiedSample++;
  }

  return {
    keys: present.sort(),
    manifest: { mirrored, total: keys.length, lastKey, verifiedSample, missing },
  };
}

export async function writeKeysFile(store: BlobStore, dir: string, keys: string[]): Promise<void> {
  await store.put(keysFileOf(dir), gzipSync(Buffer.from(keys.join('\n'))), 'application/gzip');
}

async function readKeysFile(store: BlobStore, dir: string): Promise<string[] | null> {
  try { const t = gunzipSync(await store.get(keysFileOf(dir))).toString('utf8'); return t ? t.split('\n') : []; }
  catch { return null; }
}

/** Mark-and-sweep: delete mirror objects that no kept backup references. Only runs when every
 *  kept backup that has a keys file can be read; returns the number of objects deleted. */
export async function sweepMirror(opts: { store: BlobStore; prefix: string; keptDirs: string[] }): Promise<number> {
  const dest = mirrorPrefix(opts.prefix);
  const wanted = new Set<string>();
  for (const dir of opts.keptDirs) {
    const keys = await readKeysFile(opts.store, dir);
    if (keys) for (const k of keys) wanted.add(k);
  }
  const all = await opts.store.list(dest);
  let deleted = 0;
  for (const full of all) {
    const key = full.slice(dest.length);
    if (wanted.has(key)) continue;
    await opts.store.del(full);
    await run('DELETE FROM backup_blob_index WHERE key = ? AND prefix = ?', [key, dest]);
    deleted++;
  }
  return deleted;
}

/** Point the mail store at the mirror (a store with prefix <backup prefix>blobs/). */
export async function adoptMirrorMailStore(backupCfg: S3Config, backupPrefix: string): Promise<{ bucket: string; endpoint: string; keyPrefix: string }> {
  const cfg: S3Config = { ...backupCfg, keyPrefix: mirrorPrefix(backupPrefix) };
  setMailStore(cfg);
  await saveMailStoreConfig(cfg);
  return { bucket: cfg.bucket, endpoint: cfg.endpoint, keyPrefix: cfg.keyPrefix! };
}

/** True when the mail store already reads from the mirror (so mirroring it onto itself is pointless). */
export const mailStoreIsMirror = () => !!mailStoreConfig().keyPrefix;

export { withKeyPrefix };
