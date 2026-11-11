import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, TEST_USER, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const sent: { envelope: any; raw: Buffer }[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { createFollowup, cancelFollowup, listFollowups } = await import('../src/mail/followups.ts');
const { sendEmail } = await import('../src/mail/send.ts');
const { runDueJobs } = await import('../src/jobs/runner.ts');
const { queryEmails, getEmails } = await import('../src/mail/store.ts');
const { q, one } = await import('../src/db.ts');

let acct: number, inbox: number, sentBox: number;
const DAY = 86_400_000;
const rowId = async (subject: string) => (await one<{ id: number }>('SELECT id FROM messages WHERE subject = ?', [subject]))!.id;

beforeEach(async () => {
  await resetDb(); sent.length = 0;
  acct = await makeAccount('alice@demo.test');
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  sentBox = await makeMailbox(acct, 'Sent', 'sent');
});

async function sentMail(subject = 'Quote', to = 'Bob <bob@x.test>') {
  await ingest(acct, sentBox, rawEmail({ from: 'alice@demo.test', to, subject, messageId: `<${subject}@test>`, date: 'Wed, 08 Jul 2026 10:00:00 +0000' }));
  return rowId(subject);
}
const reply = (from: string, subject = 'Quote') =>
  ingest(acct, inbox, rawEmail({ from, to: 'alice@demo.test', subject: `Re: ${subject}`, inReplyTo: `<${subject}@test>`, references: [`<${subject}@test>`], date: 'Thu, 09 Jul 2026 10:00:00 +0000' }));
const notes = async () => (await q<any>("SELECT title FROM notifications WHERE user_id = ? AND type = 'followup.due'", [TEST_USER])).map((n) => n.title);

describe('F-19 follow-up reminders', () => {
  it('a reply from a recipient before the due time → replied, no notification', async () => {
    const id = await sentMail();
    const due = Date.now() + DAY;
    const fid = await createFollowup(TEST_USER, `m${id}`, due);
    await reply('bob@x.test');
    await runDueJobs(due + 1);
    expect((await one<any>('SELECT status FROM followups WHERE id = ?', [fid])).status).toBe('replied');
    expect(await notes()).toEqual([]);
  });

  it('a reply from someone who is not a recipient does not count', async () => {
    const id = await sentMail();
    const due = Date.now() + DAY;
    const fid = await createFollowup(TEST_USER, `m${id}`, due);
    await reply('stranger@y.test');
    await runDueJobs(due + 1);
    expect((await one<any>('SELECT status FROM followups WHERE id = ?', [fid])).status).toBe('due');
    expect(await notes()).toHaveLength(1);
  });

  it('no reply → a "No reply from …" notification at the due time, not before', async () => {
    const id = await sentMail();
    const due = Date.now() + DAY;
    await createFollowup(TEST_USER, `m${id}`, due);
    await runDueJobs(due - 1000);
    expect(await notes()).toEqual([]);
    await runDueJobs(due + 1);
    expect(await notes()).toEqual(['No reply from Bob']);
  });

  it('cancelling stops the reminder; the waiting filter follows the status', async () => {
    const id = await sentMail();
    const due = Date.now() + DAY;
    const fid = await createFollowup(TEST_USER, `m${id}`, due);
    const waiting = async () => (await queryEmails(TEST_USER, { filter: { waiting: true }, position: 0, limit: 20 })).ids;
    expect(await waiting()).toEqual([`m${id}`]);
    const [e] = await getEmails(TEST_USER, [`m${id}`]);
    expect(e.followupId).toBe(fid);
    expect(await cancelFollowup(TEST_USER, fid)).toBe(true);
    expect(await waiting()).toEqual([]);
    await runDueJobs(due + 1);
    expect(await notes()).toEqual([]);
  });

  it('only sent mail can be followed up; the time must be in the future', async () => {
    await ingest(acct, inbox, rawEmail({ from: 'bob@x.test', to: 'alice@demo.test', subject: 'Hi' }));
    await expect(createFollowup(TEST_USER, `m${await rowId('Hi')}`, Date.now() + DAY)).rejects.toThrow(/sent/i);
    const id = await sentMail();
    await expect(createFollowup(TEST_USER, `m${id}`, Date.now() - 1)).rejects.toThrow(/future/);
  });

  it('from compose: remembered by Message-ID, resolved when the Sent copy is ingested', async () => {
    await sendEmail(TEST_USER, {
      accountId: acct, fromEmail: 'alice@demo.test', to: [{ name: 'Bob', email: 'bob@x.test' }], cc: [], bcc: [],
      subject: 'Proposal', html: '<p>hi</p>', attachmentIds: [], track: false, followupDays: 2,
    });
    const pending = await one<any>('SELECT * FROM followups');
    expect(pending.message_id).toBeNull();
    expect(pending.message_id_header).toMatch(/^<fu-/);
    expect(Number(pending.due_at)).toBeGreaterThan(Date.now() + 1.9 * DAY);
    await ingest(acct, sentBox, sent[0].raw);          // what IMAP sync does with the Sent copy
    const done = await one<any>('SELECT * FROM followups');
    expect(done.message_id).toBe(await rowId('Proposal'));
    expect(done.thread_id).toBeTruthy();
    expect((await getEmails(TEST_USER, [`m${done.message_id}`]))[0].followupDueAt).toBeTruthy();
  });

  it('isolation: another user cannot see, create or cancel my follow-ups', async () => {
    const id = await sentMail();
    const fid = await createFollowup(TEST_USER, `m${id}`, Date.now() + DAY);
    const other = await makeUser('b@x.test');
    await expect(createFollowup(other, `m${id}`, Date.now() + DAY)).rejects.toThrow(/not found/);
    expect(await cancelFollowup(other, fid)).toBe(false);
    expect(await listFollowups(other)).toEqual([]);
    expect(await listFollowups(TEST_USER)).toHaveLength(1);
  });
});
