/** Archive old mail (T8.4): plan → copy + verify → portable index/manifest/config → (move) remove. Resumable at every step. */
import { gzipSync } from 'node:zlib';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { sha256 } from '../crypto.ts';
import { getBlob, deleteBlob, makeStore, mailStoreLocation, type BlobStore } from '../s3.ts';
import { getTarget, toS3Config, sameBucket } from '../storage/targets.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { audit } from '../audit/log.ts';
import { broadcast } from '../ws.ts';
import { deleteMessageRow } from '../mail/ingest.ts';
import { pkgVersion } from '../routes/util.ts';
import { ArchiveError, DAY_MS, selectionFrom, scopeAccounts, parseOlderThan, previewArchive, sampleArchive, type ArchiveOptions } from './select.ts';
import { buildConfig } from './config.ts';
import { emitEvent } from '../events/emit.ts';

export const BATCH = 200;
export const INDEX_CHUNK = 5000;
const BUDGET_MS = 40_000;       // the job lock is 60 s: do a slice, then queue the rest
const MAX_ATTEMPTS = 5;

export interface ArchiveRow {
  id: number; user_id: number; name: string; older_than_days: number; scope: string; mode: 'copy' | 'move'; target_id: number | null;
  status: string; message_count: number; byte_count: string | number; options: ArchiveOptions; index_files: string[]; restore_result: any;
  created_at: string | number; started_at: string | number | null; finished_at: string | number | null; error: string | null; manifest_key: string | null; cutoff: string | number;
}

/** Where an archive's objects live. Tests swap it for a plain in-memory store. */
export type StoreFactory = (archive: ArchiveRow) => Promise<BlobStore>;
export const archivePrefix = (id: number) => `archive/${id}/`;

let factory: StoreFactory = async (a) => {
  const t = a.target_id ? await getTarget(a.target_id) : undefined;
  if (!t || t.role !== 'backup') throw new ArchiveError(409, 'The storage target for this archive is gone. Pick a backup storage target.');
  if (sameBucket(t, mailStoreLocation())) throw new ArchiveError(409, 'Archives are never written into the mail bucket. Pick a different backup storage target.');
  return makeStore({ ...toS3Config(t), keyPrefix: t.prefix });
};
export function setArchiveStoreFactory(f: StoreFactory | null): void {
  factory = f ?? (async (a) => { throw new ArchiveError(500, `no store for archive ${a.id}`); });
}
export const archiveStore = (a: ArchiveRow) => factory(a);

export const getArchive = (userId: number, id: number) => one<ArchiveRow>('SELECT * FROM mail_archives WHERE id = ? AND user_id = ?', [id, userId]);
const byId = (id: number) => one<ArchiveRow>('SELECT * FROM mail_archives WHERE id = ?', [id]);

export async function itemCounts(id: number): Promise<Record<string, number>> {
  const rows = await q<{ state: string; c: number }>('SELECT state, COUNT(*)::int c FROM mail_archive_items WHERE archive_id = ? GROUP BY state', [id]);
  return Object.fromEntries(rows.map((r) => [r.state, r.c]));
}

export async function view(a: ArchiveRow) {
  const counts = await itemCounts(a.id);
  const total = Object.values(counts).reduce((n, c) => n + c, 0);
  const done = (counts.verified ?? 0) + (counts.removed ?? 0) + (counts.failed ?? 0);
  return {
    id: a.id, name: a.name, olderThanDays: a.older_than_days, scope: a.scope, mode: a.mode, targetId: a.target_id, status: a.status,
    messageCount: a.message_count, byteCount: Number(a.byte_count), options: a.options, createdAt: Number(a.created_at),
    startedAt: a.started_at ? Number(a.started_at) : null, finishedAt: a.finished_at ? Number(a.finished_at) : null,
    error: a.error, hasManifest: !!a.manifest_key, restoreResult: a.restore_result ?? null,
    counts, progress: total ? done / total : (a.status === 'done' ? 1 : 0),
  };
}

export interface CreateInput { name?: string; scope?: string; mode?: string; targetId?: number; options?: ArchiveOptions; olderThanDays: number }

/** Plan an archive: pick the messages (items start `pending`) and queue the job. Nothing is copied yet. */
export async function planArchive(userId: number, inp: CreateInput, now = Date.now()): Promise<ArchiveRow> {
  const scope = inp.scope || 'all';
  const mode = inp.mode === 'move' ? 'move' : inp.mode === 'copy' || inp.mode == null ? 'copy' : null;
  if (!mode) throw new ArchiveError(400, 'mode must be copy or move');
  const t = inp.targetId ? await getTarget(Number(inp.targetId)) : undefined;
  if (!t || t.role !== 'backup') throw new ArchiveError(400, 'pick a saved backup storage target');
  if (sameBucket(t, mailStoreLocation())) throw new ArchiveError(409, 'Archives are never written into the mail bucket. Pick a different backup storage target.');
  const ids = await scopeAccounts(userId, scope);
  const o: ArchiveOptions = {
    includeStarred: !!inp.options?.includeStarred, includeVip: !!inp.options?.includeVip,
    includeSpamBin: !!inp.options?.includeSpamBin, alsoDeleteFromServer: mode === 'move' && !!inp.options?.alsoDeleteFromServer,
  };
  const cutoff = now - inp.olderThanDays * DAY_MS;
  const name = (inp.name ?? '').trim().slice(0, 120) || `Mail older than ${inp.olderThanDays} days`;
  const id = await insertId(
    `INSERT INTO mail_archives(user_id, name, older_than_days, scope, mode, target_id, status, options, cutoff, created_at)
     VALUES (?,?,?,?,?,?, 'planned', ?::jsonb, ?, ?)`,
    [userId, name, inp.olderThanDays, scope, mode, t.id, JSON.stringify(o), cutoff, now]);
  if (ids.length) {
    const { sql, params } = selectionFrom(userId, ids, cutoff, o);
    await run(
      `INSERT INTO mail_archive_items(archive_id, message_id, account_id, mailbox_path, uid, s3_key)
       SELECT ?, m.id, m.account_id, mb.path, m.uid, m.s3_key ${sql} ON CONFLICT DO NOTHING`, [id, ...params]);
  }
  await run(
    `UPDATE mail_archives SET message_count = (SELECT COUNT(*) FROM mail_archive_items WHERE archive_id = ?),
       byte_count = COALESCE((SELECT SUM(m.size) FROM mail_archive_items i JOIN messages m ON m.id = i.message_id WHERE i.archive_id = ?), 0) WHERE id = ?`, [id, id, id]);
  await enqueueJob(userId, 'archive.run', now, { archiveId: id });
  await audit(null, 'archive.plan', { type: 'archive', id }, { name, mode, scope, olderThanDays: inp.olderThanDays }, { userId });
  return (await byId(id))!;
}

const emlKey = (a: ArchiveRow, accountId: number, date: number, messageId: number) =>
  `${archivePrefix(a.id)}${accountId}/${new Date(date).getUTCFullYear()}/${messageId}.eml`;

async function setItem(archiveId: number, messageId: number, state: string, extra: { sha?: string; error?: string | null } = {}) {
  await run('UPDATE mail_archive_items SET state = ?, sha256 = COALESCE(?, sha256), error = ? WHERE archive_id = ? AND message_id = ?',
    [state, extra.sha ?? null, extra.error ?? null, archiveId, messageId]);
}

/** Copy one batch to the archive store and read every object back. Returns how many items it handled. */
async function copyBatch(a: ArchiveRow, store: BlobStore): Promise<number> {
  const items = await q<any>(
    `SELECT i.message_id, i.account_id, i.s3_key, i.state, i.sha256, m.date FROM mail_archive_items i
     LEFT JOIN messages m ON m.id = i.message_id
     WHERE i.archive_id = ? AND i.state IN ('pending','copied') ORDER BY i.message_id LIMIT ${BATCH}`, [a.id]);
  for (const it of items) {
    try {
      if (it.date == null) { await setItem(a.id, it.message_id, 'failed', { error: 'message no longer in the app' }); continue; }
      const key = emlKey(a, it.account_id, Number(it.date), it.message_id);
      let sha = it.sha256 as string | null;
      if (it.state === 'pending' || !sha) {
        const raw = await getBlob(it.s3_key);
        sha = sha256(raw);
        await store.put(key, raw, 'message/rfc822');
        await setItem(a.id, it.message_id, 'copied', { sha });
      }
      const back = await store.get(key);          // read it back and compare: copied is not verified
      if (sha256(back) !== sha) await setItem(a.id, it.message_id, 'failed', { error: 'checksum mismatch after copy' });
      else await setItem(a.id, it.message_id, 'verified', { sha });
    } catch (err: any) {
      const missing = /no blob|NoSuchKey|not found|404/i.test(String(err?.message ?? err));
      // a store that is down must retry the job; a single unreadable source blob only fails that message
      if (!missing) throw err;
      await setItem(a.id, it.message_id, 'failed', { error: String(err?.message ?? err).slice(0, 300) });
    }
  }
  return items.length;
}

const addr = (list: string) => { try { return (JSON.parse(list) as any[]).map((x) => ({ name: x.name ?? '', addr: x.email ?? x.addr ?? '' })); } catch { return []; } };

/** Index files (5,000 per file), manifest.json and config.json. Only verified messages are listed. */
async function writeIndexAndManifest(a: ArchiveRow, store: BlobStore): Promise<void> {
  const accounts = await q<any>(
    `SELECT DISTINCT a.id, a.email, a.name FROM accounts a JOIN mail_archive_items i ON i.account_id = a.id WHERE i.archive_id = ? ORDER BY a.id`, [a.id]);
  const mailboxes = await q<any>(
    `SELECT DISTINCT mb.account_id, mb.path, mb.role FROM mailboxes mb JOIN mail_archive_items i ON i.account_id = mb.account_id WHERE i.archive_id = ? ORDER BY mb.account_id, mb.path`, [a.id]);
  const labels = await q<any>(`SELECT id, name, color, parent_id FROM labels WHERE user_id = ? ORDER BY id`, [a.user_id]);
  const files: string[] = [];
  let after = 0, n = 0, bytes = 0;
  const verifiedIds: number[] = [];
  for (;;) {
    const rows = await q<any>(
      `SELECT m.*, i.sha256 AS arch_sha, i.mailbox_path,
         COALESCE((SELECT json_agg(ml.label_id) FROM message_labels ml WHERE ml.message_id = m.id), '[]'::json) AS label_ids
       FROM mail_archive_items i JOIN messages m ON m.id = i.message_id
       WHERE i.archive_id = ? AND i.state IN ('verified','removed') AND i.message_id > ? ORDER BY i.message_id LIMIT ${INDEX_CHUNK}`, [a.id, after]);
    if (!rows.length) break;
    const lines = rows.map((m) => {
      verifiedIds.push(m.id); bytes += m.size;
      return JSON.stringify({
        messageKey: `M${m.id}`, accountKey: `A${m.account_id}`, mailboxPath: m.mailbox_path, uid: Number(m.uid), messageId: m.message_id, threadKey: m.thread_id,
        date: Number(m.date), from: { name: m.from_name, addr: m.from_addr }, to: addr(m.to_json), cc: addr(m.cc_json), subject: m.subject, snippet: m.snippet,
        flags: { seen: !m.unread, flagged: m.flagged, answered: m.answered }, labelKeys: (m.label_ids as number[]).map((l) => `L${l}`),
        hasAttachments: m.has_attachments,
        attachments: (() => { try { return (JSON.parse(m.attachments_json) as any[]).map((x) => ({ filename: x.filename, mime: x.contentType, size: x.size })); } catch { return []; } })(),
        size: m.size, sha256: m.arch_sha, emlPath: emlKey(a, m.account_id, Number(m.date), m.id),
      });
    });
    n += rows.length; after = rows[rows.length - 1].id;
    const file = `${archivePrefix(a.id)}index-${files.length + 1}.jsonl.gz`;
    await store.put(file, gzipSync(Buffer.from(lines.join('\n') + '\n')), 'application/gzip');
    files.push(file);
  }
  const failed = (await itemCounts(a.id)).failed ?? 0;
  const manifest = {
    format: 'seamless-archive', version: 1, appVersion: pkgVersion, createdAt: Date.now(), archiveId: a.id,
    rule: { olderThanDays: a.older_than_days, scope: a.scope, mode: a.mode },
    accounts: accounts.map((x) => ({
      key: `A${x.id}`, email: x.email, displayName: x.name || x.email,
      mailboxes: mailboxes.filter((m) => m.account_id === x.id).map((m) => ({ path: m.path, role: m.role })),
    })),
    labels: labels.map((l) => ({ key: `L${l.id}`, name: l.name, color: l.color, parentKey: l.parent_id ? `L${l.parent_id}` : null })),
    counts: { messages: n, failed }, bytes, indexFiles: files, config: `${archivePrefix(a.id)}config.json`,
  };
  await store.put(`${archivePrefix(a.id)}config.json`, Buffer.from(JSON.stringify(await buildConfig(a.user_id, a.id, verifiedIds))), 'application/json');
  const mkey = `${archivePrefix(a.id)}manifest.json`;
  await store.put(mkey, Buffer.from(JSON.stringify(manifest, null, 1)), 'application/json');
  await run('UPDATE mail_archives SET manifest_key = ?, index_files = ?::jsonb WHERE id = ?', [mkey, JSON.stringify(files), a.id]);
}

/** Move mode: remove verified items from the app, one by one. A crash anywhere leaves a state the next pass finishes. */
async function removeBatch(a: ArchiveRow): Promise<number> {
  const items = await q<any>(
    `SELECT message_id, account_id, s3_key, uid, mailbox_path FROM mail_archive_items WHERE archive_id = ? AND state = 'verified' ORDER BY message_id LIMIT ${BATCH}`, [a.id]);
  for (const it of items) {
    const msg = await one<any>('SELECT id, mailbox_id FROM messages WHERE id = ? AND user_id = ?', [it.message_id, a.user_id]);
    if (msg) {
      if (a.options.alsoDeleteFromServer && Number(it.uid) > 0) {
        const { enqueueOp } = await import('../imap/sync.ts');
        await enqueueOp(it.account_id, 'move', { mailboxId: msg.mailbox_id, uid: Number(it.uid), targetRole: 'trash' }).catch(() => {});
      }
      await deleteMessageRow(it.message_id);   // message_fts, labels, attachment text, vectors go with the row; IMAP is not touched
    }
    // the blob is shared by identical copies in the same account: delete it only when nothing else points at it
    const still = await one('SELECT 1 FROM messages WHERE s3_key = ? LIMIT 1', [it.s3_key]);
    if (!still) await deleteBlob(it.s3_key).catch(() => {});
    await setItem(a.id, it.message_id, 'removed', { error: null });
  }
  return items.length;
}

export interface RunOpts { budgetMs?: number }

/** One slice of work. Returns true when the archive is finished (done or failed), false when more is left. */
export async function runArchiveSlice(archiveId: number, opts: RunOpts = {}): Promise<boolean> {
  const t0 = Date.now(); const budget = opts.budgetMs ?? BUDGET_MS;
  let a = await byId(archiveId);
  if (!a || a.status === 'done' || a.status === 'failed') return true;
  const store = await archiveStore(a);
  if (a.status === 'planned') {
    await run("UPDATE mail_archives SET status = 'running', started_at = ?, error = NULL WHERE id = ?", [Date.now(), a.id]);
    await audit(null, 'archive.run', { type: 'archive', id: a.id }, { mode: a.mode, messages: a.message_count }, { userId: a.user_id });
  }
  while ((await copyBatch(a, store)) > 0) {
    if (Date.now() - t0 > budget) return false;
  }
  if (!a.manifest_key) {
    await run("UPDATE mail_archives SET status = 'verifying' WHERE id = ?", [a.id]);
    await writeIndexAndManifest(a, store);
    broadcast({ type: 'stateChange' }, a.user_id);
  }
  if (a.mode === 'move') {
    while ((await removeBatch(a)) > 0) {
      if (Date.now() - t0 > budget) return false;
    }
  }
  const c = await itemCounts(a.id);
  const failed = c.failed ?? 0;
  await run("UPDATE mail_archives SET status = 'done', finished_at = ?, error = ? WHERE id = ?",
    [Date.now(), failed ? `${failed} message${failed === 1 ? '' : 's'} could not be verified and ${a.mode === 'move' ? 'were kept in the app' : 'are not in the archive'}` : null, a.id]);
  await audit(null, 'archive.complete', { type: 'archive', id: a.id }, { mode: a.mode, archived: (c.verified ?? 0) + (c.removed ?? 0), failed }, { userId: a.user_id });
  await bumpState(); broadcast({ type: 'stateChange' }, a.user_id);
  await emitEvent(a.user_id, 'archive.done', { type: 'archive', id: a.id }, { name: a.name, mode: a.mode, archived: (c.verified ?? 0) + (c.removed ?? 0), failed });
  return true;
}

registerJob('archive.run', async (job) => {
  const id = Number(job.payload?.archiveId);
  try {
    if (!(await runArchiveSlice(id))) await enqueueJob(job.user_id, 'archive.run', Date.now(), { archiveId: id });
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 500);
    const fatal = err instanceof ArchiveError || job.attempts >= MAX_ATTEMPTS;
    await run('UPDATE mail_archives SET error = ?, status = CASE WHEN ? THEN \'failed\' ELSE status END, finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ?',
      [msg, fatal, fatal, Date.now(), id]);
    if (fatal) {
      const a = await byId(id);
      if (a) broadcast({ type: 'stateChange' }, a.user_id);
      if (a) await emitEvent(a.user_id, 'archive.failed', { type: 'archive', id }, { name: a.name, error: msg }).catch(() => {});
    }
    if (fatal && err instanceof ArchiveError) return;   // nothing a retry can fix
    throw err;
  }
});

export { parseOlderThan, previewArchive, sampleArchive };
