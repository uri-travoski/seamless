import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { q, one, run } from '../src/db.ts';

const sendMailMock = vi.fn(async () => ({ messageId: 'ok' }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: sendMailMock, verify: async () => true }) },
}));

const { scheduleEmail, cancelScheduleByMessageId } = await import('../src/mail/send.ts');
const { processDueSends } = await import('../src/mail/scheduler.ts');
const { destroyEmail, queryEmails, setScheduleCanceller } = await import('../src/mail/store.ts');

// index.ts wires this in production; do the same for the test
setScheduleCanceller(cancelScheduleByMessageId);

function payload(accountId: number, extra: Partial<any> = {}) {
  return {
    accountId, fromEmail: 'alice@demo.test',
    to: [{ name: 'Bob', email: 'bob@x.test' }], cc: [], bcc: [],
    subject: 'Later', html: '<p>see you later</p>',
    attachmentIds: [], track: true, ...extra,
  };
}

let acct: number, inbox: number, sent: number, sched: number, userId: number;

beforeEach(async () => {
  await resetDb();
  userId = TEST_USER;
  sendMailMock.mockClear();
  acct = await makeAccount('alice@demo.test');
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  sent = await makeMailbox(acct, 'Sent', 'sent');
  sched = await makeMailbox(acct, 'Scheduled', 'scheduled');
});

describe('scheduleEmail', () => {
  it('rejects a past time', async () => {
    await expect(scheduleEmail(userId, payload(acct), Date.now() - 1000)).rejects.toThrow(/future/);
  });

  it('creates a scheduled_sends row and queues an append to Scheduled', async () => {
    const at = Date.now() + 3_600_000;
    const res = await scheduleEmail(userId, payload(acct), at);
    expect(res.id).toBeGreaterThan(0);
    const row = await one<any>('SELECT * FROM scheduled_sends WHERE id = ?', [res.id]);
    expect(row.send_at).toBe(at);
    expect(row.tracking_token).toBeTruthy(); // track:true embeds a pixel
    expect(JSON.parse(row.envelope_to)).toEqual(['bob@x.test']);
    const appendOps = (await q<any>("SELECT payload FROM op_queue WHERE op = 'append'"))
      .map((o) => JSON.parse(o.payload));
    expect(appendOps.some((p) => p.targetRole === 'scheduled')).toBe(true);
  });
});

describe('processDueSends', () => {
  it('does nothing while the time is in the future', async () => {
    await scheduleEmail(userId, payload(acct), Date.now() + 3_600_000);
    const n = await processDueSends();
    expect(n).toBe(0);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect((await one<any>('SELECT COUNT(*) c FROM scheduled_sends'))!.c).toBe(1);
  });

  it('sends when due, removes the Scheduled copy, queues a Sent append, clears the row', async () => {
    const res = await scheduleEmail(userId, payload(acct), Date.now() + 3_600_000);
    const row = await one<any>('SELECT * FROM scheduled_sends WHERE id = ?', [res.id]);

    // simulate the Scheduled folder message having synced in (same Message-ID)
    await ingest(acct, sched, rawEmail({
      from: 'alice@demo.test', to: 'bob@x.test', subject: 'Later', messageId: row.message_id,
    }), { uid: 5000 });
    expect((await queryEmails(userId, { filter: { inMailbox: 'u:scheduled' }, position: 0, limit: 10 })).total).toBe(1);

    await run('DELETE FROM op_queue'); // ignore the append-to-scheduled op
    const n = await processDueSends(row.send_at + 1);

    expect(n).toBe(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const envelope = (sendMailMock.mock.calls as any[])[0][0].envelope;
    expect(envelope.to).toEqual(['bob@x.test']);
    // scheduled row cleared, Scheduled folder emptied, Sent append + expunge queued
    expect((await one<any>('SELECT COUNT(*) c FROM scheduled_sends'))!.c).toBe(0);
    expect((await queryEmails(userId, { filter: { inMailbox: 'u:scheduled' }, position: 0, limit: 10 })).total).toBe(0);
    const ops = (await q<any>('SELECT op, payload FROM op_queue')).map((o) => ({ op: o.op, p: JSON.parse(o.payload) }));
    expect(ops.some((o) => o.op === 'append' && o.p.targetRole === 'sent')).toBe(true);
    expect(ops.some((o) => o.op === 'expunge')).toBe(true);
  });

  it('cancel via delete removes the pending send', async () => {
    const res = await scheduleEmail(userId, payload(acct), Date.now() + 3_600_000);
    const row = await one<any>('SELECT * FROM scheduled_sends WHERE id = ?', [res.id]);
    await ingest(acct, sched, rawEmail({
      from: 'alice@demo.test', to: 'bob@x.test', subject: 'Later', messageId: row.message_id,
    }), { uid: 5001 });

    const scheduledId = (await queryEmails(userId, { filter: { inMailbox: 'u:scheduled' }, position: 0, limit: 1 })).ids[0];
    await destroyEmail(userId, scheduledId); // deleting a Scheduled item must cancel the send
    expect((await one<any>('SELECT COUNT(*) c FROM scheduled_sends'))!.c).toBe(0);

    const n = await processDueSends(row.send_at + 1);
    expect(n).toBe(0);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('cancelScheduleByMessageId returns false for unknown id', async () => {
    expect(await cancelScheduleByMessageId('<nope@x>')).toBe(false);
  });
});
