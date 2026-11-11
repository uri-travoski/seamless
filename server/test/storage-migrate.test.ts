import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, rawEmail, ingest, blobStore } from './helpers.ts';

const { one, q, run } = await import('../src/db.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');
const { insertTarget, getTarget } = await import('../src/storage/targets.ts');
const m = await import('../src/storage/migrate.ts');
const s3 = await import('../src/s3.ts');
const real = await vi.importActual<typeof import('../src/s3.ts')>('../src/s3.ts');

const base = { endpoint: 'http://localhost:9100', region: 'us-east-1', accessKey: 'seamless', secretKey: 'seamless-secret', forcePathStyle: true };
const A = real.makeStore({ ...base, bucket: 'seamless-test-mig-a' });
const B = real.makeStore({ ...base, bucket: 'seamless-test-mig-b' });
const N = 200;

async function emptyBucket(st: typeof A) { for (const k of await st.list('')) await st.del(k); }

let accountId: number, mailboxId: number;
let targetB: number;

/** Ingest into the (in-memory) mail store, then mirror each blob into MinIO bucket A, which plays "the current storage". */
async function addMessage(subject: string) {
  const r = await ingest(accountId, mailboxId, rawEmail({ from: 'a@demo.test', to: 'test@local', subject }));
  const key = (await one<{ s3_key: string }>('SELECT s3_key FROM messages WHERE id = ?', [r!.rowId]))!.s3_key;
  await A.put(key, blobStore.get(key)!);
  return key;
}

/** Drive the state machine until it stops changing; returns the final status and the list of states seen. */
async function drive(id: number, deps: any, until: string[] = ['completed', 'failed', 'failed_verify', 'cancelled'], max = 200) {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    const s = await m.stepMigration(id, deps);
    if (seen[seen.length - 1] !== s) seen.push(s);
    if (until.includes(s)) return { status: s, seen };
  }
  throw new Error('migration did not settle: ' + seen.join(','));
}

beforeEach(async () => {
  await resetDb(); await run('DELETE FROM storage_migrations'); resetLimiters();
  blobStore.clear();
  await A.ensure(); await B.ensure(); await emptyBucket(A); await emptyBucket(B);
  accountId = await makeAccount('t@demo.test');
  mailboxId = await makeMailbox(accountId, 'INBOX', 'inbox');
  targetB = await insertTarget({ role: 'mail', provider: 'minio', ...base, bucket: 'seamless-test-mig-b', accessKey: base.accessKey, secretKey: base.secretKey }, false, null);
  s3.setMailStore({ ...base, bucket: 'seamless-test-mig-a' });
  for (let i = 0; i < N; i++) await addMessage(`msg ${i}`);
}, 120_000);

const start = async (mode: 'sample' | 'strict' = 'sample') => {
  const r = await m.startMigration({ role: 'mail', toTargetId: targetB, mode });
  if ('error' in r) throw new Error(r.error);
  return r.id;
};

describe('storage migration', () => {
  it('copies, verifies and switches; a message reads from the new bucket and the old one is untouched', async () => {
    const id = await start();
    const { status, seen } = await drive(id, { src: A, dst: B });
    expect(status).toBe('completed');
    expect(seen).toEqual(['copying', 'verifying', 'switching', 'completed']);
    const keys = (await q<{ s3_key: string }>('SELECT s3_key FROM messages')).map((r) => r.s3_key);
    expect(keys.length).toBe(N);
    for (const k of keys.slice(0, 20)) expect((await B.get(k)).equals(await A.get(k))).toBe(true);
    expect((await A.list('')).length).toBe(N);                      // nothing deletes the source
    expect(s3.mailStoreConfig().bucket).toBe('seamless-test-mig-b');
    expect((await getTarget(targetB))!.active).toBe(true);
    const row = (await m.getMigration(id))!;
    expect(row.total_items).toBe(N); expect(row.verified_items).toBe(N);
    expect(Number(row.retain_until)).toBeGreaterThan(Date.now() + 13 * 24 * 3600_000);
    expect(Number((await one<{ c: string }>("SELECT COUNT(*) AS c FROM events WHERE type = 'storage.migration.done'"))!.c)).toBe(1);
  }, 120_000);

  it('one batch then a restart resumes without re-copying', async () => {
    const id = await start();
    let gets = 0;
    const src = { ...A, get: async (k: string) => { gets++; return A.get(k); }, list: A.list, put: A.put, del: A.del } as any;
    await m.stepMigration(id, { src, dst: B, batch: 60 });                    // planning
    await m.stepMigration(id, { src, dst: B, batch: 60 });                    // first batch of 60
    expect((await m.getMigration(id))!.copied_items).toBe(60);
    expect(gets).toBe(60);
    const { status } = await drive(id, { src, dst: B, batch: 60 });            // "after restart": only the table state remains
    expect(status).toBe('completed');
    // sample verification re-reads the source only for non-.eml keys; every message was fetched from the source exactly once
    expect(gets).toBe(N);
    expect(await q("SELECT 1 FROM storage_migration_items WHERE migration_id = ? AND status = 'verified'", [id])).toHaveLength(N);
  }, 120_000);

  it('a corrupted object in the new bucket → failed_verify, nothing switched; retry repairs it', async () => {
    const id = await start('strict');
    await drive(id, { src: A, dst: B }, ['verifying']);
    const victim = (await q<{ s3_key: string }>('SELECT s3_key FROM messages LIMIT 1'))[0].s3_key;
    await B.put(victim, Buffer.from('garbage'));
    const { status } = await drive(id, { src: A, dst: B });
    expect(status).toBe('failed_verify');
    expect(s3.mailStoreConfig().bucket).toBe('seamless-test-mig-a');
    expect((await getTarget(targetB))!.active).toBe(false);
    expect((await m.failedItems(id)).map((f) => f.key)).toContain(victim);
    expect((await m.getMigration(id))!.error).toMatch(/Nothing was switched/);
    expect(await m.retryMigration(id)).toBe(true);
    expect((await drive(id, { src: A, dst: B })).status).toBe('completed');
    expect((await B.get(victim)).equals(await A.get(victim))).toBe(true);
  }, 120_000);

  it('mail that arrives during the copy is included', async () => {
    const id = await start();
    await drive(id, { src: A, dst: B }, ['verifying']);
    const late = await addMessage('arrived mid-migration');
    expect((await drive(id, { src: A, dst: B })).status).toBe('completed');
    expect((await B.get(late)).length).toBeGreaterThan(0);
    expect((await m.getMigration(id))!.total_items).toBe(N + 1);
  }, 120_000);

  it('rollback copies what was written since the switch back and switches back', async () => {
    const id = await start();
    await drive(id, { src: A, dst: B });
    // new mail after the switch lands in B only
    const r = await ingest(accountId, mailboxId, rawEmail({ from: 'a@demo.test', to: 'test@local', subject: 'after switch' }));
    const after = (await one<{ s3_key: string }>('SELECT s3_key FROM messages WHERE id = ?', [r!.rowId]))!.s3_key;
    await B.put(after, blobStore.get(after)!);
    const rb = await m.startRollback(id);
    if ('error' in rb) throw new Error(rb.error);
    expect((await drive(rb.id, { src: B, dst: A })).status).toBe('completed');
    expect((await m.getMigration(rb.id))!.total_items).toBe(1);                 // only the delta
    expect((await A.get(after)).length).toBeGreaterThan(0);
    expect(s3.mailStoreConfig().bucket).toBe('seamless-test-mig-a');
    expect((await m.getMigration(id))!.status).toBe('rolled_back');
    expect((await getTarget(targetB))!.active).toBe(false);
  }, 120_000);

  it('cleanup needs the retention window to be over and the bucket name typed', async () => {
    const id = await start();
    await drive(id, { src: A, dst: B });
    expect(await m.cleanupSource(id, 'seamless-test-mig-a', { src: A })).toMatchObject({ error: expect.stringMatching(/kept until/) });
    await run('UPDATE storage_migrations SET retain_until = ? WHERE id = ?', [Date.now() - 1000, id]);
    expect(await m.cleanupSource(id, 'wrong', { src: A })).toMatchObject({ error: expect.stringMatching(/exactly/) });
    expect((await A.list('')).length).toBe(N);
    const ok = await m.cleanupSource(id, 'seamless-test-mig-a', { src: A });
    expect(ok).toEqual({ ok: true, deleted: N });
    expect((await A.list('')).length).toBe(0);
    expect((await B.list('')).length).toBe(N);
    expect(await m.cleanupSource(id, 'seamless-test-mig-a', { src: A })).toMatchObject({ error: 'Already cleaned up.' });
  }, 120_000);

  it('refuses the bucket in use and a second concurrent migration; cancel stops without switching', async () => {
    const same = await insertTarget({ role: 'mail', provider: 'minio', ...base, bucket: 'seamless-test-mig-a', accessKey: 'x', secretKey: 'y' }, false, null);
    expect(await m.startMigration({ role: 'mail', toTargetId: same })).toMatchObject({ error: expect.stringMatching(/already use/) });
    const id = await start();
    expect(await m.startMigration({ role: 'mail', toTargetId: targetB })).toMatchObject({ error: expect.stringMatching(/already running/) });
    expect(await m.cancelMigration(id)).toBe(true);
    expect(await m.stepMigration(id, { src: A, dst: B })).toBe('cancelled');
    expect(s3.mailStoreConfig().bucket).toBe('seamless-test-mig-a');
  }, 120_000);

  it('the job handler runs a batch and re-enqueues itself', async () => {
    const id = await start();
    const { runDueJobs } = await import('../src/jobs/runner.ts');
    await runDueJobs();                                           // planning → copying (real stores: cfg decoded from the row)
    expect((await m.getMigration(id))!.status).toBe('copying');
    expect(Number((await one<{ c: string }>("SELECT COUNT(*) AS c FROM jobs WHERE kind = 'storage.migrate' AND status = 'pending'"))!.c)).toBe(1);
  });
});

describe('storage migration routes', () => {
  it('members get 403, admins can read the plan and start', async () => {
    const app = await makeApp();
    const cookie = await login(app);
    await makeUser('member@demo.test', 'member');
    resetLimiters();
    const mc = await login(app, 'member@demo.test');
    for (const [method, url] of [['GET', '/api/storage/migrations'], ['GET', '/api/storage/migrations/plan'], ['POST', '/api/storage/migrations'], ['GET', '/api/storage/migrations/1'], ['POST', '/api/storage/migrations/1/retry'], ['POST', '/api/storage/migrations/1/rollback'], ['POST', '/api/storage/migrations/1/cleanup']] as const) {
      expect((await app.inject({ method, url, headers: { cookie: mc }, payload: {} })).statusCode, `${method} ${url}`).toBe(403);
    }
    const plan = (await app.inject({ method: 'GET', url: '/api/storage/migrations/plan?role=mail', headers: { cookie } })).json();
    expect(plan.objects).toBe(N);
    const r = await app.inject({ method: 'POST', url: '/api/storage/migrations', headers: { cookie }, payload: { role: 'mail', toTargetId: targetB } });
    expect(r.statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/api/storage/migrations', headers: { cookie } })).json();
    expect(list.migrations[0].status).toBe('planning');
    expect(JSON.stringify(list)).not.toMatch(/secret|_enc/i);
  }, 120_000);
});
