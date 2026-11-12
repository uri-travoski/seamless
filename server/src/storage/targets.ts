/** Storage targets (F-26): the mail / backup / spool buckets, chosen in the UI instead of the environment. */
import { createHash, randomBytes } from 'node:crypto';
import { q, one, run, insertId } from '../db.ts';
import { encrypt, decrypt } from '../crypto.ts';
import { makeStore, type S3Config, type Store } from '../s3.ts';

export type Role = 'mail' | 'backup' | 'spool';
export const ROLES: Role[] = ['mail', 'backup', 'spool'];

export interface TargetRow {
  id: number; role: Role | 'archive_source'; provider: string; endpoint: string; region: string; bucket: string; prefix: string;
  force_path_style: boolean; creds_enc: string; active: boolean; accept_same_bucket: boolean;
  created_at: string | number; verified_at: string | number | null; last_test: string | null;
}

/** What each provider's endpoint looks like; `{account}` / `{region}` are filled in by the form. */
export const PROVIDERS: Record<string, { name: string; endpoint: string; region: string; pathStyle: boolean }> = {
  r2: { name: 'Cloudflare R2', endpoint: 'https://{account}.r2.cloudflarestorage.com', region: 'auto', pathStyle: false },
  b2: { name: 'Backblaze B2', endpoint: 'https://s3.{region}.backblazeb2.com', region: 'us-west-004', pathStyle: false },
  s3: { name: 'Amazon S3', endpoint: 'https://s3.{region}.amazonaws.com', region: 'us-east-1', pathStyle: false },
  wasabi: { name: 'Wasabi', endpoint: 'https://s3.{region}.wasabisys.com', region: 'us-east-1', pathStyle: false },
  spaces: { name: 'DigitalOcean Spaces', endpoint: 'https://{region}.digitaloceanspaces.com', region: 'nyc3', pathStyle: false },
  hetzner: { name: 'Hetzner Object Storage', endpoint: 'https://{region}.your-objectstorage.com', region: 'fsn1', pathStyle: false },
  minio: { name: 'MinIO', endpoint: 'http://localhost:9000', region: 'us-east-1', pathStyle: true },
  other: { name: 'Other S3-compatible', endpoint: '', region: 'us-east-1', pathStyle: true },
};

export interface TargetInput {
  role: Role | 'archive_source'; provider: string; endpoint: string; region: string; bucket: string; prefix?: string;
  forcePathStyle?: boolean; accessKey?: string; secretKey?: string; acceptSameBucket?: boolean;
}

export interface TestStep { id: string; name: string; status: 'ok' | 'warn' | 'fail' | 'skipped'; ms: number; detail: string }
export interface TestResult { ok: boolean; warnings: number; steps: TestStep[]; latencyMs: number }

export function normalizePrefix(p: string | undefined, role: Role | 'archive_source'): string {
  let v = (p ?? (role === 'spool' ? '' : 'seamless/')).trim().replace(/^\/+/, '');
  if (v && !v.endsWith('/')) v += '/';
  return v;
}

export function toS3Config(row: TargetRow): S3Config {
  const c = JSON.parse(decrypt(row.creds_enc)) as { accessKey: string; secretKey: string };
  return {
    endpoint: row.endpoint, region: row.region, bucket: row.bucket,
    accessKey: c.accessKey, secretKey: c.secretKey, forcePathStyle: row.force_path_style,
  };
}

/** The API shape: never any credential, only whether one is stored. */
export function view(row: TargetRow) {
  let accessKeyHint = '';
  try { const k = (JSON.parse(decrypt(row.creds_enc)) as any).accessKey as string; accessKeyHint = k.length > 4 ? `…${k.slice(-4)}` : ''; } catch { /* unreadable under another secret */ }
  let lastTest: TestResult | null = null;
  try { lastTest = row.last_test ? JSON.parse(row.last_test) : null; } catch { /* ignore */ }
  return {
    id: row.id, role: row.role, provider: row.provider, endpoint: row.endpoint, region: row.region, bucket: row.bucket,
    prefix: row.prefix, forcePathStyle: row.force_path_style, active: row.active, acceptSameBucket: row.accept_same_bucket,
    createdAt: Number(row.created_at), verifiedAt: row.verified_at ? Number(row.verified_at) : null,
    hasCredentials: true, accessKeyHint, lastTest,
  };
}

/** The mail / backup / spool targets. Archive sources (T8.6, read-only, many at once) have their own list. */
export const listTargets = () => q<TargetRow>("SELECT * FROM storage_targets WHERE role <> 'archive_source' ORDER BY role, id");
export const listSourceTargets = () => q<TargetRow>("SELECT * FROM storage_targets WHERE role = 'archive_source' ORDER BY id");
export const getTarget = (id: number) => one<TargetRow>('SELECT * FROM storage_targets WHERE id = ?', [id]);
export const activeTarget = (role: Role) =>
  one<TargetRow>('SELECT * FROM storage_targets WHERE role = ? AND active ORDER BY id DESC LIMIT 1', [role]);

export async function insertTarget(i: TargetInput & { accessKey: string; secretKey: string }, active: boolean, test: TestResult | null): Promise<number> {
  const id = await insertId(
    `INSERT INTO storage_targets (role, provider, endpoint, region, bucket, prefix, force_path_style, creds_enc, active, accept_same_bucket, created_at, verified_at, last_test)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [i.role, i.provider, i.endpoint, i.region, i.bucket, normalizePrefix(i.prefix, i.role), !!i.forcePathStyle,
      encrypt(JSON.stringify({ accessKey: i.accessKey, secretKey: i.secretKey })), active, !!i.acceptSameBucket, Date.now(),
      test?.ok ? Date.now() : null, test ? JSON.stringify(test) : null]);
  if (active) await run('UPDATE storage_targets SET active = false WHERE role = ? AND id <> ?', [i.role, id]);
  return id;
}

export async function recordTest(id: number, test: TestResult): Promise<void> {
  await run('UPDATE storage_targets SET last_test = ?, verified_at = ? WHERE id = ?',
    [JSON.stringify(test), test.ok ? Date.now() : null, id]);
}

export function sameBucket(a: { endpoint: string; bucket: string }, b: { endpoint: string; bucket: string }): boolean {
  const norm = (e: string) => e.replace(/\/+$/, '').toLowerCase();
  return a.bucket === b.bucket && norm(a.endpoint) === norm(b.endpoint);
}

export interface TestOpts {
  store?: Pick<Store, 'headBucket' | 'put' | 'get' | 'list' | 'del'>;
  fetchImpl?: typeof fetch;
  prefix?: string;
  timeoutMs?: number;
}

/**
 * The 7 checks from the spec. Each step reports ok / warn / fail; a failure stops the chain
 * (later steps are "skipped") except delete, which only warns because retention needs it
 * but reading and writing still work without it.
 */
export async function testTarget(cfg: S3Config, opts: TestOpts = {}): Promise<TestResult> {
  const store = opts.store ?? makeStore(cfg);
  const doFetch = opts.fetchImpl ?? fetch;
  const prefix = normalizePrefix(opts.prefix, 'mail');
  const probeKey = `${prefix}.probe/${randomBytes(8).toString('hex')}`;
  const body = randomBytes(1024);
  const want = createHash('sha256').update(body).digest('hex');
  const steps: TestStep[] = [];
  let dead = false;
  let putOk = false;

  const step = async (id: string, name: string, fn: () => Promise<string | { warn: string } | void>, onlyIf = true) => {
    if (dead || !onlyIf) { steps.push({ id, name, status: 'skipped', ms: 0, detail: '' }); return; }
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
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
    try {
      const r = await doFetch(cfg.endpoint, { method: 'HEAD', signal: ctl.signal });
      return `HTTP ${r.status}`;      // any answer (even 403) proves the endpoint is reachable
    } catch (err: any) {
      throw new Error(`cannot connect to ${cfg.endpoint}: ${err?.cause?.code ?? err?.message ?? err}`);
    } finally { clearTimeout(timer); }
  });
  await step('auth', 'Sign in and find the bucket', async () => { await store.headBucket(); });
  await step('write', 'Write a 1 KB test object', async () => { await store.put(probeKey, body, 'application/octet-stream'); putOk = true; });
  await step('read', 'Read it back and compare', async () => {
    const back = await store.get(probeKey);
    const got = createHash('sha256').update(back).digest('hex');
    if (got !== want) throw new Error('read back different bytes (sha256 mismatch)');
    return 'sha256 matches';
  });
  await step('list', 'List the folder', async () => {
    const keys = await store.list(`${prefix}.probe/`);
    if (!keys.includes(probeKey)) throw new Error('the test object is not in the listing');
    return `${keys.length} object(s)`;
  });
  // delete is allowed to fail softly; do it even after a read/list failure so we don't leave junk
  dead = false;
  if (putOk) {
    const t0 = Date.now();
    try { await store.del(probeKey); steps.push({ id: 'delete', name: 'Delete the test object', status: 'ok', ms: Date.now() - t0, detail: '' }); }
    catch (err: any) {
      steps.push({ id: 'delete', name: 'Delete the test object', status: 'warn', ms: Date.now() - t0,
        detail: `Delete was refused (${err?.message ?? err}). Reading and writing work, but backup retention and cleanup need delete permission.` });
    }
  } else steps.push({ id: 'delete', name: 'Delete the test object', status: 'skipped', ms: 0, detail: '' });

  const failed = steps.some((s) => s.status === 'fail');
  const timed = steps.filter((s) => ['write', 'read', 'list'].includes(s.id) && s.status === 'ok');
  const latencyMs = timed.length ? Math.round(timed.reduce((n, s) => n + s.ms, 0) / timed.length) : 0;
  steps.push({ id: 'latency', name: 'Speed', status: failed ? 'skipped' : 'ok', ms: latencyMs,
    detail: failed ? '' : `about ${latencyMs} ms per request` });
  return { ok: !failed, warnings: steps.filter((s) => s.status === 'warn').length, steps, latencyMs };
}

/** Boot / activation: point the live stores at the active DB rows (unless the environment names a bucket). */
export async function applyActiveTargets(env: { mail: boolean; backup: boolean }): Promise<void> {
  const { setMailStore, setBackupStore } = await import('../s3.ts');
  if (!env.mail) { const m = await activeTarget('mail'); if (m) setMailStore(toS3Config(m)); }
  if (!env.backup) { const b = await activeTarget('backup'); if (b) setBackupStore(toS3Config(b)); }
}

export const backupEnvSet = () => !!process.env.S3_BACKUP_BUCKET || !!process.env.S3_BACKUP_ENDPOINT;

/** Messages whose raw mail lives in the mail store; switching buckets under them needs a migration (F-27). */
export async function mailObjectCount(): Promise<number> {
  const r = await one<{ c: string }>('SELECT COUNT(*) AS c FROM messages WHERE s3_key IS NOT NULL');
  return Number(r?.c ?? 0);
}

export async function usage(): Promise<{ objects: number; bytes: number }> {
  const r = await one<{ c: string; b: string }>('SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS b FROM messages WHERE s3_key IS NOT NULL');
  return { objects: Number(r?.c ?? 0), bytes: Number(r?.b ?? 0) };
}
