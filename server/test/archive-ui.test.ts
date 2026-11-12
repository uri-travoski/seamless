/** T8.5: the pieces behind the archive screens — preview for every dropdown value, monthly rule, notifications, cross-archive search, health. */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, blobStore, TEST_USER } from './helpers.ts';
import { q, one, run } from '../src/db.ts';
import { makeApp, login, resetLimiters } from './app.ts';
import { insertTarget } from '../src/storage/targets.ts';
import { runDueJobs } from '../src/jobs/runner.ts';
import type { BlobStore } from '../src/s3.ts';
import { DAY_MS } from '../src/archive/select.ts';
import { setArchiveStoreFactory } from '../src/archive/run.ts';
import { getSchedule, saveSchedule, runDueSchedules } from '../src/archive/schedule.ts';
import { healthReport } from '../src/health/status.ts';

let objects: Map<string, Buffer>;
const store = (): BlobStore => ({
  put: async (k, b) => { objects.set(k, b); },
  get: async (k) => { const b = objects.get(k); if (!b) throw new Error(`no blob ${k}`); return b; },
  list: async (p) => [...objects.keys()].filter((k) => k.startsWith(p)).sort(),
  del: async (k) => { objects.delete(k); },
});
const NOW = Date.now();
const ago = (d: number) => new Date(NOW - d * DAY_MS).toUTCString();
let acct: number, inbox: number, targetId: number;
const mail = (subject: string, days: number) => ingest(acct, inbox, rawEmail({ from: 'shop@old.test', to: 'alice@demo.test', subject, date: ago(days), body: `body ${subject}` }), { flags: ['\\Seen'] });

async function client(email = 'test@local') {
  const app = await makeApp(); const cookie = await login(app, email);
  return (method: any, url: string, payload?: any) => app.inject({ method, url, payload, headers: { cookie } });
}

beforeEach(async () => {
  await resetDb(); resetLimiters(); blobStore.clear(); objects = new Map();
  setArchiveStoreFactory(async () => store());
  acct = await makeAccount('alice@demo.test');
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  targetId = await insertTarget({ role: 'backup', provider: 'minio', endpoint: 'http://localhost:9100', region: 'us-east-1', bucket: 'seamless-test-archive', accessKey: 'k', secretKey: 's', forcePathStyle: true }, true, null);
});

describe('preview endpoint (the dropdown 1…10 years and Other…)', () => {
  it('answers for every dropdown value and for months / years from the Other… box', async () => {
    for (const y of [1, 4, 8]) await mail(`${y}y old`, y * 365 + 10);
    await mail('Recent', 20);
    const call = await client();
    const counts: number[] = [];
    for (let y = 1; y <= 10; y++) {
      const r = (await call('GET', `/api/archives/preview?olderThanYears=${y}`)).json();
      expect(r.olderThanDays).toBe(y * 365);
      counts.push(r.count);
    }
    expect(counts).toEqual([3, 2, 2, 2, 1, 1, 1, 1, 0, 0]);
    expect((await call('GET', '/api/archives/preview?olderThanMonths=6')).json()).toMatchObject({ count: 3, olderThanDays: 180 });
    expect((await call('GET', '/api/archives/preview?olderThanMonths=18')).json().count).toBe(2);
    const wide = (await call('GET', '/api/archives/preview?olderThanYears=1')).json();
    expect(wide.bytes).toBeGreaterThan(0);
    expect(wide.oldest).toBeLessThan(wide.newest + 1);
    expect((await call('GET', '/api/archives/preview?olderThanYears=0')).statusCode).toBe(400);
    expect((await call('GET', '/api/archives/preview')).statusCode).toBe(400);
  });
});

describe('targets list', () => {
  it('lists backup targets only, with no credentials, for any signed-in user', async () => {
    await insertTarget({ role: 'spool', provider: 'minio', endpoint: 'http://localhost:9100', region: 'us-east-1', bucket: 'seamless-test-spool', accessKey: 'k', secretKey: 's', forcePathStyle: true }, true, null);
    const bId = await makeUser('bob@demo.test'); await makeAccount('bob@demo.test', { userId: bId });
    const r = (await (await client('bob@demo.test'))('GET', '/api/archives/targets')).json();
    expect(r.targets).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/secret|access|creds|"k"/i);
  });
});

describe('monthly rule', () => {
  it('saves, validates and plans one archive per month; disabled rules do nothing', async () => {
    await mail('Ancient', 1500);
    const call = await client();
    expect((await call('GET', '/api/archives/schedule')).json().schedule).toMatchObject({ enabled: false, olderThanDays: 1095 });
    expect((await call('PUT', '/api/archives/schedule', { enabled: true, olderThanDays: 365 })).statusCode).toBe(400);   // no target
    expect((await call('PUT', '/api/archives/schedule', { enabled: true, olderThanDays: 0, targetId })).statusCode).toBe(400);
    expect((await call('PUT', '/api/archives/schedule', { enabled: true, olderThanDays: 365, targetId, scope: 'account:99999' })).statusCode).toBe(404);
    const saved = (await call('PUT', '/api/archives/schedule', { enabled: true, olderThanDays: 365, targetId, mode: 'copy', options: { includeStarred: true } })).json().schedule;
    expect(saved).toMatchObject({ enabled: true, olderThanDays: 365, mode: 'copy', targetId, options: { includeStarred: true } });
    expect(saved.nextDueAt).toBeGreaterThan(Date.now());

    expect(await runDueSchedules(Date.now())).toEqual([]);                       // not due yet
    const later = Date.now() + 31 * DAY_MS;
    const made = await runDueSchedules(later);
    expect(made).toHaveLength(1);
    expect(await runDueSchedules(later)).toEqual([]);                            // claimed: no second archive the same month
    const a = await one<any>('SELECT * FROM mail_archives WHERE id = ?', [made[0]]);
    expect(a).toMatchObject({ user_id: TEST_USER, message_count: 1, mode: 'copy' });
    expect(a.name).toMatch(/^Monthly archive \d{4}-\d{2}$/);
    expect((await getSchedule(TEST_USER)).lastArchiveId).toBe(made[0]);
    expect(await runDueSchedules(later + 31 * DAY_MS)).toHaveLength(1);          // next month it runs again

    await saveSchedule(TEST_USER, { enabled: false });
    expect(await runDueSchedules(later + 90 * DAY_MS)).toEqual([]);
  });

  it('switches itself off and says so when the storage target has gone', async () => {
    await saveSchedule(TEST_USER, { enabled: true, olderThanDays: 365, targetId });
    await run('DELETE FROM storage_targets WHERE id = ?', [targetId]);
    expect(await runDueSchedules(Date.now() + 40 * DAY_MS)).toEqual([]);
    expect((await getSchedule(TEST_USER)).enabled).toBe(false);
    const n = await q<any>("SELECT title, body FROM notifications WHERE type = 'archive.failed'");
    expect(n).toHaveLength(1);
    expect(n[0].body).toMatch(/switched off/);
  });

  it("user B can't read or change A's rule, and the job runs rules for each user separately", async () => {
    await saveSchedule(TEST_USER, { enabled: true, olderThanDays: 365, targetId });
    const bId = await makeUser('bob@demo.test'); await makeAccount('bob@demo.test', { userId: bId });
    const call = await client('bob@demo.test');
    expect((await call('GET', '/api/archives/schedule')).json().schedule).toMatchObject({ enabled: false, targetId: null });
    await call('PUT', '/api/archives/schedule', { enabled: false, olderThanDays: 730 });
    expect(await getSchedule(TEST_USER)).toMatchObject({ enabled: true, olderThanDays: 365 });
    expect(await getSchedule(bId)).toMatchObject({ enabled: false, olderThanDays: 730 });
  });
});

describe('notifications, health and archive search', () => {
  it('a finished archive raises one notification; a running one shows on Health', async () => {
    await mail('Ancient', 1500);
    const call = await client();
    const id = (await call('POST', '/api/archives', { olderThanYears: 1, mode: 'copy', targetId, name: 'Old mail' })).json().id;
    expect((await healthReport(TEST_USER, false)).archives).toEqual([expect.objectContaining({ id, name: 'Old mail', status: 'planned' })]);
    await runDueJobs();
    expect((await healthReport(TEST_USER, false)).archives).toEqual([]);
    const n = await q<any>("SELECT type, title, body, link FROM notifications WHERE type = 'archive.done'");
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ title: 'Archive "Old mail" is finished', link: '/settings/backup' });
    expect(n[0].body).toMatch(/1 message copied/);
  });

  it('a failed archive raises a failure notification', async () => {
    await mail('Ancient', 1500);
    const call = await client();
    const id = (await call('POST', '/api/archives', { olderThanYears: 1, mode: 'copy', targetId, name: 'Broken' })).json().id;
    await run('DELETE FROM storage_targets WHERE id = ?', [targetId]);
    setArchiveStoreFactory(null);
    await runDueJobs();
    expect((await call('GET', `/api/archives/${id}`)).json().status).toBe('failed');
    expect(await q("SELECT 1 FROM notifications WHERE type = 'archive.failed'")).toHaveLength(1);
  });

  it('searches every finished archive for the "older mail may be in an archive" hint, only for the owner', async () => {
    await mail('Tax return 2019', 2000); await mail('Holiday photos', 900);
    const call = await client();
    await call('POST', '/api/archives', { olderThanYears: 1, mode: 'copy', targetId, name: 'One' });
    await runDueJobs();
    const r = (await call('GET', '/api/archives/search?q=tax')).json();
    expect(r).toMatchObject({ archives: 1, total: 1 });
    expect(r.results[0]).toMatchObject({ subject: 'Tax return 2019', archiveName: 'One' });
    expect((await call('GET', '/api/archives/search?q=nothing-like-it')).json()).toMatchObject({ total: 0, results: [] });
    const bId = await makeUser('bob@demo.test'); await makeAccount('bob@demo.test', { userId: bId });
    expect((await (await client('bob@demo.test'))('GET', '/api/archives/search?q=tax')).json()).toMatchObject({ archives: 0, total: 0 });
  });
});
