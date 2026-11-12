/** Archive old mail (T8.4): read an archive's manifest/index, search it without restoring, download one .eml, restore. */
import { gunzipSync } from 'node:zlib';
import { q, one, run, bumpState } from '../db.ts';
import { sha256 } from '../crypto.ts';
import { ingestMessage } from '../mail/ingest.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { audit } from '../audit/log.ts';
import { broadcast } from '../ws.ts';
import type { BlobStore } from '../s3.ts';
import { archiveStore, archivePrefix, getArchive, type ArchiveRow } from './run.ts';
import { ArchiveError } from './select.ts';

export interface IndexEntry {
  messageKey: string; accountKey: string; mailboxPath: string; uid: number; messageId: string | null; threadKey: string; date: number;
  from: { name: string; addr: string }; to: { name: string; addr: string }[]; cc: { name: string; addr: string }[];
  subject: string; snippet: string; flags: { seen: boolean; flagged: boolean; answered: boolean }; labelKeys: string[];
  hasAttachments: boolean; attachments: { filename: string; mime: string; size: number }[]; size: number; sha256: string; emlPath: string;
}
export interface Manifest {
  format: string; version: number; appVersion: string; archiveId: number; indexFiles: string[];
  accounts: { key: string; email: string; displayName: string; mailboxes: { path: string; role: string | null }[] }[];
  labels: { key: string; name: string; color: string; parentKey: string | null }[]; counts: { messages: number }; bytes: number;
}

export async function readManifest(a: ArchiveRow, store: BlobStore): Promise<Manifest> {
  if (!a.manifest_key) throw new ArchiveError(409, 'This archive has no manifest yet');
  const m = JSON.parse((await store.get(a.manifest_key)).toString('utf8')) as Manifest;
  if (m.format !== 'seamless-archive' || m.version !== 1) throw new ArchiveError(409, 'Unknown archive format');
  return m;
}

export async function* readIndex(m: Manifest, store: BlobStore): AsyncGenerator<IndexEntry> {
  for (const f of m.indexFiles) {
    const text = gunzipSync(await store.get(f)).toString('utf8');
    for (const line of text.split('\n')) if (line.trim()) yield JSON.parse(line) as IndexEntry;
  }
}

export interface ArchiveFilter { q?: string; from?: number; to?: number; keys?: string[] }

function matches(e: IndexEntry, f: ArchiveFilter): boolean {
  if (f.from != null && e.date < f.from) return false;
  if (f.to != null && e.date > f.to) return false;
  if (f.keys && !f.keys.includes(e.messageKey)) return false;
  if (f.q) {
    const hay = `${e.subject} ${e.from.name} ${e.from.addr} ${e.snippet} ${e.to.map((t) => t.addr).join(' ')}`.toLowerCase();
    for (const term of f.q.toLowerCase().split(/\s+/).filter(Boolean)) if (!hay.includes(term)) return false;
  }
  return true;
}

/** Search the manifest index: subject / sender / date, newest first. No .eml is opened. */
export async function searchArchive(userId: number, id: number, f: ArchiveFilter & { limit?: number }) {
  const a = await getArchive(userId, id);
  if (!a) throw new ArchiveError(404, 'archive not found');
  const store = await archiveStore(a);
  const m = await readManifest(a, store);
  const limit = Math.min(500, Math.max(1, f.limit ?? 50));
  const hits: IndexEntry[] = []; let total = 0;
  for await (const e of readIndex(m, store)) if (matches(e, f)) { total++; hits.push(e); }
  hits.sort((x, y) => y.date - x.date);
  return {
    total,
    results: hits.slice(0, limit).map((e) => ({
      key: e.messageKey, date: e.date, subject: e.subject, from: e.from, size: e.size, hasAttachments: e.hasAttachments, mailboxPath: e.mailboxPath,
      accountEmail: m.accounts.find((x) => x.key === e.accountKey)?.email ?? '',
    })),
  };
}

export async function downloadEml(userId: number, id: number, key: string): Promise<{ raw: Buffer; name: string }> {
  const a = await getArchive(userId, id);
  if (!a) throw new ArchiveError(404, 'archive not found');
  const store = await archiveStore(a);
  const m = await readManifest(a, store);
  for await (const e of readIndex(m, store)) {
    if (e.messageKey !== key) continue;
    const raw = await store.get(e.emlPath);
    if (sha256(raw) !== e.sha256) throw new ArchiveError(502, 'The archived copy failed its checksum');
    return { raw, name: `${(e.subject || 'message').replace(/[^\w.-]+/g, '_').slice(0, 60)}.eml` };
  }
  throw new ArchiveError(404, 'message not found in this archive');
}

export interface RestoreResult { expected: number; restored: number; alreadyPresent: number; noAccount: number; failed: number; ok: boolean }

/** Re-ingest matching messages into their original mailbox (non-live: no filters, no AI, no notifications). Idempotent. */
export async function restoreArchive(userId: number, id: number, f: ArchiveFilter): Promise<RestoreResult> {
  const a = await getArchive(userId, id);
  if (!a) throw new ArchiveError(404, 'archive not found');
  const store = await archiveStore(a);
  const m = await readManifest(a, store);
  const accounts = await q<{ id: number; email: string }>('SELECT id, email FROM accounts WHERE user_id = ?', [userId]);
  const acctFor = new Map(m.accounts.map((x) => [x.key, accounts.find((y) => y.email.toLowerCase() === x.email.toLowerCase())?.id]));
  const labelByKey = new Map<string, number>();
  for (const l of m.labels) {
    const row = await one<{ id: number }>('SELECT id FROM labels WHERE user_id = ? AND name = ?', [userId, l.name]);
    if (row) labelByKey.set(l.key, row.id);
  }
  const mailboxIds = new Map<string, number>();
  const res: RestoreResult = { expected: 0, restored: 0, alreadyPresent: 0, noAccount: 0, failed: 0, ok: false };

  for await (const e of readIndex(m, store)) {
    if (!matches(e, f)) continue;
    res.expected++;
    const accountId = acctFor.get(e.accountKey);
    if (!accountId) { res.noAccount++; continue; }
    try {
      if (await one('SELECT 1 FROM messages WHERE account_id = ? AND s3_key = ?', [accountId, `msg/${accountId}/${e.sha256}.eml`])) { res.alreadyPresent++; continue; }
      const raw = await store.get(e.emlPath);
      if (sha256(raw) !== e.sha256) { res.failed++; continue; }
      const mk = `${accountId}\u0000${e.mailboxPath}`;
      let mailboxId = mailboxIds.get(mk);
      if (!mailboxId) {
        const role = m.accounts.find((x) => x.key === e.accountKey)?.mailboxes.find((x) => x.path === e.mailboxPath)?.role ?? null;
        const row = await one<{ id: number }>('SELECT id FROM mailboxes WHERE account_id = ? AND path = ?', [accountId, e.mailboxPath])
          ?? await one<{ id: number }>('INSERT INTO mailboxes(account_id, path, role, name) VALUES (?,?,?,?) ON CONFLICT (account_id, path) DO UPDATE SET path = EXCLUDED.path RETURNING id', [accountId, e.mailboxPath, role, e.mailboxPath]);
        mailboxId = row!.id; mailboxIds.set(mk, mailboxId);
      }
      // a placeholder uid (negative) that the origin never had: sync ignores it, exactly like safe-deleted mail
      const uidRow = await one<{ uid: number }>('UPDATE mailboxes SET next_uid = next_uid + 1 WHERE id = ? RETURNING next_uid - 1 AS uid', [mailboxId]);
      const flags = new Set<string>();
      if (e.flags.seen) flags.add('\\Seen'); if (e.flags.flagged) flags.add('\\Flagged'); if (e.flags.answered) flags.add('\\Answered');
      const r = await ingestMessage({ accountId, mailboxId, uid: -(1_000_000_000 + uidRow!.uid), raw, flags, internalDate: new Date(e.date), isLive: false });
      if (!r) { res.alreadyPresent++; continue; }
      await run(`UPDATE messages SET origin_state = 'removed', classify_state = 'classified', disposition = 'keep', keep_reason = 'restored' WHERE id = ?`, [r.rowId]);
      for (const k of e.labelKeys) { const lid = labelByKey.get(k); if (lid) await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?) ON CONFLICT DO NOTHING', [r.rowId, lid]); }
      res.restored++;
    } catch (err: any) {
      if (/no blob|NoSuchKey/i.test(String(err?.message))) res.failed++; else throw err;   // a down store retries the job
    }
  }
  res.ok = res.failed === 0 && res.noAccount === 0 && res.restored + res.alreadyPresent === res.expected;
  return res;
}

export async function startRestore(userId: number, id: number, f: ArchiveFilter): Promise<number> {
  const a = await getArchive(userId, id);
  if (!a) throw new ArchiveError(404, 'archive not found');
  if (a.status !== 'done') throw new ArchiveError(409, 'The archive is not finished yet');
  await run("UPDATE mail_archives SET status = 'restoring', restore_result = NULL WHERE id = ?", [id]);
  await audit(null, 'archive.restore', { type: 'archive', id }, { filter: { q: f.q, from: f.from, to: f.to, keys: f.keys?.length } }, { userId });
  return enqueueJob(userId, 'archive.restore', Date.now(), { archiveId: id, filter: f });
}

registerJob('archive.restore', async (job) => {
  const id = Number(job.payload?.archiveId);
  const userId = job.user_id!;
  try {
    const result = await restoreArchive(userId, id, job.payload?.filter ?? {});
    await run("UPDATE mail_archives SET status = 'done', restore_result = ?::jsonb WHERE id = ?", [JSON.stringify(result), id]);
    await audit(null, 'archive.restore_done', { type: 'archive', id }, { ...result }, { userId });
    await bumpState(); broadcast({ type: 'stateChange' }, userId);
  } catch (err: any) {
    if (job.attempts >= 5 || err instanceof ArchiveError) {
      await run("UPDATE mail_archives SET status = 'done', restore_result = ?::jsonb WHERE id = ?", [JSON.stringify({ ok: false, error: String(err?.message ?? err) }), id]);
      if (err instanceof ArchiveError) return;
    }
    throw err;
  }
});

export { archivePrefix };
