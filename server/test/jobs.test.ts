import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, TEST_USER, makeUser } from './helpers.ts';
import { q, one, run } from '../src/db.ts';
import { registerJob, enqueueJob, cancelJob, runDueJobs } from '../src/jobs/runner.ts';

beforeEach(async () => { await resetDb(); });

let ran: number[] = [];
registerJob('test.ok', async (j) => { ran.push(j.id); });
registerJob('test.slow', async (j) => { await new Promise((r) => setTimeout(r, 50)); ran.push(j.id); });
registerJob('test.boom', async () => { throw new Error('nope'); });
beforeEach(() => { ran = []; });

describe('job runner', () => {
  it('runs a due job once and ignores a future one', async () => {
    const now = Date.now();
    const a = await enqueueJob(TEST_USER, 'test.ok', now - 1, {});
    const b = await enqueueJob(TEST_USER, 'test.ok', now + 60_000, {});
    await runDueJobs(now);
    await runDueJobs(now);
    expect(ran).toEqual([a]);
    expect((await one<any>('SELECT status FROM jobs WHERE id = ?', [a])).status).toBe('done');
    expect((await one<any>('SELECT status FROM jobs WHERE id = ?', [b])).status).toBe('pending');
  });

  it('retries a failing job later and ends failed after 5 attempts with a job.failed event', async () => {
    const t0 = Date.now();
    const id = await enqueueJob(TEST_USER, 'test.boom', t0 - 1, {});
    let now = t0;
    await runDueJobs(now);
    let row = await one<any>('SELECT * FROM jobs WHERE id = ?', [id]);
    expect(row.status).toBe('pending');
    expect(Number(row.run_at)).toBeGreaterThan(now);
    expect(row.last_error).toBe('nope');
    for (let i = 0; i < 4; i++) { now = Number(row.run_at) + 1; await runDueJobs(now); row = await one<any>('SELECT * FROM jobs WHERE id = ?', [id]); }
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(5);
    const ev = await q('SELECT 1 FROM events WHERE type = ?', ['job.failed']);
    expect(ev).toHaveLength(1);
  });

  it('two concurrent runners run a job exactly once', async () => {
    const id = await enqueueJob(TEST_USER, 'test.slow', Date.now() - 1, {});
    await Promise.all([runDueJobs(), runDueJobs()]);
    expect(ran.filter((x) => x === id)).toHaveLength(1);
  });

  it('picks a running job up again once its lock has expired', async () => {
    const id = await enqueueJob(TEST_USER, 'test.ok', Date.now() - 1, {});
    await run("UPDATE jobs SET status = 'running', locked_until = ? WHERE id = ?", [Date.now() - 1000, id]);
    await runDueJobs();
    expect(ran).toEqual([id]);
  });

  it('cancelJob stops a pending job and refuses another user’s job', async () => {
    const other = await makeUser('b@x.test');
    const id = await enqueueJob(TEST_USER, 'test.ok', Date.now() - 1, {});
    expect(await cancelJob(other, id)).toBe(false);
    expect(await cancelJob(TEST_USER, id)).toBe(true);
    await runDueJobs();
    expect(ran).toEqual([]);
    expect(await cancelJob(TEST_USER, id)).toBe(false);
  });
});
