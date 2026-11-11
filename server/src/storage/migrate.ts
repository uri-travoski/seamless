/**
 * Verified storage migration (F-27): move the mail (or backup) objects to another bucket without losing or
 * silently corrupting anything. The state lives in `storage_migrations` / `storage_migration_items`, so a
 * restart carries on where it stopped. One job run = one batch of 200; the job re-enqueues itself until done.
 *
 *   planning → copying → verifying → switching → completed        (any verify failure → failed_verify, no switch)
 *
 * Nothing here ever deletes the source. `cleanupSource` does, but only on an explicit, typed request
 * after the retention window.
 */
import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { q, one, run } from '../db.ts';
import { encrypt, decrypt } from '../crypto.ts';
import { config } from '../config.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { emitToAdmins } from '../events/emit.ts';
import {
  makeStore, mailStoreConfig, backupStoreConfig, setMailStore, setBackupStore, type BlobStore, type S3Config,
} from '../s3.ts';
import { saveMailStoreConfig } from '../backup/mailref.ts';
import { activeTarget, getTarget, toS3Config, sameBucket } from './targets.ts';
import { setWritesPaused } from './pause.ts';

export type MigrationRole = 'mail' | 'backup';
export const BATCH = 200;
const CONCURRENCY = 8;
export const RETAIN_MS = 14 * 24 * 3600_000;
const ACTIVE = ['planning', 'copying', 'verifying', 'switching'];

export interface MigrationRow {
  id: number; role: MigrationRole; kind: 'forward' | 'rollback'; mode: 'sample' | 'strict'; status: string;
  from_target_id: number | null; to_target_id: number | null; source_enc: string; dest_enc: string;
  source_bucket: string; dest_bucket: string; source_prefix: string; related_id: number | null;
  total_items: number; total_bytes: string | number; copied_items: number; copied_bytes: string | number; verified_items: number;
  retain_until: string | number | null; error: string | null; started_by: number | null;
  created_at: string | number; updated_at: string | number; started_at: string | number | null;
  finished_at: string | number | null; switched_at: string | number | null; cleaned_at: string | number | null;
}

/** Injectable for tests (and the two stores are otherwise built from the encrypted configs on the row). */
export interface Deps { src?: BlobStore; dst?: BlobStore; batch?: number }

const cfgOf = (enc: string) => JSON.parse(decrypt(enc)) as S3Config;
const stores = (m: MigrationRow, d: Deps) => ({
  src: d.src ?? makeStore(cfgOf(m.source_enc)),
  dst: d.dst ?? makeStore(cfgOf(m.dest_enc)),
});
const getMigration = (id: number) => one<MigrationRow>('SELECT * FROM storage_migrations WHERE id = ?', [id]);
const touch = (id: number, set: string, params: unknown[] = []) =>
  run(`UPDATE storage_migrations SET ${set}, updated_at = ? WHERE id = ?`, [...params, Date.now(), id]);

export function view(m: MigrationRow) {
  const now = Date.now();
  const startedAt = m.started_at ? Number(m.started_at) : null;
  const bytes = Number(m.copied_bytes), total = Number(m.total_bytes);
  const elapsed = startedAt ? Math.max(1, (m.finished_at ? Number(m.finished_at) : now) - startedAt) : 0;
  const bps = elapsed ? Math.round((bytes / elapsed) * 1000) : 0;
  const etaMs = bps && !m.finished_at && total > bytes ? Math.round(((total - bytes) / bps) * 1000) : null;
  return {
    id: m.id, role: m.role, kind: m.kind, mode: m.mode, status: m.status,
    sourceBucket: m.source_bucket, destBucket: m.dest_bucket, relatedId: m.related_id,
    totalItems: m.total_items, totalBytes: total, copiedItems: m.copied_items, copiedBytes: bytes, verifiedItems: m.verified_items,
    bytesPerSecond: bps, etaMs, error: m.error,
    retainUntil: m.retain_until ? Number(m.retain_until) : null,
    createdAt: Number(m.created_at), finishedAt: m.finished_at ? Number(m.finished_at) : null,
    switchedAt: m.switched_at ? Number(m.switched_at) : null, cleanedAt: m.cleaned_at ? Number(m.cleaned_at) : null,
    canRollback: m.kind === 'forward' && m.status === 'completed' && !m.cleaned_at && !!m.retain_until && Number(m.retain_until) > now,
    canCleanup: m.kind === 'forward' && m.status === 'completed' && !m.cleaned_at && !!m.retain_until && Number(m.retain_until) <= now,
  };
}

// ---------------------------------------------------------------- start / plan summary

/** What a migration of this role would move (for the wizard, before anything starts). */
export async function planSummary(role: MigrationRole): Promise<{ objects: number; bytes: number; etaMs: number }> {
  let objects = 0, bytes = 0;
  if (role === 'mail') {
    const r = await one<{ c: string; b: string }>('SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS b FROM messages WHERE s3_key IS NOT NULL');
    objects = Number(r?.c ?? 0); bytes = Number(r?.b ?? 0);
  } else {
    const keys = await makeStore(backupStoreConfig()).list(await backupPrefix());
    objects = keys.length;
  }
  // rough: ~8 objects/s per connection pool of 8 plus 5 MB/s sustained
  return { objects, bytes, etaMs: Math.round(objects / 40 * 1000 + bytes / 5_000_000 * 1000) };
}

async function backupPrefix(): Promise<string> {
  const t = await activeTarget('backup');
  return t ? t.prefix : config.backupPrefix;
}

export async function activeMigration(role: MigrationRole): Promise<MigrationRow | undefined> {
  return one<MigrationRow>(`SELECT * FROM storage_migrations WHERE role = ? AND status = ANY(?) ORDER BY id DESC LIMIT 1`, [role, ACTIVE]);
}

export async function startMigration(opts: { role: MigrationRole; toTargetId: number; mode?: 'sample' | 'strict'; userId?: number }): Promise<{ id: number } | { error: string }> {
  const { role } = opts;
  const dest = await getTarget(opts.toTargetId);
  if (!dest || dest.role !== role) return { error: `pick a saved ${role} storage target` };
  if (dest.active) return { error: 'That storage is already in use.' };
  const srcCfg = role === 'mail' ? mailStoreConfig() : backupStoreConfig();
  const destCfg = toS3Config(dest);
  if (sameBucket(srcCfg, destCfg)) return { error: 'That is the bucket you already use.' };
  if (await activeMigration(role)) return { error: 'A migration for this storage is already running.' };
  const from = await activeTarget(role);
  const now = Date.now();
  const rows = await q<{ id: number }>(
    `INSERT INTO storage_migrations (role, mode, status, from_target_id, to_target_id, source_enc, dest_enc, source_bucket, dest_bucket,
       source_prefix, started_by, created_at, updated_at, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    [role, opts.mode === 'strict' ? 'strict' : 'sample', 'planning', from?.id ?? null, dest.id, encrypt(JSON.stringify(srcCfg)),
      encrypt(JSON.stringify(destCfg)), srcCfg.bucket, destCfg.bucket, role === 'backup' ? await backupPrefix() : '',
      opts.userId ?? null, now, now, now]);
  await enqueueJob(null, 'storage.migrate', now, { id: rows[0].id });
  return { id: rows[0].id };
}

/** Rollback while the source is retained: copy what was written since the switch back, then switch back. */
export async function startRollback(id: number, userId?: number): Promise<{ id: number } | { error: string }> {
  const o = await getMigration(id);
  if (!o || o.kind !== 'forward') return { error: 'not found' };
  if (o.status !== 'completed' || o.cleaned_at) return { error: 'Only a finished migration whose old storage is still kept can be rolled back.' };
  if (!o.retain_until || Number(o.retain_until) <= Date.now()) return { error: 'The retention period is over; the old storage may be cleaned up.' };
  if (await activeMigration(o.role)) return { error: 'A migration for this storage is already running.' };
  const latest = await one<{ id: number }>(`SELECT id FROM storage_migrations WHERE role = ? AND kind = 'forward' AND status = 'completed' ORDER BY id DESC LIMIT 1`, [o.role]);
  if (latest?.id !== o.id) return { error: 'Only the most recent migration can be rolled back.' };
  const now = Date.now();
  const rows = await q<{ id: number }>(
    `INSERT INTO storage_migrations (role, kind, mode, status, from_target_id, to_target_id, source_enc, dest_enc, source_bucket, dest_bucket,
       source_prefix, related_id, started_by, created_at, updated_at, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    [o.role, 'rollback', 'sample', 'planning', o.to_target_id, o.from_target_id, o.dest_enc, o.source_enc, o.dest_bucket, o.source_bucket,
      o.source_prefix, o.id, userId ?? null, now, now, now]);
  await enqueueJob(null, 'storage.migrate', now, { id: rows[0].id });
  return { id: rows[0].id };
}

export async function cancelMigration(id: number): Promise<boolean> {
  const n = await run(`UPDATE storage_migrations SET status = 'cancelled', finished_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('planning','copying','verifying','failed','failed_verify')`, [Date.now(), Date.now(), id]);
  return n > 0;
}

/** After a failure: put failed objects back in the queue (re-copying overwrites a corrupt copy) and carry on. */
export async function retryMigration(id: number): Promise<boolean> {
  const m = await getMigration(id);
  if (!m || !['failed', 'failed_verify'].includes(m.status)) return false;
  await run(`UPDATE storage_migration_items SET status = 'pending', error = NULL WHERE migration_id = ? AND status = 'failed'`, [id]);
  await touch(id, `status = 'copying', error = NULL, finished_at = NULL`);
  await enqueueJob(null, 'storage.migrate', Date.now(), { id });
  return true;
}

// ---------------------------------------------------------------- planning

/** Every object the app still needs, as key → size. For a rollback only keys the original run did not cover. */
async function wantedKeys(m: MigrationRow, src: BlobStore): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (m.role === 'backup') {
    for (const k of await src.list(m.source_prefix)) out.set(k, 0);
  } else {
    for (const r of await q<{ s3_key: string; size: string }>('SELECT s3_key, COALESCE(size,0) AS size FROM messages WHERE s3_key IS NOT NULL'))
      out.set(r.s3_key, Number(r.size));
    for (const r of await q<{ s3_key: string }>('SELECT s3_key FROM scheduled_sends WHERE s3_key IS NOT NULL')) if (!out.has(r.s3_key)) out.set(r.s3_key, 0);
    for (const k of await src.list('outbound/')) if (!out.has(k)) out.set(k, 0);
  }
  if (m.kind === 'rollback' && m.related_id) {
    for (const r of await q<{ key: string }>('SELECT key FROM storage_migration_items WHERE migration_id = ?', [m.related_id])) out.delete(r.key);
  }
  return out;
}

/** Add keys we do not have yet as `pending`. Returns how many were new. */
async function addPlanned(m: MigrationRow, wanted: Map<string, number>, toVerify: boolean): Promise<number> {
  const keys = [...wanted.keys()];
  let added = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const part = keys.slice(i, i + 1000);
    added += await run(
      `INSERT INTO storage_migration_items (migration_id, key, size, to_verify)
       SELECT ?, k, s, ? FROM unnest(?::text[], ?::bigint[]) AS t(k, s) ON CONFLICT DO NOTHING`,
      [m.id, toVerify, part, part.map((k) => wanted.get(k)!)]);
  }
  return added;
}

async function refreshTotals(id: number): Promise<void> {
  const r = await one<{ n: string; b: string; cn: string; cb: string; vn: string }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS b,
            COUNT(*) FILTER (WHERE status IN ('copied','verified')) AS cn,
            COALESCE(SUM(size) FILTER (WHERE status IN ('copied','verified')),0) AS cb,
            COUNT(*) FILTER (WHERE status = 'verified') AS vn
     FROM storage_migration_items WHERE migration_id = ?`, [id]);
  await touch(id, 'total_items = ?, total_bytes = ?, copied_items = ?, copied_bytes = ?, verified_items = ?',
    [Number(r!.n), Number(r!.b), Number(r!.cn), Number(r!.cb), Number(r!.vn)]);
}

// ---------------------------------------------------------------- copy / verify

interface Item { id: string; key: string; size: string; to_verify: boolean }

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const x = items[i++]; await fn(x); }
  }));
}

const errText = (e: any) => String(e?.message ?? e).slice(0, 300);

async function copyBatch(m: MigrationRow, src: BlobStore, dst: BlobStore, limit: number): Promise<number> {
  const items = await q<Item>(`SELECT id, key, size, to_verify FROM storage_migration_items WHERE migration_id = ? AND status = 'pending' ORDER BY id LIMIT ?`, [m.id, limit]);
  await pool(items, CONCURRENCY, async (it) => {
    try {
      const body = await src.get(it.key);
      await dst.put(it.key, body, it.key.endsWith('.eml') ? 'message/rfc822' : 'application/octet-stream');
      await run(`UPDATE storage_migration_items SET status = 'copied', size = ?, error = NULL WHERE id = ?`, [body.length, it.id]);
    } catch (e: any) {
      await run(`UPDATE storage_migration_items SET status = 'failed', error = ? WHERE id = ?`, [errText(e), it.id]);
    }
  });
  return items.length;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function verifyBatch(m: MigrationRow, src: BlobStore, dst: BlobStore, limit: number, all = false): Promise<number> {
  const items = await q<Item>(`SELECT id, key, size, to_verify FROM storage_migration_items WHERE migration_id = ? AND status = 'copied' ORDER BY id LIMIT ?`, [m.id, limit]);
  await pool(items, CONCURRENCY, async (it) => {
    const fail = (msg: string) => run(`UPDATE storage_migration_items SET status = 'failed', error = ? WHERE id = ?`, [msg, it.id]);
    try {
      const want = Number(it.size);
      let bytes: Buffer | null = null;
      let got: number | null;
      if (dst.head) got = await dst.head(it.key);
      else { try { bytes = await dst.get(it.key); got = bytes.length; } catch { got = null; } }
      if (got === null) return void await fail('missing in the new storage');
      if (got !== want) return void await fail(`size differs (expected ${want}, found ${got})`);
      if (all || it.to_verify || m.mode === 'strict') {
        bytes ??= await dst.get(it.key);
        const embedded = it.key.match(/([a-f0-9]{64})\.eml$/)?.[1];
        const expect = embedded ?? sha(await src.get(it.key));
        if (sha(bytes) !== expect) return void await fail('content checksum differs');
      }
      await run(`UPDATE storage_migration_items SET status = 'verified', error = NULL WHERE id = ?`, [it.id]);
    } catch (e: any) { await fail(errText(e)); }
  });
  return items.length;
}

/** Parse 20 random messages from the NEW storage and compare subject / sender with what the database says. */
async function appLevelCheck(m: MigrationRow, dst: BlobStore): Promise<string | null> {
  if (m.role !== 'mail') return null;
  const rows = await q<{ s3_key: string; subject: string | null; from_addr: string | null }>(
    `SELECT s3_key, subject, from_addr FROM messages WHERE s3_key IN
       (SELECT key FROM storage_migration_items WHERE migration_id = ? AND key LIKE '%.eml') ORDER BY random() LIMIT 20`, [m.id]);
  for (const r of rows) {
    try {
      const p = await simpleParser(await dst.get(r.s3_key));
      const subj = (p.subject ?? '') === (r.subject ?? '');
      const from = (p.from?.value?.[0]?.address ?? '').toLowerCase() === (r.from_addr ?? '').toLowerCase();
      if (!subj || !from) return `a message read from the new storage does not match the database (${r.s3_key})`;
    } catch (e: any) { return `could not read ${r.s3_key} from the new storage: ${errText(e)}`; }
  }
  return null;
}

// ---------------------------------------------------------------- switch

async function flip(m: MigrationRow): Promise<void> {
  const cfg = cfgOf(m.dest_enc);
  if (m.role === 'mail') { setMailStore(cfg); await saveMailStoreConfig(cfg); }
  else setBackupStore(cfg);
  await run('UPDATE storage_targets SET active = false WHERE role = ?', [m.role]);
  if (m.to_target_id) await run('UPDATE storage_targets SET active = true WHERE id = ?', [m.to_target_id]);
}

async function failVerify(m: MigrationRow, msg: string): Promise<string> {
  await refreshTotals(m.id);
  await touch(m.id, `status = 'failed_verify', error = ?, finished_at = ?`, [msg, Date.now()]);
  await emitToAdmins('storage.migration.failed', { type: 'storage_migration', id: m.id }, { role: m.role, error: msg }).catch(() => {});
  return 'failed_verify';
}

async function doSwitch(m: MigrationRow, src: BlobStore, dst: BlobStore, d: Deps): Promise<string> {
  setWritesPaused(true);
  try {
    // final delta: anything stored since planning, copied and checked in full while ingest waits
    const delta = await addPlanned(m, await wantedKeys(m, src), true);
    if (delta) {
      while ((await copyBatch(m, src, dst, d.batch ?? BATCH)) > 0) { /* drain */ }
      while ((await verifyBatch(m, src, dst, d.batch ?? BATCH, true)) > 0) { /* drain */ }
    }
    const bad = await one<{ c: string }>(`SELECT COUNT(*) AS c FROM storage_migration_items WHERE migration_id = ? AND status <> 'verified'`, [m.id]);
    if (Number(bad?.c ?? 0) > 0) return await failVerify(m, `${bad!.c} object(s) did not verify during the final copy`);
    await flip(m);
    const now = Date.now();
    await refreshTotals(m.id);
    if (m.kind === 'rollback') {
      await touch(m.id, `status = 'completed', error = NULL, switched_at = ?, finished_at = ?`, [now, now]);
      if (m.related_id) await run(`UPDATE storage_migrations SET status = 'rolled_back', updated_at = ? WHERE id = ?`, [now, m.related_id]);
    } else {
      await touch(m.id, `status = 'completed', error = NULL, switched_at = ?, finished_at = ?, retain_until = ?`, [now, now, now + RETAIN_MS]);
    }
    await emitToAdmins('storage.migration.done', { type: 'storage_migration', id: m.id },
      { role: m.role, from: m.source_bucket, to: m.dest_bucket, kind: m.kind, objects: m.total_items }).catch(() => {});
    return 'completed';
  } finally { setWritesPaused(false); }
}

// ---------------------------------------------------------------- the state machine

/** Process ONE batch of the migration and return its new status. Safe to call again after a crash. */
export async function stepMigration(id: number, d: Deps = {}): Promise<string> {
  let m = await getMigration(id);
  if (!m) return 'missing';
  if (!ACTIVE.includes(m.status) && m.status !== 'copying') return m.status;
  const { src, dst } = stores(m, d);
  const batch = d.batch ?? BATCH;

  if (m.status === 'planning') {
    await addPlanned(m, await wantedKeys(m, src), false);
    await refreshTotals(id);
    await touch(id, `status = 'copying'`);
    return 'copying';
  }
  if (m.status === 'copying') {
    const n = await copyBatch(m, src, dst, batch);
    await refreshTotals(id);
    if (n > 0) return 'copying';
    const failed = await one<{ c: string }>(`SELECT COUNT(*) AS c FROM storage_migration_items WHERE migration_id = ? AND status = 'failed'`, [id]);
    if (Number(failed?.c ?? 0) > 0) {
      const msg = `${failed!.c} object(s) could not be copied. Nothing was switched.`;
      await touch(id, `status = 'failed', error = ?, finished_at = ?`, [msg, Date.now()]);
      await emitToAdmins('storage.migration.failed', { type: 'storage_migration', id }, { role: m.role, error: msg }).catch(() => {});
      return 'failed';
    }
    // choose what gets the full checksum pass: all (strict) or 10% + the newest 1000
    await run(`UPDATE storage_migration_items SET to_verify = true WHERE migration_id = ? AND (? OR random() < 0.1
      OR id IN (SELECT id FROM storage_migration_items WHERE migration_id = ? ORDER BY id DESC LIMIT 1000))`, [id, m.mode === 'strict', id]);
    await touch(id, `status = 'verifying'`);
    return 'verifying';
  }
  if (m.status === 'verifying') {
    const n = await verifyBatch(m, src, dst, batch);
    await refreshTotals(id);
    if (n > 0) return 'verifying';
    const bad = await q<{ key: string; error: string }>(`SELECT key, error FROM storage_migration_items WHERE migration_id = ? AND status = 'failed' LIMIT 3`, [id]);
    if (bad.length) return failVerify(m, `Verification failed (e.g. ${bad[0].key}: ${bad[0].error}). Nothing was switched.`);
    const app = await appLevelCheck(m, dst);
    if (app) return failVerify(m, app);
    m = (await getMigration(id))!;
    if (m.verified_items !== m.total_items) return failVerify(m, `Count mismatch: ${m.verified_items} verified of ${m.total_items}.`);
    await touch(id, `status = 'switching'`);
    return 'switching';
  }
  if (m.status === 'switching') return doSwitch(m, src, dst, d);
  return m.status;
}

registerJob('storage.migrate', async (job) => {
  const id = Number(job.payload?.id);
  try {
    const status = await stepMigration(id);
    if (ACTIVE.includes(status)) await enqueueJob(null, 'storage.migrate', Date.now(), { id });
  } catch (err: any) {
    if (job.attempts >= 5) {
      const msg = errText(err);
      await run(`UPDATE storage_migrations SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = ANY(?)`, [msg, Date.now(), Date.now(), id, ACTIVE]);
      await emitToAdmins('storage.migration.failed', { type: 'storage_migration', id }, { error: msg }).catch(() => {});
      return;
    }
    throw err;
  }
});

/** Boot: a migration that was running when the server stopped continues. */
export async function resumeMigrations(): Promise<void> {
  for (const m of await q<MigrationRow>(`SELECT * FROM storage_migrations WHERE status = ANY(?)`, [ACTIVE])) {
    const pending = await one(`SELECT id FROM jobs WHERE kind = 'storage.migrate' AND status IN ('pending','running') AND (payload->>'id')::int = ?`, [m.id]);
    if (!pending) await enqueueJob(null, 'storage.migrate', Date.now(), { id: m.id });
  }
}

// ---------------------------------------------------------------- cleanup

/** Delete the OLD storage's copies. Only after the retention window, and only with the bucket name typed in. */
export async function cleanupSource(id: number, typedBucket: string, d: Deps = {}): Promise<{ ok: true; deleted: number } | { error: string }> {
  const m = await getMigration(id);
  if (!m || m.kind !== 'forward') return { error: 'not found' };
  if (m.status !== 'completed') return { error: 'Only a finished migration can be cleaned up.' };
  if (m.cleaned_at) return { error: 'Already cleaned up.' };
  if (!m.retain_until || Number(m.retain_until) > Date.now()) return { error: `The old storage is kept until ${new Date(Number(m.retain_until)).toLocaleDateString()}.` };
  if (typedBucket !== m.source_bucket) return { error: 'Type the old bucket’s name exactly to confirm.' };
  const src = d.src ?? makeStore(cfgOf(m.source_enc));
  const keys = await q<{ key: string }>(`SELECT key FROM storage_migration_items WHERE migration_id = ? AND status = 'verified'`, [id]);
  let deleted = 0;
  for (const k of keys) { await src.del(k.key); deleted++; }
  await touch(id, `cleaned_at = ?`, [Date.now()]);
  return { ok: true, deleted };
}

export async function listMigrations(): Promise<MigrationRow[]> {
  return q<MigrationRow>('SELECT * FROM storage_migrations ORDER BY id DESC LIMIT 50');
}
export { getMigration };
export async function failedItems(id: number): Promise<{ key: string; error: string | null }[]> {
  return q('SELECT key, error FROM storage_migration_items WHERE migration_id = ? AND status = \'failed\' ORDER BY id LIMIT 50', [id]);
}
