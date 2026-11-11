import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, TEST_USER, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';
import { makeApp, resetLimiters, login } from './app.ts';
import { q, one } from '../src/db.ts';
import { queryEmails, listMailboxes } from '../src/mail/store.ts';
import { snoozeThread, unsnoozeThread, wakeOnReply } from '../src/mail/snooze.ts';
import { runDueJobs } from '../src/jobs/runner.ts';

const app = await makeApp();
afterAll(() => app.close());

let acct: number, inbox: number;
const ids = async (filter: any) => (await queryEmails(TEST_USER, { filter, position: 0, limit: 50 })).ids;
const rowId = async (subject: string) => (await one<{ id: number }>('SELECT id FROM messages WHERE subject = ?', [subject]))!.id;

beforeEach(async () => {
  await resetDb(); resetLimiters();
  acct = await makeAccount('alice@demo.test');
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
});

async function mail(subject: string, extra: any = {}, opts: any = {}) {
  await ingest(acct, inbox, rawEmail({ from: 'bob@x.test', to: 'alice@demo.test', subject, ...extra }), opts);
  return rowId(subject);
}

describe('F-18 snooze', () => {
  it('hides the thread from the Inbox and its unread count, shows it in Snoozed', async () => {
    const a = await mail('A'); const b = await mail('B');
    const before = (await listMailboxes(TEST_USER)).find((m) => m.id === 'u:inbox')!.unreadEmails;
    expect(before).toBe(2);
    await snoozeThread(TEST_USER, `m${a}`, Date.now() + 3_600_000);
    expect(await ids({ inMailbox: 'u:inbox' })).toEqual([`m${b}`]);
    expect(await ids({ snoozed: true })).toEqual([`m${a}`]);
    expect((await listMailboxes(TEST_USER)).find((m) => m.id === 'u:inbox')!.unreadEmails).toBe(1);
  });

  it('wakes at the time: back in the Inbox, unread, first, with a notification', async () => {
    const a = await mail('A', { date: 'Mon, 06 Jul 2026 10:00:00 +0000' }, { flags: ['\\Seen'] });
    const b = await mail('B', { date: 'Wed, 08 Jul 2026 10:00:00 +0000' });
    const until = Date.now() + 60_000;
    await snoozeThread(TEST_USER, `m${a}`, until);
    await runDueJobs(until - 1000);
    expect(await ids({ snoozed: true })).toHaveLength(1);
    await runDueJobs(until + 1);
    expect(await ids({ inMailbox: 'u:inbox' })).toEqual([`m${a}`, `m${b}`]);   // woken one first (sort_date)
    expect((await one<any>('SELECT unread FROM messages WHERE id = ?', [a])).unread).toBe(true);
    const n = await q('SELECT title FROM notifications WHERE user_id = ?', [TEST_USER]);
    expect(n.map((x: any) => x.title)).toContain('Back in your Inbox');
  });

  it('a live reply wakes the thread early and cancels the job', async () => {
    const msgId = '<orig@test>';
    const a = await mail('Quote', { messageId: msgId });
    await snoozeThread(TEST_USER, `m${a}`, Date.now() + 86_400_000);
    await ingest(acct, inbox, rawEmail({ from: 'bob@x.test', to: 'alice@demo.test', subject: 'Re: Quote', inReplyTo: msgId, references: [msgId] }), { isLive: true });
    const reply = await rowId('Re: Quote');
    expect(await wakeOnReply(TEST_USER, reply)).toBe(true);
    expect(await ids({ snoozed: true })).toHaveLength(0);
    expect(await q("SELECT 1 FROM jobs WHERE kind = 'snooze.wake' AND status = 'pending'")).toHaveLength(0);
  });

  it('re-snoozing replaces the old job', async () => {
    const a = await mail('A');
    await snoozeThread(TEST_USER, `m${a}`, Date.now() + 60_000);
    await snoozeThread(TEST_USER, `m${a}`, Date.now() + 120_000);
    expect(await q("SELECT 1 FROM jobs WHERE kind = 'snooze.wake' AND status = 'pending'")).toHaveLength(1);
  });

  it('rejects a time in the past; another user cannot touch my thread', async () => {
    const a = await mail('A');
    await expect(snoozeThread(TEST_USER, `m${a}`, Date.now() - 1)).rejects.toThrow();
    const other = await makeUser('b@x.test');
    await expect(snoozeThread(other, `m${a}`, Date.now() + 60_000)).rejects.toThrow(/not found/);
    await snoozeThread(TEST_USER, `m${a}`, Date.now() + 60_000);
    const thread = (await one<any>('SELECT thread_id FROM messages WHERE id = ?', [a])).thread_id;
    expect(await unsnoozeThread(other, thread, { wake: false })).toBe(false);
    expect(await ids({ snoozed: true })).toHaveLength(1);
  });

  it('HTTP + bulk: snooze then undo', async () => {
    const cookie = await login(app);
    const a = await mail('A');
    const until = Date.now() + 3_600_000;
    const r = await app.inject({ method: 'POST', url: '/api/bulk', headers: { cookie }, payload: { ids: [`m${a}`], action: 'snooze', value: until } });
    expect(r.statusCode).toBe(200);
    expect(await ids({ snoozed: true })).toHaveLength(1);
    const u = await app.inject({ method: 'POST', url: '/api/bulk/undo', headers: { cookie }, payload: { undoToken: r.json().undoToken } });
    expect(u.statusCode).toBe(200);
    expect(await ids({ snoozed: true })).toHaveLength(0);
    const thread = (await one<any>('SELECT thread_id FROM messages WHERE id = ?', [a])).thread_id;
    const s = await app.inject({ method: 'POST', url: '/api/snooze', headers: { cookie }, payload: { emailId: `m${a}`, until } });
    expect(s.statusCode).toBe(200);
    const d = await app.inject({ method: 'DELETE', url: `/api/snooze/${encodeURIComponent(thread)}`, headers: { cookie } });
    expect(d.json().ok).toBe(true);
    expect(await ids({ snoozed: true })).toHaveLength(0);
  });
});
