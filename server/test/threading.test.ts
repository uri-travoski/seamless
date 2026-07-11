import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';
import { normalizeSubject } from '../src/mail/threading.ts';
import { q } from '../src/db.ts';

describe('subject normalization', () => {
  it('strips Re:/Fwd: prefixes recursively', () => {
    expect(normalizeSubject('Re: Re: Fwd: Hello World')).toBe('hello world');
    expect(normalizeSubject('RE[2]: Hello')).toBe('hello');
    expect(normalizeSubject('AW: Termin')).toBe('termin');
    expect(normalizeSubject('Plain subject')).toBe('plain subject');
  });
});

describe('thread assignment', () => {
  let acct: number, inbox: number, sent: number;

  beforeEach(async () => {
    await resetDb();
    acct = await makeAccount('alice@demo.test');
    inbox = await makeMailbox(acct, 'INBOX', 'inbox');
    sent = await makeMailbox(acct, 'Sent', 'sent');
  });

  it('joins replies into the same thread via In-Reply-To', async () => {
    const a = await ingest(acct, inbox, rawEmail({
      from: 'bob@x.test', to: 'alice@demo.test', subject: 'Question', messageId: '<q1@x.test>',
    }));
    const b = await ingest(acct, sent, rawEmail({
      from: 'alice@demo.test', to: 'bob@x.test', subject: 'Re: Question',
      messageId: '<a1@demo.test>', inReplyTo: '<q1@x.test>',
    }));
    const c = await ingest(acct, inbox, rawEmail({
      from: 'bob@x.test', to: 'alice@demo.test', subject: 'Re: Question',
      messageId: '<q2@x.test>', inReplyTo: '<a1@demo.test>', references: ['<q1@x.test>', '<a1@demo.test>'],
    }));
    const rows = await q<{ id: number; thread_id: string }>('SELECT id, thread_id FROM messages');
    const threads = new Set(rows.map((r) => r.thread_id));
    expect(threads.size).toBe(1);
    expect(a && b && c).toBeTruthy();
  });

  it('keeps unrelated messages in separate threads', async () => {
    await ingest(acct, inbox, rawEmail({ from: 'x@x.test', to: 'alice@demo.test', subject: 'One', messageId: '<one@x>' }));
    await ingest(acct, inbox, rawEmail({ from: 'y@y.test', to: 'alice@demo.test', subject: 'Two', messageId: '<two@y>' }));
    const rows = await q<{ thread_id: string }>('SELECT thread_id FROM messages');
    expect(new Set(rows.map((r) => r.thread_id)).size).toBe(2);
  });

  it('dedupes same-mailbox same-uid ingests', async () => {
    const raw = rawEmail({ from: 'x@x.test', to: 'alice@demo.test', subject: 'Dup', messageId: '<dup@x>' });
    const first = await ingest(acct, inbox, raw, { uid: 999 });
    const second = await ingest(acct, inbox, raw, { uid: 999 });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
