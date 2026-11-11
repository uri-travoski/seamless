import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, TEST_USER } from './helpers.ts';

const sent: { envelope: any; raw: Buffer }[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { queueSend, undoSend, pendingSends } = await import('../src/mail/undoSend.ts');
const { runDueJobs } = await import('../src/jobs/runner.ts');
const { setUserSetting } = await import('../src/classify/settings.ts');
const { q, one, run } = await import('../src/db.ts');
const { makeApp, resetLimiters, login } = await import('./app.ts');

const app = await makeApp();
afterAll(() => app.close());

function payload(accountId: number, extra: Partial<any> = {}) {
  return {
    accountId, fromEmail: 'alice@demo.test',
    to: [{ name: 'Bob', email: 'bob@x.test' }], cc: [], bcc: [],
    subject: 'Quote', html: '<p>hello</p>', attachmentIds: [], track: false, ...extra,
  };
}

let acct: number;
beforeEach(async () => {
  await resetDb(); resetLimiters(); sent.length = 0;
  acct = await makeAccount('alice@demo.test');
  await makeMailbox(acct, 'INBOX', 'inbox');
  await makeMailbox(acct, 'Sent', 'sent');
});

describe('F-17 undo send', () => {
  it('undo within the window sends nothing and returns the payload', async () => {
    const r = await queueSend(TEST_USER, payload(acct));
    expect(r.queued).toBe(true);
    if (!r.queued) return;
    expect(await pendingSends(TEST_USER)).toHaveLength(1);
    const back = await undoSend(TEST_USER, r.jobId);
    expect(back?.subject).toBe('Quote');
    await runDueJobs(r.releaseAt + 1);
    expect(sent).toHaveLength(0);
    expect(await pendingSends(TEST_USER)).toHaveLength(0);
  });

  it('without undo it is sent exactly once, even if the runner is called twice', async () => {
    const r = await queueSend(TEST_USER, payload(acct));
    if (!r.queued) throw new Error('expected queued');
    await runDueJobs(r.releaseAt - 1000);
    expect(sent).toHaveLength(0);
    await Promise.all([runDueJobs(r.releaseAt + 1), runDueJobs(r.releaseAt + 1)]);
    expect(sent).toHaveLength(1);
  });

  it('setting 0 sends immediately', async () => {
    await setUserSetting(TEST_USER, 'undo_send_seconds', '0');
    const r = await queueSend(TEST_USER, payload(acct));
    expect(r.queued).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('validates up front: no recipient / someone else’s account', async () => {
    await expect(queueSend(TEST_USER, payload(acct, { to: [] }))).rejects.toThrow(/recipient/);
    const other = await makeUser('b@x.test');
    await expect(queueSend(other, payload(acct))).rejects.toThrow(/Unknown account/);
  });

  it('another user cannot undo my message; undo after release says too late', async () => {
    const other = await makeUser('b@x.test');
    const r = await queueSend(TEST_USER, payload(acct));
    if (!r.queued) throw new Error('expected queued');
    expect(await undoSend(other, r.jobId)).toBeNull();
    await runDueJobs(r.releaseAt + 1);
    expect(await undoSend(TEST_USER, r.jobId)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('a held message whose worker died (expired lock) is still sent once', async () => {
    const r = await queueSend(TEST_USER, payload(acct));
    if (!r.queued) throw new Error('expected queued');
    await run("UPDATE jobs SET status = 'running', locked_until = ? WHERE id = ?", [Date.now() - 1000, r.jobId]);
    await runDueJobs(r.releaseAt + 1);
    expect(sent).toHaveLength(1);
  });

  it('HTTP: /api/send queues, /api/send/undo returns the payload, 409 afterwards', async () => {
    const cookie = await login(app);
    const res = await app.inject({ method: 'POST', url: '/api/send', headers: { cookie }, payload: payload(acct) });
    const j = res.json();
    expect(j.queued).toBe(true);
    const u1 = await app.inject({ method: 'POST', url: '/api/send/undo', headers: { cookie }, payload: { jobId: j.jobId } });
    expect(u1.statusCode).toBe(200);
    expect(u1.json().payload.subject).toBe('Quote');
    const u2 = await app.inject({ method: 'POST', url: '/api/send/undo', headers: { cookie }, payload: { jobId: j.jobId } });
    expect(u2.statusCode).toBe(409);
    const set = await app.inject({ method: 'PUT', url: '/api/settings/server', headers: { cookie }, payload: { undoSendSeconds: 7 } });
    expect(set.statusCode).toBe(400);
  });
});
