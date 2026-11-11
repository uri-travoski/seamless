import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeUser } from './helpers.ts';

const { one, run } = await import('../src/db.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');
const { testTarget, view, insertTarget, getTarget } = await import('../src/storage/targets.ts');
const { initMailStore } = await import('../src/backup/mailref.ts');
const { config } = await import('../src/config.ts');
const s3 = await import('../src/s3.ts');
const real = await vi.importActual<typeof import('../src/s3.ts')>('../src/s3.ts');

const A = 'seamless-test-st-a';
const good = { endpoint: 'http://localhost:9100', region: 'us-east-1', bucket: A, accessKey: 'seamless', secretKey: 'seamless-secret', forcePathStyle: true };
const minio = () => real.makeStore(good);
const body = (extra: any = {}) => ({ role: 'mail', provider: 'minio', ...good, ...extra });

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;

beforeEach(async () => {
  await resetDb(); await run('DELETE FROM storage_targets'); resetLimiters();
  app = await makeApp();
  cookie = await login(app);
  await minio().ensure();
});

describe('testTarget against MinIO', () => {
  it('good credentials pass every step', async () => {
    const r = await testTarget(good, { store: minio() });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.id)).toEqual(['reach', 'auth', 'write', 'read', 'list', 'delete', 'latency']);
    expect(r.steps.every((s) => s.status === 'ok')).toBe(true);
  });

  it('a wrong secret fails at auth and later steps are skipped', async () => {
    const cfg = { ...good, secretKey: 'nope' };
    const r = await testTarget(cfg, { store: real.makeStore(cfg) });
    expect(r.ok).toBe(false);
    const by = Object.fromEntries(r.steps.map((s) => [s.id, s.status]));
    expect(by.reach).toBe('ok');
    expect(by.auth).toBe('fail');
    expect(by.write).toBe('skipped');
  });

  it('an unreachable endpoint fails at the first step', async () => {
    const cfg = { ...good, endpoint: 'http://127.0.0.1:1' };
    const r = await testTarget(cfg, { store: real.makeStore(cfg), timeoutMs: 2000 });
    expect(r.steps[0].status).toBe('fail');
    expect(r.ok).toBe(false);
  });

  it('write-only credentials fail at read', async () => {
    const m = new Map<string, Buffer>();
    const store = {
      headBucket: async () => {}, put: async (k: string, b: Buffer) => { m.set(k, b); },
      get: async () => { throw new Error('AccessDenied'); }, list: async () => [...m.keys()], del: async (k: string) => { m.delete(k); },
    };
    const r = await testTarget(good, { store, fetchImpl: (async () => new Response('', { status: 403 })) as any });
    const by = Object.fromEntries(r.steps.map((s) => [s.id, s.status]));
    expect(by.write).toBe('ok'); expect(by.read).toBe('fail'); expect(by.list).toBe('skipped');
    expect(r.ok).toBe(false);
    expect(by.delete).toBe('ok');   // the probe object is still cleaned up
    expect(m.size).toBe(0);
  });

  it('a refused delete only warns', async () => {
    const m = new Map<string, Buffer>();
    const store = {
      headBucket: async () => {}, put: async (k: string, b: Buffer) => { m.set(k, b); },
      get: async (k: string) => m.get(k)!, list: async () => [...m.keys()], del: async () => { throw new Error('AccessDenied'); },
    };
    const r = await testTarget(good, { store, fetchImpl: (async () => new Response('', { status: 200 })) as any });
    expect(r.ok).toBe(true);
    expect(r.warnings).toBe(1);
    expect(r.steps.find((s) => s.id === 'delete')!.status).toBe('warn');
  });
});

describe('API', () => {
  it('creates a target (tested first), never returns credentials, and encrypts them at rest', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/storage/targets', headers: { cookie }, payload: body() });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain('seamless-secret');
    const list = await app.inject({ method: 'GET', url: '/api/storage/targets', headers: { cookie } });
    expect(list.payload).not.toContain('seamless-secret');
    expect(list.json().targets).toHaveLength(1);
    const row = await one<{ creds_enc: string }>('SELECT creds_enc FROM storage_targets');
    expect(row!.creds_enc).not.toContain('seamless-secret');
    expect(JSON.stringify(view((await getTarget(res.json().target.id))!))).not.toContain('seamless-secret');
  });

  it('refuses to save when the test fails', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/storage/targets', headers: { cookie }, payload: body({ endpoint: 'http://127.0.0.1:1' }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().test.ok).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/storage/targets', headers: { cookie } })).json().targets).toHaveLength(0);
  });

  it('requires a separate backup bucket unless the same-bucket risk is accepted', async () => {
    await app.inject({ method: 'POST', url: '/api/storage/targets', headers: { cookie }, payload: body() });
    const same = await app.inject({ method: 'POST', url: '/api/storage/targets', headers: { cookie }, payload: body({ role: 'backup' }) });
    expect(same.statusCode).toBe(400);
    expect(same.json().error).toMatch(/different bucket/);
    const ok = await app.inject({ method: 'POST', url: '/api/storage/targets', headers: { cookie }, payload: body({ role: 'backup', acceptSameBucket: true }) });
    expect(ok.statusCode).toBe(200);
  });

  it('editing keeps stored credentials when left blank and re-tests when the connection changes', async () => {
    const id = (await app.inject({ method: 'POST', url: '/api/storage/targets', headers: { cookie }, payload: body() })).json().target.id;
    const keep = await app.inject({ method: 'PUT', url: `/api/storage/targets/${id}`, headers: { cookie }, payload: { prefix: 'other' } });
    expect(keep.statusCode).toBe(200);
    expect(keep.json().target.prefix).toBe('other/');
    expect(keep.json().test).toBeNull();
    const bad = await app.inject({ method: 'PUT', url: `/api/storage/targets/${id}`, headers: { cookie }, payload: { endpoint: 'http://127.0.0.1:1' } });
    expect(bad.statusCode).toBe(400);
    // the stored secret was not replaced
    const t = await app.inject({ method: 'POST', url: `/api/storage/targets/${id}/test`, headers: { cookie } });
    expect(t.json().ok).toBe(true);
  });

  it('a saved mail target is not switched on when mail is already stored (migration needed)', async () => {
    const { makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } = await import('./helpers.ts');
    void TEST_USER;
    const acc = await makeAccount('me@x.test'); const mb = await makeMailbox(acc, 'INBOX', 'inbox');
    await ingest(acc, mb, rawEmail({ from: 'a@x.test', to: 'me@x.test', subject: 'x' }));
    const res = await app.inject({ method: 'POST', url: '/api/storage/targets', headers: { cookie }, payload: body() });
    expect(res.statusCode).toBe(200);
    expect(res.json().target.active).toBe(false);
    expect(res.json().note).toMatch(/migration/);
  });

  it('usage counts objects and bytes; members get 403 everywhere', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/storage/targets/usage', headers: { cookie } })).json()).toEqual({ objects: 0, bytes: 0 });
    await makeUser('member@demo.test', 'member');
    resetLimiters();
    const mc = await login(app, 'member@demo.test');
    for (const [method, url] of [['GET', '/api/storage/targets'], ['GET', '/api/storage/targets/usage'], ['POST', '/api/storage/targets'], ['POST', '/api/storage/targets/test'], ['POST', '/api/storage/targets/1/test'], ['PUT', '/api/storage/targets/1'], ['POST', '/api/storage/spool/reingest']] as const) {
      const r = await app.inject({ method, url, headers: { cookie: mc }, payload: {} });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe('boot precedence', () => {
  const row = () => insertTarget({ role: 'mail', provider: 'minio', ...good, bucket: 'seamless-test-st-db', prefix: 'seamless/' }, true, null);

  it('an active DB target is used when the environment names no bucket', async () => {
    await row();
    const was = config.s3FromEnv; (config as any).s3FromEnv = false;
    try {
      const r = await initMailStore();
      expect(r).toEqual({ source: 'target', bucket: 'seamless-test-st-db' });
      expect(s3.mailStoreLocation().bucket).toBe('seamless-test-st-db');
    } finally { (config as any).s3FromEnv = was; }
  });

  it('S3_* in the environment wins over the DB target', async () => {
    await row();
    const was = config.s3FromEnv; (config as any).s3FromEnv = true;
    try {
      const r = await initMailStore();
      expect(r.source).toBe('env');
      expect(r.bucket).toBe(config.s3.bucket);
    } finally { (config as any).s3FromEnv = was; }
  });
});

describe('spool re-ingest', () => {
  it('posts each spooled message through ingestLocal and is safe to repeat', async () => {
    const { reingestSpool, tokenFromKey } = await import('../src/storage/spool.ts');
    expect(tokenFromKey('1700000000000-abcDEF123-k3j2h1.eml')).toBe('abcDEF123');
    const { rawEmail } = await import('./helpers.ts');
    const inbox = (await app.inject({ method: 'POST', url: '/api/push-inboxes', headers: { cookie }, payload: { name: 'P', email: 'me@push.test', domains: ['push.test'] } })).json();
    const m = new Map<string, Buffer>([
      [`1-${inbox.token}-aaa.eml`, rawEmail({ from: 'a@x.test', to: 'me@push.test', subject: 'spooled one' })],
      [`2-nosuchtoken-bbb.eml`, rawEmail({ from: 'a@x.test', to: 'me@x.test', subject: 'orphan' })],
    ]);
    const store = { put: async () => {}, get: async (k: string) => m.get(k)!, list: async () => [...m.keys()], del: async () => {} };
    const r1 = await reingestSpool(store, '');
    expect(r1).toMatchObject({ found: 2, ingested: 1, skipped: 1, failed: 0 });
    const r2 = await reingestSpool(store, '');
    expect(r2!.ingested).toBe(0);
    const n = await one<{ c: string }>("SELECT COUNT(*) AS c FROM messages WHERE subject = 'spooled one'");
    expect(Number(n!.c)).toBe(1);
  });
});
