/** Open an archive in another instance (T8.6): where archives are read from (bucket / .zip / folder), finding them, and the
 *  read-only connection test. Nothing in here ever writes to the source. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { makeStore, type BlobStore, type S3Config } from '../s3.ts';
import { toS3Config, getTarget, type TestResult, type TestStep } from '../storage/targets.ts';
import { ArchiveError } from './select.ts';
import type { Manifest } from './restore.ts';

export const SUPPORTED_FORMAT = 'seamless-archive';
export const SUPPORTED_VERSION = 1;

export interface ImportSourceRef { kind: 'bucket' | 'zip' | 'folder'; targetId: number | null; ref: string }

/** Wrap any store so a write is impossible: a read-only key is enough, and a read-write key is still never written with. */
export function readOnly(inner: Pick<BlobStore, 'get' | 'list'> & Partial<BlobStore>): BlobStore {
  const no = async (): Promise<never> => { throw new Error('the archive source is read-only'); };
  return { get: (k) => inner.get(k), list: (p) => inner.list(p), put: no, del: no };
}

/** An uploaded archive .zip (or a zip of an archive folder). Entry names are the keys. */
export async function zipStore(file: string): Promise<BlobStore> {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name);
  return readOnly({
    list: async (p) => names.filter((n) => n.startsWith(p)).sort(),
    get: async (k) => {
      const f = zip.file(k);
      if (!f) throw new Error(`no blob ${k}`);
      return Buffer.from(await f.async('nodebuffer'));
    },
  });
}

/** A folder on this server (an archive downloaded from the bucket). Reads stay inside the folder. */
export function folderStore(root: string): BlobStore {
  const base = path.resolve(root);
  const walk = (dir: string, out: string[]) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out); else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  };
  return readOnly({
    list: async (p) => { const out: string[] = []; walk(base, out); return out.filter((n) => n.startsWith(p)).sort(); },
    get: async (k) => {
      const full = path.resolve(base, k);
      if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`no blob ${k}`);
      if (!fs.existsSync(full)) throw new Error(`no blob ${k}`);
      return fs.readFileSync(full);
    },
  });
}

export type SourceStoreFactory = (src: ImportSourceRef) => Promise<BlobStore>;

const defaultFactory: SourceStoreFactory = async (src) => {
  if (src.kind === 'zip') return zipStore(src.ref);
  if (src.kind === 'folder') return folderStore(src.ref);
  const t = src.targetId ? await getTarget(src.targetId) : undefined;
  if (!t || t.role !== 'archive_source') throw new ArchiveError(409, 'The attached bucket is gone. Attach it again.');
  return readOnly(makeStore({ ...toS3Config(t), keyPrefix: t.prefix }));
};
let factory: SourceStoreFactory = defaultFactory;
/** Tests swap the bucket for an in-memory store; null puts the real one back. */
export function setSourceStoreFactory(f: SourceStoreFactory | null): void { factory = f ?? defaultFactory; }
export const sourceStore = (src: ImportSourceRef) => factory(src);

export const dirOf = (key: string) => (key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '');

/** Why an archive manifest cannot be opened by this app (null = fine). */
export function unsupportedReason(m: any): string | null {
  if (m?.format !== SUPPORTED_FORMAT) return 'Not an archive made by this app';
  if (typeof m.version !== 'number' || m.version > SUPPORTED_VERSION) return `Made by a newer version of the app (archive format ${m.version}). Update this app to open it.`;
  if (m.version < 1) return 'Unknown archive format';
  return null;
}

export interface FoundArchive {
  kind: 'archive'; path: string; name: string; createdAt: number | null; rule: any; accounts: { key: string; email: string; displayName: string }[];
  messages: number; bytes: number; appVersion: string; formatVersion: number | null; supported: boolean; reason: string | null;
}
export interface FoundBackup { kind: 'backup'; path: string; createdAt: number | null; appVersion: string; rows: number; bytes: number; note: string }

/** List every `manifest.json` under the store: archives (shown even when unsupported, with the reason) and full backups. */
export async function scanSource(store: BlobStore): Promise<{ archives: FoundArchive[]; backups: FoundBackup[] }> {
  const keys = (await store.list('')).filter((k) => k === 'manifest.json' || k.endsWith('/manifest.json'));
  const archives: FoundArchive[] = []; const backups: FoundBackup[] = [];
  for (const key of keys) {
    let m: any;
    try { m = JSON.parse((await store.get(key)).toString('utf8')); } catch { continue; }   // foreign or half-written: ignore
    if (!m || typeof m !== 'object') continue;
    if (m.format === SUPPORTED_FORMAT) {
      const reason = unsupportedReason(m);
      archives.push({
        kind: 'archive', path: dirOf(key), name: String(m.name || `Archive #${m.archiveId ?? ''}`.trim()), createdAt: Number(m.createdAt) || null, rule: m.rule ?? null,
        accounts: (m.accounts ?? []).map((a: any) => ({ key: a.key, email: a.email, displayName: a.displayName })),
        messages: Number(m.counts?.messages) || 0, bytes: Number(m.bytes) || 0, appVersion: String(m.appVersion ?? 'unknown'),
        formatVersion: typeof m.version === 'number' ? m.version : null, supported: !reason, reason,
      });
    } else if (m.enc && m.tables && m.secretCheck) {
      backups.push({
        kind: 'backup', path: dirOf(key), createdAt: Number(m.createdAt) || null, appVersion: String(m.appVersion ?? 'unknown'), rows: Number(m.rows) || 0, bytes: Number(m.bytes) || 0,
        note: 'This is a full backup, not an archive. Restoring it replaces ALL data in this app: use Settings → Backup → Restore (and set SEAMLESS_MODE=viewing for a viewer).',
      });
    }
  }
  archives.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { archives, backups };
}

/** manifest.json of the archive in `dir`, refused when the format is unknown or newer. */
export async function readManifestIn(store: BlobStore, dir: string): Promise<Manifest & { name?: string; createdAt?: number; rule?: any; config?: string }> {
  let m: any;
  try { m = JSON.parse((await store.get(`${dir}manifest.json`)).toString('utf8')); } catch { throw new ArchiveError(404, 'manifest.json not found or unreadable at that location'); }
  const reason = unsupportedReason(m);
  if (reason) throw new ArchiveError(409, reason);
  return m;
}

/** Index/eml/config paths inside a manifest are as the archiving instance wrote them (`archive/<id>/…`); rebase onto where we found it. */
export function rebaser(m: { archiveId: number }, dir: string): (p: string) => string {
  const marker = `archive/${m.archiveId}/`;
  return (p) => { const i = p.indexOf(marker); return dir + (i >= 0 ? p.slice(i + marker.length) : p); };
}

/**
 * The 7 checks of the storage form, read-only: reach, sign in, list, find archives/backups, read a manifest,
 * check its format version, read one message back and verify its checksum. Never writes.
 */
export async function testSource(cfg: S3Config, opts: { store?: BlobStore & { headBucket?: () => Promise<void> }; fetchImpl?: typeof fetch; prefix?: string; timeoutMs?: number } = {}): Promise<TestResult> {
  const raw = opts.store ?? makeStore({ ...cfg, keyPrefix: opts.prefix ?? cfg.keyPrefix });
  const store = readOnly(raw);
  const doFetch = opts.fetchImpl ?? fetch;
  const steps: TestStep[] = []; let dead = false;
  const t00 = Date.now();
  let keys: string[] = []; let firstArchive: { dir: string; m: any } | null = null; let found = 0;
  const step = async (id: string, name: string, fn: () => Promise<string | { warn: string } | void>) => {
    if (dead) { steps.push({ id, name, status: 'skipped', ms: 0, detail: '' }); return; }
    const t0 = Date.now();
    try {
      const r = await fn();
      if (r && typeof r === 'object') steps.push({ id, name, status: 'warn', ms: Date.now() - t0, detail: r.warn });
      else steps.push({ id, name, status: 'ok', ms: Date.now() - t0, detail: r || '' });
    } catch (err: any) {
      dead = true;
      steps.push({ id, name, status: 'fail', ms: Date.now() - t0, detail: String(err?.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err?.message ?? err) });
    }
  };
  await step('reach', 'Reach the server (DNS + TLS)', async () => {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
    try { const r = await doFetch(cfg.endpoint, { method: 'HEAD', signal: ctl.signal }); return `HTTP ${r.status}`; }
    catch (err: any) { throw new Error(`cannot connect to ${cfg.endpoint}: ${err?.cause?.code ?? err?.message ?? err}`); }
    finally { clearTimeout(timer); }
  });
  await step('auth', 'Sign in and find the bucket', async () => { await (raw as any).headBucket?.(); });
  await step('list', 'List the folder (read access)', async () => { keys = await store.list(''); return `${keys.length} object${keys.length === 1 ? '' : 's'}`; });
  await step('find', 'Look for archives and backups', async () => {
    const manifests = keys.filter((k) => k === 'manifest.json' || k.endsWith('/manifest.json'));
    for (const k of manifests) {
      try {
        const m = JSON.parse((await store.get(k)).toString('utf8'));
        if (m?.format === SUPPORTED_FORMAT || (m?.enc && m?.tables)) found++;
        if (m?.format === SUPPORTED_FORMAT && !firstArchive) firstArchive = { dir: dirOf(k), m };
      } catch { /* foreign file */ }
    }
    if (!found) throw new Error('no archive or backup found in this folder (check the folder/prefix)');
    return `${found} found`;
  });
  await step('manifest', 'Read an archive manifest', async () => {
    if (!firstArchive) return { warn: 'Only full backups here: they are restored from Settings → Backup, not imported' };
    return `${(firstArchive as any).m.counts?.messages ?? 0} messages listed`;
  });
  await step('format', 'Check the archive format version', async () => {
    if (!firstArchive) return { warn: 'no archive to check' };
    const reason = unsupportedReason((firstArchive as any).m);
    if (reason) return { warn: reason };
    return `format ${(firstArchive as any).m.version}, made by app ${(firstArchive as any).m.appVersion}`;
  });
  await step('eml', 'Read one message and verify its checksum', async () => {
    const fa = firstArchive as any;
    if (!fa || unsupportedReason(fa.m)) return { warn: 'skipped' };
    const rb = rebaser(fa.m, fa.dir);
    const file = fa.m.indexFiles?.[0];
    if (!file) return { warn: 'the archive has no messages' };
    const { gunzipSync } = await import('node:zlib');
    const line = gunzipSync(await store.get(rb(file))).toString('utf8').split('\n').find((l) => l.trim());
    if (!line) return { warn: 'the archive has no messages' };
    const e = JSON.parse(line);
    const eml = await store.get(rb(e.emlPath));
    if (createHash('sha256').update(eml).digest('hex') !== e.sha256) throw new Error('checksum mismatch');
    return 'checksum matches';
  });
  const fails = steps.filter((s) => s.status === 'fail').length;
  return { ok: fails === 0, warnings: steps.filter((s) => s.status === 'warn').length, steps, latencyMs: Date.now() - t00 };
}
