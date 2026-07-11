import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { q, one } from '../src/db.ts';
import { queryEmails, getEmails, setKeywords, moveEmail, destroyEmail, listMailboxes, getThreadEmailIds } from '../src/mail/store.ts';
import { applyLocalFilterActions } from '../src/mail/ingest.ts';

let acct1: number, acct2: number;
let inbox1: number, inbox2: number, sent1: number, trash1: number;
let userId: number;

beforeAll(async () => {
  await resetDb();
  userId = TEST_USER;
  acct1 = await makeAccount('alice@demo.test');
  acct2 = await makeAccount('support@demo.test');
  inbox1 = await makeMailbox(acct1, 'INBOX', 'inbox');
  sent1 = await makeMailbox(acct1, 'Sent', 'sent');
  trash1 = await makeMailbox(acct1, 'Trash', 'trash');
  inbox2 = await makeMailbox(acct2, 'INBOX', 'inbox');
  await makeMailbox(acct2, 'Sent', 'sent');
  await makeMailbox(acct2, 'Trash', 'trash');

  // 150 messages in acct1 inbox for pagination, 5 in acct2 inbox
  for (let i = 0; i < 150; i++) {
    await ingest(acct1, inbox1, rawEmail({
      from: `sender${i}@x.test`, to: 'alice@demo.test', subject: `Message ${i}`,
      body: i === 7 ? 'the zebra crossed the road' : `body ${i}`,
      date: new Date(Date.UTC(2026, 0, 1, 0, i)).toUTCString(),
      messageId: `<a${i}@x.test>`,
    }));
  }
  for (let i = 0; i < 5; i++) {
    await ingest(acct2, inbox2, rawEmail({
      from: `client${i}@y.test`, to: 'support@demo.test', subject: `Support request ${i}`,
      date: new Date(Date.UTC(2026, 1, 1, 0, i)).toUTCString(),
      messageId: `<s${i}@y.test>`,
    }));
  }
  await ingest(acct1, sent1, rawEmail({
    from: 'alice@demo.test', to: 'bob@x.test', subject: 'My sent one', messageId: '<sent1@demo>',
  }));
});

describe('unified inbox query', () => {
  it('merges accounts, newest first, paginated at 120', async () => {
    const page1 = await queryEmails(userId, { filter: { inMailbox: 'u:inbox' }, position: 0, limit: 120 });
    expect(page1.total).toBe(155);
    expect(page1.ids.length).toBe(120);
    const first = (await getEmails(userId, [page1.ids[0]]))[0];
    expect(first.subject).toBe('Support request 4'); // newest overall from acct2
    const page2 = await queryEmails(userId, { filter: { inMailbox: 'u:inbox' }, position: 120, limit: 120 });
    expect(page2.ids.length).toBe(35);
    expect(new Set([...page1.ids, ...page2.ids]).size).toBe(155);
  });

  it('unified sent shows only sent-role mailboxes', async () => {
    const res = await queryEmails(userId, { filter: { inMailbox: 'u:sent' }, position: 0, limit: 120 });
    expect(res.total).toBe(1);
    expect((await getEmails(userId, [res.ids[0]]))[0].subject).toBe('My sent one');
  });

  it('per-mailbox filter works', async () => {
    const res = await queryEmails(userId, { filter: { inMailbox: `mb:${inbox2}` }, position: 0, limit: 120 });
    expect(res.total).toBe(5);
  });

  it('another user sees nothing', async () => {
    const res = await queryEmails(userId + 999, { filter: { inMailbox: 'u:inbox' }, position: 0, limit: 120 });
    expect(res.total).toBe(0);
  });
});

describe('search', () => {
  it('finds body text via FTS', async () => {
    const res = await queryEmails(userId, { filter: { text: 'zebra' }, position: 0, limit: 120 });
    expect(res.total).toBe(1);
    expect((await getEmails(userId, [res.ids[0]]))[0].subject).toBe('Message 7');
  });

  it('combines operators with FTS', async () => {
    const res = await queryEmails(userId, { filter: { text: 'from:client2 support' }, position: 0, limit: 120 });
    expect(res.total).toBe(1);
    expect((await getEmails(userId, [res.ids[0]]))[0].subject).toBe('Support request 2');
  });

  it('in:sent scopes to sent', async () => {
    const res = await queryEmails(userId, { filter: { text: 'in:sent' }, position: 0, limit: 120 });
    expect(res.total).toBe(1);
  });
});

describe('mailbox listing', () => {
  it('provides unified + per-account mailboxes with counts', async () => {
    const boxes = await listMailboxes(userId);
    const uInbox = boxes.find((b) => b.id === 'u:inbox')!;
    expect(uInbox.totalEmails).toBe(155);
    expect(uInbox.unreadEmails).toBe(155);
    const acct1Inbox = boxes.find((b) => b.id === `mb:${inbox1}`)!;
    expect(acct1Inbox.totalEmails).toBe(150);
  });
});

describe('mutations', () => {
  it('setKeywords updates locally and queues IMAP op', async () => {
    const res = await queryEmails(userId, { filter: { inMailbox: `mb:${inbox2}` }, position: 0, limit: 1 });
    const id = res.ids[0];
    await setKeywords(userId, id, { $seen: true, $flagged: true });
    const email = (await getEmails(userId, [id]))[0];
    expect(email.keywords.$seen).toBe(true);
    expect(email.keywords.$flagged).toBe(true);
    const ops = await q("SELECT * FROM op_queue WHERE op = 'setFlags' ORDER BY id");
    expect(ops.length).toBeGreaterThan(0);
    const payload = JSON.parse(ops.at(-1).payload);
    expect(payload.add).toContain('\\Seen');
    expect(payload.add).toContain('\\Flagged');
  });

  it('moveEmail moves optimistically and queues op', async () => {
    const res = await queryEmails(userId, { filter: { inMailbox: `mb:${inbox1}` }, position: 0, limit: 1 });
    const id = res.ids[0];
    await moveEmail(userId, id, 'u:archive'); // no archive mailbox -> noop
    expect((await getEmails(userId, [id]))[0].mailboxId).toBe(`mb:${inbox1}`);
    await moveEmail(userId, id, 'u:trash');
    const email = (await getEmails(userId, [id]))[0];
    expect(email.mailboxId).toBe(`mb:${trash1}`);
    const ops = await q("SELECT * FROM op_queue WHERE op = 'move'");
    expect(ops.length).toBe(1);
  });

  it('destroy in trash expunges the row', async () => {
    const res = await queryEmails(userId, { filter: { inMailbox: `mb:${trash1}` }, position: 0, limit: 10 });
    const id = res.ids[0];
    await destroyEmail(userId, id);
    expect((await getEmails(userId, [id])).length).toBe(0);
  });
});

describe('filter actions propagate to IMAP', () => {
  it('markRead/star enqueue a setFlags op so sync cannot revert them', async () => {
    const res = await queryEmails(userId, { filter: { inMailbox: `mb:${inbox1}` }, position: 0, limit: 1 });
    const rowId = Number(res.ids[0].replace(/^m/, ''));
    const before = (await one<{ c: number }>("SELECT COUNT(*) c FROM op_queue WHERE op = 'setFlags'"))!.c;
    await applyLocalFilterActions(rowId, [{ type: 'markRead' }, { type: 'star' }]);
    const ops = await q<{ payload: string }>("SELECT payload FROM op_queue WHERE op = 'setFlags' ORDER BY id");
    expect(ops.length).toBe(before + 1);
    const payload = JSON.parse(ops.at(-1)!.payload);
    expect(payload.add).toEqual(['\\Seen', '\\Flagged']);
    const email = (await getEmails(userId, [res.ids[0]]))[0];
    expect(email.keywords.$seen).toBe(true);
    expect(email.keywords.$flagged).toBe(true);
  });
});

describe('threads', () => {
  it('getThreadEmailIds returns thread in date order', async () => {
    const a = await ingest(acct1, inbox1, rawEmail({
      from: 'x@x.test', to: 'alice@demo.test', subject: 'Thread root', messageId: '<troot@x>',
      date: 'Wed, 08 Jul 2026 10:00:00 +0000',
    }));
    await ingest(acct1, inbox1, rawEmail({
      from: 'x@x.test', to: 'alice@demo.test', subject: 'Re: Thread root', messageId: '<treply@x>',
      inReplyTo: '<troot@x>', date: 'Wed, 08 Jul 2026 11:00:00 +0000',
    }));
    const row = await one<{ thread_id: string }>('SELECT thread_id FROM messages WHERE id = ?', [a!.rowId]);
    const ids = await getThreadEmailIds(userId, row!.thread_id);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBe(`m${a!.rowId}`);
  });
});
