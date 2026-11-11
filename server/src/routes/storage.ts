/** Storage targets (F-26). Admin only; credentials go in, never come out. */
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { isAdmin } from './util.ts';
import { databaseIsEmpty } from '../backup/engine.ts';
import { mailStoreLocation, setMailStore, setBackupStore, type S3Config } from '../s3.ts';
import { saveMailStoreConfig } from '../backup/mailref.ts';
import {
  ROLES, PROVIDERS, listTargets, getTarget, activeTarget, insertTarget, recordTest, testTarget, toS3Config, view,
  sameBucket, normalizePrefix, backupEnvSet, mailObjectCount, usage, type Role, type TargetInput, type TargetRow,
} from '../storage/targets.ts';
import { reingestSpool } from '../storage/spool.ts';
import { run } from '../db.ts';
import {
  listMigrations, getMigration, startMigration, startRollback, cancelMigration, retryMigration, cleanupSource,
  planSummary, failedItems, view as migrationView,
} from '../storage/migrate.ts';

function parse(b: any, fallback?: TargetRow): TargetInput | string {
  const role = (b.role ?? fallback?.role) as Role;
  if (!ROLES.includes(role)) return 'role must be mail, backup or spool';
  const provider = String(b.provider ?? fallback?.provider ?? 'other');
  if (!PROVIDERS[provider]) return 'unknown provider';
  const endpoint = String(b.endpoint ?? fallback?.endpoint ?? '').trim();
  if (!/^https?:\/\/[^\s/]+/i.test(endpoint)) return 'endpoint must be a full URL (https://…)';
  const bucket = String(b.bucket ?? fallback?.bucket ?? '').trim();
  if (!bucket) return 'bucket is required';
  return {
    role, provider, endpoint, bucket,
    region: String(b.region ?? fallback?.region ?? 'us-east-1').trim() || 'us-east-1',
    prefix: b.prefix ?? fallback?.prefix,
    forcePathStyle: b.forcePathStyle ?? fallback?.force_path_style ?? PROVIDERS[provider].pathStyle,
    accessKey: b.accessKey ? String(b.accessKey) : undefined,
    secretKey: b.secretKey ? String(b.secretKey) : undefined,
    acceptSameBucket: b.acceptSameBucket ?? fallback?.accept_same_bucket ?? false,
  };
}

const cfgOf = (i: TargetInput, accessKey: string, secretKey: string): S3Config =>
  ({ endpoint: i.endpoint, region: i.region, bucket: i.bucket, accessKey, secretKey, forcePathStyle: !!i.forcePathStyle });

/** A backup that sits in the mail bucket is lost together with it, unless the admin accepted that. */
async function sameBucketProblem(i: TargetInput): Promise<string | null> {
  if (i.acceptSameBucket || i.role === 'spool') return null;
  const other = i.role === 'backup' ? ((await activeTarget('mail')) ?? null) : ((await activeTarget('backup')) ?? null);
  const otherLoc = other ? { endpoint: other.endpoint, bucket: other.bucket }
    : i.role === 'backup' ? mailStoreLocation() : null;
  if (otherLoc && sameBucket(i, otherLoc)) {
    return i.role === 'backup'
      ? 'Backups must go to a different bucket from your mail, or tick “I accept using the same bucket”.'
      : 'That is the bucket your backups use. Use a different one, or tick “I accept using the same bucket”.';
  }
  return null;
}

export function register(app: FastifyInstance): void {
  registerMigrations(app);
  const guard = (req: any, reply: any) => (isAdmin(req) ? false : (reply.code(403).send({ error: 'admin only' }), true));

  app.get('/api/storage/targets', async (req, reply) => {
    if (guard(req, reply)) return;
    const loc = mailStoreLocation();
    return {
      targets: (await listTargets()).map(view),
      providers: PROVIDERS,
      envOverride: { mail: config.s3FromEnv, backup: config.s3FromEnv || backupEnvSet() },
      current: { mail: { endpoint: loc.endpoint, bucket: loc.bucket } },
    };
  });

  app.get('/api/storage/targets/usage', async (req, reply) => {
    if (guard(req, reply)) return;
    return usage();
  });

  /** Test a config that is not saved yet (the wizard). Blank creds are never reused from a stored row here. */
  app.post('/api/storage/targets/test', async (req, reply) => {
    if (guard(req, reply)) return;
    const i = parse((req.body ?? {}) as any);
    if (typeof i === 'string') return reply.code(400).send({ error: i });
    if (!i.accessKey || !i.secretKey) return reply.code(400).send({ error: 'access key and secret key are required' });
    return testTarget(cfgOf(i, i.accessKey, i.secretKey), { prefix: i.prefix });
  });

  app.post('/api/storage/targets/:id/test', async (req, reply) => {
    if (guard(req, reply)) return;
    const row = await getTarget(Number((req.params as any).id));
    if (!row) return reply.code(404).send({ error: 'not found' });
    const res = await testTarget(toS3Config(row), { prefix: row.prefix });
    await recordTest(row.id, res);
    return res;
  });

  app.post('/api/storage/targets', async (req, reply) => {
    if (guard(req, reply)) return;
    const i = parse((req.body ?? {}) as any);
    if (typeof i === 'string') return reply.code(400).send({ error: i });
    if (!i.accessKey || !i.secretKey) return reply.code(400).send({ error: 'access key and secret key are required' });
    const problem = await sameBucketProblem(i);
    if (problem) return reply.code(400).send({ error: problem });
    const test = await testTarget(cfgOf(i, i.accessKey, i.secretKey), { prefix: i.prefix });
    if (!test.ok) return reply.code(400).send({ error: 'The storage test failed, so nothing was saved.', test });

    // Pointing the mail store at an empty new bucket would orphan every message already stored.
    let note = '';
    let active = true;
    if (i.role === 'mail' && (await mailObjectCount()) > 0) {
      active = false;
      note = 'Saved but not switched on: you already have mail stored elsewhere. Use “Move to another bucket” on this page to move your mail there.';
    }
    const id = await insertTarget({ ...i, accessKey: i.accessKey, secretKey: i.secretKey }, active, test);
    const row = (await getTarget(id))!;
    if (active) await applyRow(row);
    return { target: view(row), test, note, overriddenByEnv: active && overridden(row.role) };
  });

  app.put('/api/storage/targets/:id', async (req, reply) => {
    if (guard(req, reply)) return;
    const row = await getTarget(Number((req.params as any).id));
    if (!row) return reply.code(404).send({ error: 'not found' });
    const i = parse((req.body ?? {}) as any, row);
    if (typeof i === 'string') return reply.code(400).send({ error: i });
    const old = toS3Config(row);
    const accessKey = i.accessKey ?? old.accessKey, secretKey = i.secretKey ?? old.secretKey;
    const changed = i.endpoint !== row.endpoint || i.bucket !== row.bucket || i.region !== row.region
      || i.accessKey !== undefined || i.secretKey !== undefined || i.forcePathStyle !== row.force_path_style;
    // moving a live mail target to a different bucket is a migration, not an edit
    if (row.role === 'mail' && row.active && (i.endpoint !== row.endpoint || i.bucket !== row.bucket) && (await mailObjectCount()) > 0) {
      return reply.code(400).send({ error: 'This is where your mail is stored. To change the bucket, add the new one and migrate. Only the credentials, region and prefix can be edited here.' });
    }
    const problem = await sameBucketProblem({ ...i, role: row.role });
    if (problem) return reply.code(400).send({ error: problem });
    let test = null as Awaited<ReturnType<typeof testTarget>> | null;
    if (changed) {
      test = await testTarget(cfgOf(i, accessKey, secretKey), { prefix: i.prefix });
      if (!test.ok) return reply.code(400).send({ error: 'The storage test failed, so nothing was changed.', test });
    }
    const { encrypt } = await import('../crypto.ts');
    await run(`UPDATE storage_targets SET provider = ?, endpoint = ?, region = ?, bucket = ?, prefix = ?, force_path_style = ?,
               creds_enc = ?, accept_same_bucket = ?, verified_at = COALESCE(?, verified_at), last_test = COALESCE(?, last_test) WHERE id = ?`,
      [i.provider, i.endpoint, i.region, i.bucket, normalizePrefix(i.prefix, row.role), !!i.forcePathStyle,
        encrypt(JSON.stringify({ accessKey, secretKey })), !!i.acceptSameBucket,
        test ? Date.now() : null, test ? JSON.stringify(test) : null, row.id]);
    const next = (await getTarget(row.id))!;
    if (next.active) await applyRow(next);
    return { target: view(next), test };
  });

  app.post('/api/storage/spool/reingest', async (req, reply) => {
    if (guard(req, reply)) return;
    const r = await reingestSpool();
    if (!r) return reply.code(400).send({ error: 'No spool storage is set up (Settings → Storage).' });
    return r;
  });

  /** First-run: the admin does not exist yet, so the wizard may test (not save) a config while the database is empty. */
  app.post('/api/setup/storage-test', async (req, reply) => {
    if (!(await databaseIsEmpty())) return reply.code(403).send({ error: 'already set up' });
    const i = parse((req.body ?? {}) as any);
    if (typeof i === 'string') return reply.code(400).send({ error: i });
    if (!i.accessKey || !i.secretKey) return reply.code(400).send({ error: 'access key and secret key are required' });
    return testTarget(cfgOf(i, i.accessKey, i.secretKey), { prefix: i.prefix });
  });
}

const overridden = (role: Role) => (role === 'mail' ? config.s3FromEnv : role === 'backup' ? config.s3FromEnv || backupEnvSet() : false);

/** Make a saved row live — unless the environment names the bucket (the operator wins). */
async function applyRow(row: TargetRow): Promise<void> {
  if (overridden(row.role)) return;
  if (row.role === 'mail') { const c = toS3Config(row); setMailStore(c); await saveMailStoreConfig(c); }
  else if (row.role === 'backup') setBackupStore(toS3Config(row));
}

/** Storage migrations (F-27). Admin only. */
export function registerMigrations(app: FastifyInstance): void {
  const guard = (req: any, reply: any) => (isAdmin(req) ? false : (reply.code(403).send({ error: 'admin only' }), true));
  const id = (req: any) => Number(req.params.id);

  app.get('/api/storage/migrations', async (req, reply) => {
    if (guard(req, reply)) return;
    return { migrations: (await listMigrations()).map(migrationView) };
  });

  app.get('/api/storage/migrations/plan', async (req, reply) => {
    if (guard(req, reply)) return;
    const role = String((req.query as any).role ?? 'mail');
    if (role !== 'mail' && role !== 'backup') return reply.code(400).send({ error: 'role must be mail or backup' });
    return planSummary(role);
  });

  app.post('/api/storage/migrations', async (req, reply) => {
    if (guard(req, reply)) return;
    const b = (req.body ?? {}) as any;
    if (b.role !== 'mail' && b.role !== 'backup') return reply.code(400).send({ error: 'role must be mail or backup' });
    const r = await startMigration({ role: b.role, toTargetId: Number(b.toTargetId), mode: b.mode, userId: (req as any).sessionUser?.id });
    if ('error' in r) return reply.code(400).send(r);
    return r;
  });

  app.get('/api/storage/migrations/:id', async (req, reply) => {
    if (guard(req, reply)) return;
    const m = await getMigration(id(req));
    if (!m) return reply.code(404).send({ error: 'not found' });
    return { ...migrationView(m), failures: await failedItems(m.id) };
  });

  const act = (path: string, fn: (mid: number, req: any) => Promise<any>) =>
    app.post(`/api/storage/migrations/:id/${path}`, async (req, reply) => {
      if (guard(req, reply)) return;
      if (!(await getMigration(id(req)))) return reply.code(404).send({ error: 'not found' });
      const r = await fn(id(req), req);
      if (r && r.error) return reply.code(400).send(r);
      if (r === false) return reply.code(400).send({ error: 'not possible in this state' });
      return r === true ? { ok: true } : r;
    });
  act('retry', (mid) => retryMigration(mid));
  act('cancel', (mid) => cancelMigration(mid));
  act('rollback', (mid, req) => startRollback(mid, req.sessionUser?.id));
  act('cleanup', (mid, req) => cleanupSource(mid, String(req.body?.bucket ?? '')));
}
