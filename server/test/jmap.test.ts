import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { handleJmapRequest } from '../src/jmap/api.ts';

let acct: number, inbox: number, userId: number;

beforeAll(async () => {
  await resetDb();
  userId = TEST_USER;
  acct = await makeAccount('alice@demo.test', { aliases: ['a.alias@demo.test'] });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  await makeMailbox(acct, 'Trash', 'trash');
  for (let i = 0; i < 3; i++) {
    await ingest(acct, inbox, rawEmail({
      from: `p${i}@x.test`, to: 'alice@demo.test', subject: `Jmap ${i}`, messageId: `<j${i}@x>`,
      date: new Date(Date.UTC(2026, 2, 1 + i)).toUTCString(),
    }));
  }
});

describe('JMAP endpoint', () => {
  it('Mailbox/get + Email/query + Email/get chain', async () => {
    const res = await handleJmapRequest(userId, {
      methodCalls: [
        ['Mailbox/get', {}, '0'],
        ['Email/query', { filter: { inMailbox: 'u:inbox' }, position: 0, limit: 120 }, '1'],
      ],
    });
    const [mbName, mbRes] = res.methodResponses[0];
    expect(mbName).toBe('Mailbox/get');
    expect(mbRes.list.find((b: any) => b.id === 'u:inbox')).toBeTruthy();

    const [, queryRes] = res.methodResponses[1];
    expect(queryRes.total).toBe(3);
    expect(queryRes.ids[0]).toMatch(/^m\d+$/);

    const res2 = await handleJmapRequest(userId, {
      methodCalls: [['Email/get', { ids: queryRes.ids }, '0']],
    });
    const [, getRes] = res2.methodResponses[0];
    expect(getRes.list.length).toBe(3);
    expect(getRes.list[0].subject).toBe('Jmap 2');
    expect(getRes.list[0].accountEmail).toBe('alice@demo.test');
  });

  it('Email/set patches keywords and moves to trash', async () => {
    const q = await handleJmapRequest(userId, {
      methodCalls: [['Email/query', { filter: { inMailbox: 'u:inbox' }, position: 0, limit: 1 }, '0']],
    });
    const id = q.methodResponses[0][1].ids[0];

    const res = await handleJmapRequest(userId, {
      methodCalls: [
        ['Email/set', { update: { [id]: { 'keywords/$seen': true } } }, '0'],
        ['Email/get', { ids: [id] }, '1'],
      ],
    });
    expect(res.methodResponses[0][1].updated[id]).toBe(null);
    expect(res.methodResponses[1][1].list[0].keywords.$seen).toBe(true);

    const res2 = await handleJmapRequest(userId, {
      methodCalls: [
        ['Email/set', { update: { [id]: { mailboxIds: { 'u:trash': true } } } }, '0'],
        ['Email/get', { ids: [id] }, '1'],
      ],
    });
    expect(res2.methodResponses[1][1].list[0].mailboxRole).toBe('trash');
  });

  it('Identity/get includes aliases', async () => {
    const res = await handleJmapRequest(userId, { methodCalls: [['Identity/get', {}, '0']] });
    const list = res.methodResponses[0][1].list;
    expect(list.map((i: any) => i.email)).toEqual(['alice@demo.test', 'a.alias@demo.test']);
    expect(list[1].isAlias).toBe(true);
  });

  it('resolves #ids back-references (query + get in one request)', async () => {
    const res = await handleJmapRequest(userId, {
      methodCalls: [
        ['Email/query', { filter: { inMailbox: 'u:inbox' }, position: 0, limit: 10 }, 'q'],
        ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' } } as any, 'g'],
      ],
    });
    const [, getRes] = res.methodResponses[1];
    expect(getRes.list.length).toBeGreaterThan(0);
    expect(getRes.list[0].id).toMatch(/^m\d+$/);
  });

  it('unknown method returns JMAP error', async () => {
    const res = await handleJmapRequest(userId, { methodCalls: [['Nope/get', {}, '0']] });
    expect(res.methodResponses[0][0]).toBe('error');
    expect(res.methodResponses[0][1].type).toBe('unknownMethod');
  });
});
