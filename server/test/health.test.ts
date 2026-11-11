import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { resetDb, TEST_USER, makeUser, makeAccount } from './helpers.ts';
import { makeApp, resetLimiters, login } from './app.ts';
import { q, one, run, setSetting } from '../src/db.ts';
import { INTERVAL_HOURS } from '../src/backup/schedule.ts';
import { runHealthAlerts, shouldAlert } from '../src/health/alerts.ts';
import { healthReport, resetStorageProbe } from '../src/health/status.ts';
import { enqueueJob } from '../src/jobs/runner.ts';
import { mailStore } from '../src/s3.ts';

const app = await makeApp();
afterAll(() => app.close());

const H = 3_600_000;
const events = (type: string) => q<any>('SELECT * FROM events WHERE type = ?', [type]);

beforeEach(async () => {
  await resetDb(); resetLimiters(); resetStorageProbe();
  await run("DELETE FROM settings WHERE key LIKE 'backup_%'");
});

describe('F-21 health and alerts', () => {
  it('a stale backup shows red and raises exactly one backup.failed, even if the check runs twice', async () => {
    await setSetting('backup_enabled', 'true');
    await setSetting('backup_frequency', 'daily');
    await setSetting('backup_last_at', String(Date.now() - 3 * INTERVAL_HOURS.daily * H));
    await setSetting('backup_last_status', 'ok');
    const rep = await healthReport(TEST_USER, true);
    expect(rep.backups.status).toBe('red');
    expect(rep.overall).toBe('red');
    await runHealthAlerts();
    await runHealthAlerts();
    expect(await events('backup.failed')).toHaveLength(1);
    await runHealthAlerts(Date.now() + 7 * H);           // after the 6 h quiet period it may speak again
    expect(await events('backup.failed')).toHaveLength(2);
  });

  it('a healthy, recent backup stays green and quiet', async () => {
    await setSetting('backup_enabled', 'true');
    await setSetting('backup_frequency', 'daily');
    await setSetting('backup_last_at', String(Date.now() - 2 * H));
    await setSetting('backup_last_status', 'ok');
    expect((await healthReport(TEST_USER, true)).backups.status).toBe('ok');
    await runHealthAlerts();
    expect(await events('backup.failed')).toHaveLength(0);
  });

  it('unreachable mail storage is red and alerts the admin once', async () => {
    const spy = vi.spyOn(mailStore, 'put').mockRejectedValue(new Error('connection refused'));
    try {
      const rep = await healthReport(TEST_USER, true);
      expect(rep.storage.status).toBe('red');
      expect(rep.storage.error).toMatch(/connection refused/);
      await runHealthAlerts(); await runHealthAlerts();
      expect(await events('storage.unreachable')).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it('suppression helper: once per 6 hours per subject', async () => {
    const t = Date.now();
    expect(await shouldAlert('x', 1, t)).toBe(true);
    expect(await shouldAlert('x', 1, t + H)).toBe(false);
    expect(await shouldAlert('x', 2, t + H)).toBe(true);
    expect(await shouldAlert('x', 1, t + 7 * H)).toBe(true);
  });

  it('/healthz answers without a cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().db).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(401);
  });

  it('a member sees mailboxes, sending and jobs but not storage, backups or system', async () => {
    await makeUser('member@x.test', 'member');
    const cookie = await login(app, 'member@x.test');
    const rep = (await app.inject({ method: 'GET', url: '/api/health', headers: { cookie } })).json();
    expect(rep.mailboxes).toBeDefined();
    expect(rep.sending).toBeDefined();
    expect(rep.jobs).toBeDefined();
    expect(rep.storage).toBeUndefined();
    expect(rep.backups).toBeUndefined();
    expect(rep.system).toBeUndefined();
    const adminCookie = await login(app);
    const arep = (await app.inject({ method: 'GET', url: '/api/health', headers: { cookie: adminCookie } })).json();
    expect(arep.system.version).toBeTruthy();
    expect(arep.storage.reachable).toBe(true);
  });

  it('lists mailboxes with sync state and 24 h counts', async () => {
    const a = await makeAccount('alice@demo.test');
    const rep = await healthReport(TEST_USER, false);
    expect(rep.mailboxes).toHaveLength(1);
    expect(rep.mailboxes[0]).toMatchObject({ accountId: a, email: 'alice@demo.test', state: 'paused', newLast24h: 0 });
  });

  it('jobs: retry and cancel work on my failed jobs only', async () => {
    const other = await makeUser('b@x.test');
    const mine = await enqueueJob(TEST_USER, 'test.x', Date.now(), {});
    const theirs = await enqueueJob(other, 'test.x', Date.now(), {});
    await run("UPDATE jobs SET status = 'failed', attempts = 5, last_error = 'boom' WHERE id IN (?, ?)", [mine, theirs]);
    const cookie = await login(app);
    expect((await healthReport(TEST_USER, false)).jobs.failed.map((j: any) => j.id)).toEqual([mine]);
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${theirs}/retry`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${theirs}/cancel`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${mine}/retry`, headers: { cookie } })).statusCode).toBe(200);
    expect(await one<any>('SELECT status, attempts FROM jobs WHERE id = ?', [mine])).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await one<any>('SELECT status FROM jobs WHERE id = ?', [theirs])).status).toBe('failed');
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${mine}/cancel`, headers: { cookie } })).statusCode).toBe(200);
  });

  it('resync only for your own mailbox', async () => {
    const a = await makeAccount('alice@demo.test');
    const other = await makeUser('b@x.test');
    const theirs = await makeAccount('bob@demo.test', { userId: other });
    const cookie = await login(app);
    expect((await app.inject({ method: 'POST', url: `/api/accounts/${theirs}/resync`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/accounts/${a}/resync`, headers: { cookie } })).statusCode).toBe(200);
  });
});
