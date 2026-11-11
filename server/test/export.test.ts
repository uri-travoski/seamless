import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { blobStore, resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { makeApp, login, resetLimiters } from './app.ts';
import { q, one, run, insertId, migrate, pool } from '../src/db.ts';
import { config } from '../src/config.ts';
import { encrypt, decryptWith, decrypt, keyFromSecret } from '../src/crypto.ts';
import { setMailStore } from '../src/s3.ts';
import { createExport, importExport, ExportError } from '../src/backup/export.ts';
import { queryFnOf } from '../src/backup/engine.ts';

const PW = 'correct horse battery';
const OTHER_SECRET = 'a-completely-different-secret';
const SCRATCH = 'seamless_scratch_import';

let scratch: pg.Pool | undefined;

async function freshScratch(): Promise<pg.Pool> {
  if (scratch) await scratch.end();
  await pool.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await pool.query(`CREATE DATABASE ${SCRATCH}`);
  const url = new URL(config.databaseUrl);
  url.pathname = `/${SCRATCH}`;
  scratch = new pg.Pool({ connectionString: url.toString(), max: 3 });
  scratch.on('error', () => {});
  await migrate(scratch);
  return scratch;
}

afterAll(async () => {
  if (scratch) await scratch.end();
  await pool.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
});

beforeEach(async () => {
  await migrate();
  await resetDb();
  blobStore.clear();
  setMailStore({ ...config.s3 });
});

async function seed() {
  const accountId = await makeAccount('alice@demo.test');
  const inbox = await makeMailbox(accountId, 'INBOX', 'inbox');
  for (let i = 0; i < 3; i++) await ingest(accountId, inbox, rawEmail({ from: `s${i}@shop.test`, to: 'alice@demo.test', subject: `Invoice ${i}` }));
  const labelId = await insertId('INSERT INTO labels(user_id, name, color, description, sort) VALUES (?,?,?,?,?)', [TEST_USER, 'Receipts', '#2f8ed8', 'r', 0]);
  await run('INSERT INTO rules(user_id, enabled, ord, match_field, match_value, action, label_id, stop, note, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [TEST_USER, true, 1, 'from_domain', 'shop.test', 'label', labelId, true, '', 'manual', Date.now()]);
  await run('INSERT INTO filters(user_id, name, conditions, actions) VALUES (?,?,?,?)', [TEST_USER, 'Newsletters', '[]', '[]']);
  await run('INSERT INTO templates(user_id, name, body_html, created_at, updated_at) VALUES (?,?,?,?,?)', [TEST_USER, 'Thanks', '<p>Thanks</p>', 1, 1]);
  await run('INSERT INTO transports(user_id, kind, name, config_enc, created_at) VALUES (?,?,?,?,?)',
    [TEST_USER, 'smtp', 'Relay', encrypt(JSON.stringify({ host: 'smtp.example', pass: 'hunter2' })), 1]);
  await run("INSERT INTO user_settings(user_id, key, value) VALUES (?, 'theme', 'dark')", [TEST_USER]);
  return { accountId, labelId };
}

async function counts(db: pg.Pool): Promise<Record<string, number>> {
  const dbq = queryFnOf(db);
  const tables = await dbq("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
  const out: Record<string, number> = {};
  for (const t of tables) out[t.table_name] = Number((await dbq(`SELECT COUNT(*) c FROM "${t.table_name}"`))[0].c);
  return out;
}

describe('portable export / import', () => {
  it('full import into an empty database restores every table and re-encrypts secrets for a different SEAMLESS_SECRET', async () => {
    await seed();
    const { file, manifest } = await createExport({ password: PW, appVersion: 'test' });
    expect(file.subarray(0, 18).toString()).toBe('SEAMLESS-EXPORT v1');
    expect(file.includes(Buffer.from('hunter2'))).toBe(false);
    expect(manifest.rows).toBeGreaterThan(0);

    const db = await freshScratch();
    const report = await importExport(file, PW, { mode: 'full', db, secret: OTHER_SECRET });
    expect(report.rows).toBe(manifest.rows);

    const live = await counts(pool);
    const imported = await counts(db);
    for (const [t, n] of Object.entries(live)) if (t !== 'schema_migrations') expect(imported[t], t).toBe(n);

    const row = (await queryFnOf(db)('SELECT imap_pass_enc FROM accounts'))[0];
    expect(decryptWith(keyFromSecret(OTHER_SECRET), row.imap_pass_enc)).toBe('pw');
    expect(() => decrypt(row.imap_pass_enc)).toThrow();   // no longer readable with the original secret
    const tr = (await queryFnOf(db)('SELECT config_enc FROM transports'))[0];
    expect(JSON.parse(decryptWith(keyFromSecret(OTHER_SECRET), tr.config_enc)).pass).toBe('hunter2');
  });

  it('wrong password gives a clear error and writes nothing', async () => {
    await seed();
    const { file } = await createExport({ password: PW });
    const db = await freshScratch();
    await expect(importExport(file, 'not the password!!', { mode: 'full', db })).rejects.toThrow(/wrong password/);
    expect((await counts(db)).users).toBe(0);
    // a damaged file is rejected the same way
    const bad = Buffer.from(file); bad[bad.length - 5] ^= 0xff;
    await expect(importExport(bad, PW, { mode: 'full', db })).rejects.toBeInstanceOf(ExportError);
    await expect(importExport(Buffer.from('hello'), PW, { mode: 'full', db })).rejects.toThrow(/not a Seamless export/);
    expect((await counts(db)).users).toBe(0);
  });

  it('refuses a full import into a database that already has users', async () => {
    await seed();
    const { file } = await createExport({ password: PW });
    const db = await freshScratch();
    await importExport(file, PW, { mode: 'full', db });
    await expect(importExport(file, PW, { mode: 'full', db })).rejects.toThrow(/empty database/);
  });

  it('requires a password of at least 12 characters', async () => {
    await expect(createExport({ password: 'short' })).rejects.toThrow(/at least 12/);
  });

  it('includeMail carries the .eml blobs and hands them to the importer', async () => {
    await seed();
    const { file, manifest } = await createExport({ password: PW, includeMail: true });
    expect(manifest.blobs).toBe(3);
    const got = new Map<string, Buffer>();
    const db = await freshScratch();
    const rep = await importExport(file, PW, { mode: 'full', db, putMailBlob: async (k, b) => { got.set(k, b); } });
    expect(rep.blobsWritten).toBe(3);
    const keys = (await queryFnOf(db)('SELECT s3_key FROM messages')).map((r: any) => r.s3_key);
    for (const k of keys) expect(got.get(k)?.equals(blobStore.get(k)!)).toBe(true);
  });

  it('settings mode merges into the current user, skips duplicates by name, and never touches other users', async () => {
    await seed();
    const { file } = await createExport({ password: PW });
    const bob = await makeUser('bob@demo.test');
    const carol = await makeUser('carol@demo.test');
    const aliceBefore = await one<any>('SELECT (SELECT COUNT(*) FROM labels WHERE user_id = ?) l, (SELECT COUNT(*) FROM rules WHERE user_id = ?) r', [TEST_USER, TEST_USER]);

    const first = await importExport(file, PW, { mode: 'settings', userId: bob });
    expect(first.added).toMatchObject({ labels: 1, rules: 1, filters: 1, templates: 1, transports: 1, settings: 1 });
    expect(first.skipped ?? {}).toEqual({});
    const tr = await one<any>('SELECT config_enc FROM transports WHERE user_id = ?', [bob]);
    expect(JSON.parse(decrypt(tr.config_enc)).pass).toBe('hunter2');   // usable with the local secret

    const second = await importExport(file, PW, { mode: 'settings', userId: bob });
    expect(second.added ?? {}).toEqual({});
    expect(second.skipped).toMatchObject({ labels: 1, rules: 1, filters: 1, templates: 1, transports: 1, settings: 1 });
    expect((await one<any>('SELECT COUNT(*)::int c FROM labels WHERE user_id = ?', [bob])).c).toBe(1);
    expect((await one<any>('SELECT COUNT(*)::int c FROM rules WHERE user_id = ?', [bob])).c).toBe(1);

    // isolation: alice unchanged, carol has nothing, and no mail came across
    const aliceAfter = await one<any>('SELECT (SELECT COUNT(*) FROM labels WHERE user_id = ?) l, (SELECT COUNT(*) FROM rules WHERE user_id = ?) r', [TEST_USER, TEST_USER]);
    expect(aliceAfter).toEqual(aliceBefore);
    expect((await one<any>('SELECT COUNT(*)::int c FROM labels WHERE user_id = ?', [carol])).c).toBe(0);
    expect((await one<any>('SELECT COUNT(*)::int c FROM accounts WHERE user_id = ?', [bob])).c).toBe(0);
  });
});

describe('export routes', () => {
  beforeEach(() => resetLimiters());

  it('admin downloads an export; a member cannot; short passwords are rejected; an event is raised', async () => {
    await seed();
    await makeUser('bob@demo.test');
    const app = await makeApp();
    const admin = await login(app);
    const bad = await app.inject({ method: 'POST', url: '/api/export', headers: { cookie: admin }, payload: { password: 'short' } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/export', headers: { cookie: admin }, payload: { password: PW } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-disposition']).toMatch(/\.seamless-export/);
    expect(ok.rawPayload.subarray(0, 18).toString()).toBe('SEAMLESS-EXPORT v1');
    expect((await one<any>("SELECT COUNT(*)::int c FROM events WHERE type = 'export.created'")).c).toBe(1);

    const member = await login(app, 'bob@demo.test');
    const no = await app.inject({ method: 'POST', url: '/api/export', headers: { cookie: member }, payload: { password: PW } });
    expect(no.statusCode).toBe(403);
    const anon = await app.inject({ method: 'POST', url: '/api/export', payload: { password: PW } });
    expect(anon.statusCode).toBe(401);
  });

  it('import: full is refused once a user exists; settings mode is admin-only and merges', async () => {
    await seed();
    const bob = await makeUser('bob@demo.test');
    const app = await makeApp();
    const admin = await login(app);
    const file = (await app.inject({ method: 'POST', url: '/api/export', headers: { cookie: admin }, payload: { password: PW } })).rawPayload;
    const hdr = (cookie?: string, pw = PW) => ({ 'content-type': 'application/octet-stream', 'x-export-password': pw, ...(cookie ? { cookie } : {}) });

    expect((await app.inject({ method: 'POST', url: '/api/import?mode=full', headers: hdr(), payload: file })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/import?mode=settings', headers: hdr(), payload: file })).statusCode).toBe(403);
    const member = await login(app, 'bob@demo.test');
    expect((await app.inject({ method: 'POST', url: '/api/import?mode=settings', headers: hdr(member), payload: file })).statusCode).toBe(403);

    const wrong = await app.inject({ method: 'POST', url: '/api/import?mode=settings', headers: hdr(admin, 'wrong password here'), payload: file });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toMatch(/wrong password/);

    await run('DELETE FROM labels WHERE user_id = ?', [TEST_USER]);
    const ok = await app.inject({ method: 'POST', url: '/api/import?mode=settings', headers: hdr(admin), payload: file });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().added.labels).toBe(1);
    expect((await one<any>('SELECT COUNT(*)::int c FROM labels WHERE user_id = ?', [bob])).c).toBe(0);
    expect((await one<any>("SELECT COUNT(*)::int c FROM events WHERE type = 'export.imported'")).c).toBe(1);
  });
});
