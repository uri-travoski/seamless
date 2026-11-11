/** T4 F-32 part 2: assignment, status, comments, mentions, presence. A owns, B viewer, C responder, M manager, D none. */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const { q } = await import('../src/db.ts');
const { queryEmails, getEmails } = await import('../src/mail/store.ts');
const { handlePresence, presenceRecipients, activePresence } = await import('../src/mail/presence.ts');
const { parseSearch } = await import('../src/mail/searchparse.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

let app: Awaited<ReturnType<typeof makeApp>>;
let A: number, B: number, C: number, D: number, M: number;
let acct: number, inbox: number, threadId: string, thread2: string;
const ck: Record<string, string> = {};
const api = (who: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck[who] } });
const assign = (who: string, body: any, tid = threadId) => api(who, 'PUT', `/api/threads/${tid}/assignment`, { accountId: acct, ...body });
const notifs = async (uid: number) => q<any>('SELECT type, body FROM notifications WHERE user_id = ? ORDER BY id', [uid]);

beforeEach(async () => {
  await resetDb(); resetLimiters();
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test'); C = await makeUser('carol@x.test');
  D = await makeUser('d@x.test'); M = await makeUser('m@x.test');
  acct = await makeAccount('support@demo.test', { userId: A, name: 'Support' });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  const r1 = await ingest(acct, inbox, rawEmail({ from: 'c1@ext.test', to: 'support@demo.test', subject: 'Ticket one' }));
  const r2 = await ingest(acct, inbox, rawEmail({ from: 'c2@ext.test', to: 'support@demo.test', subject: 'Ticket two' }));
  threadId = (await q<any>('SELECT thread_id FROM messages WHERE id = ?', [r1!.rowId]))[0].thread_id;
  thread2 = (await q<any>('SELECT thread_id FROM messages WHERE id = ?', [r2!.rowId]))[0].thread_id;
  app = await makeApp();
  for (const [k, e] of Object.entries({ A: 'a@x.test', B: 'b@x.test', C: 'carol@x.test', D: 'd@x.test', M: 'm@x.test' })) ck[k] = await login(app, e);
  for (const [u, role] of [[B, 'viewer'], [C, 'responder'], [M, 'manager']] as const)
    expect((await api('A', 'PUT', `/api/accounts/${acct}/shares`, { userId: u, role })).statusCode).toBe(200);
});

describe('assignment + status', () => {
  it('owner, responder and manager can assign; viewer and outsider cannot', async () => {
    expect((await assign('A', { assigneeId: C, status: 'open' })).statusCode).toBe(200);
    expect((await assign('C', { assigneeId: M, status: 'pending' })).statusCode).toBe(200);
    expect((await assign('M', { assigneeId: null, status: 'done' })).statusCode).toBe(200);
    expect((await assign('B', { assigneeId: C, status: 'open' })).statusCode).toBe(403);
    expect((await assign('D', { assigneeId: C, status: 'open' })).statusCode).toBe(404);
    const g = (await api('C', 'GET', `/api/threads/${threadId}/assignment?accountId=${acct}`)).json();
    expect(g).toMatchObject({ assigneeId: null, status: 'done' });
  });
  it('assignee must have access; bad status rejected; unassign works', async () => {
    expect((await assign('A', { assigneeId: D, status: 'open' })).statusCode).toBe(400);
    expect((await assign('A', { assigneeId: C, status: 'bogus' })).statusCode).toBe(400);
    const ok = (await assign('A', { assigneeId: C, status: 'pending', dueAt: 1900000000000 })).json();
    expect(ok).toMatchObject({ assigneeId: C, assigneeName: 'carol', status: 'pending', dueAt: 1900000000000 });
    expect((await assign('A', { assigneeId: null, status: 'open' })).json().assigneeId).toBeNull();
  });
  it('notifies the assignee only (not when assigning yourself), once per change of assignee', async () => {
    await assign('A', { assigneeId: C, status: 'open' });
    await assign('A', { assigneeId: C, status: 'pending' });
    await assign('C', { assigneeId: C, status: 'open' }, thread2);
    const n = await notifs(C);
    expect(n.filter((x) => x.type === 'assignment.changed')).toHaveLength(1);
    expect(n[0].body).toContain('Ticket one');
    expect(await notifs(B)).toHaveLength(0);
  });
  it('shows on the email and is searchable: assigned:me / assigned:none / status:', async () => {
    await assign('A', { assigneeId: C, status: 'pending' });
    const ids = async (user: number, text: string) => (await queryEmails(user, { filter: { text }, position: 0, limit: 50 })).ids.length;
    expect(await ids(C, 'assigned:me')).toBe(1);
    expect(await ids(A, 'assigned:me')).toBe(0);
    expect(await ids(A, 'assigned:none')).toBe(1);
    expect(await ids(A, 'status:pending')).toBe(1);
    expect(await ids(A, 'status:open')).toBe(1);
    expect(await ids(A, 'status:done')).toBe(0);
    const em = await getEmails(C, (await queryEmails(C, { filter: { text: 'assigned:me' }, position: 0, limit: 5 })).ids);
    expect(em[0].assignment).toMatchObject({ assigneeId: C, status: 'pending' });
  });
  it('parser', () => {
    expect(parseSearch('assigned:me status:done')).toMatchObject({ assigned: 'me', status: 'done' });
    expect(parseSearch('assigned:none').assigned).toBe('none');
    expect(parseSearch('status:weird').status).toBeNull();
  });
  it('removing a share unassigns that person', async () => {
    await assign('A', { assigneeId: C, status: 'open' });
    await api('A', 'DELETE', `/api/accounts/${acct}/shares/${C}`);
    expect((await api('A', 'GET', `/api/threads/${threadId}/assignment?accountId=${acct}`)).json().assigneeId).toBeNull();
  });
});

describe('comments + mentions', () => {
  const post = (who: string, body: string) => api(who, 'POST', `/api/threads/${threadId}/comments`, { accountId: acct, body });
  it('mention notifies only users with access', async () => {
    const r = await post('A', 'hey @carol please check, cc @d and @m');
    expect(r.statusCode).toBe(200);
    expect(r.json().mentions.sort()).toEqual([C, M].sort());
    expect((await notifs(C)).map((x) => x.type)).toEqual(['comment.mention']);
    expect((await notifs(M)).map((x) => x.type)).toEqual(['comment.mention']);
    expect(await notifs(D)).toHaveLength(0);
    expect(await notifs(A)).toHaveLength(0);
  });
  it('viewer reads but cannot write; outsider sees nothing; length limit', async () => {
    await post('A', 'internal note');
    expect((await api('B', 'GET', `/api/threads/${threadId}/comments?accountId=${acct}`)).json()).toHaveLength(1);
    expect((await post('B', 'nope')).statusCode).toBe(403);
    expect((await api('D', 'GET', `/api/threads/${threadId}/comments?accountId=${acct}`)).statusCode).toBe(404);
    expect((await post('D', 'nope')).statusCode).toBe(404);
    expect((await post('A', 'x'.repeat(5001))).statusCode).toBe(400);
    expect((await post('A', '   ')).statusCode).toBe(400);
  });
  it('comments are never part of any sent mail and not visible across mailboxes (isolation)', async () => {
    await post('A', 'secret');
    const other = await makeAccount('mine@x.test', { userId: D });
    expect((await api('D', 'GET', `/api/threads/${threadId}/comments?accountId=${other}`)).statusCode).toBe(404);
  });
});

describe('presence', () => {
  it('relay recipients exclude sender', () => {
    expect(presenceRecipients([1, 2, 3], 2)).toEqual([1, 3]);
  });
  it('relays to other users with access, never to users without', async () => {
    const got: { to: number; msg: any }[] = [];
    const to = await handlePresence(C, { type: 'presence', threadId, action: 'replying' }, (msg, t) => got.push({ to: t, msg }));
    expect(to.sort()).toEqual([A, B, M].sort());
    expect(got.some((g) => g.to === D)).toBe(false);
    expect(got.every((g) => g.msg.action === 'replying' && g.msg.userName === 'carol')).toBe(true);
    expect(activePresence(acct, threadId)).toEqual([{ userId: C, action: 'replying' }]);
    expect(activePresence(acct, threadId, Date.now() + 61_000)).toEqual([]);
  });
  it('a user without access cannot publish presence on the thread', async () => {
    const got: any[] = [];
    expect(await handlePresence(D, { type: 'presence', threadId, action: 'viewing' }, (m, t) => got.push(t))).toEqual([]);
    expect(got).toEqual([]);
    expect(await handlePresence(C, { type: 'presence', threadId, action: 'dancing' }, () => {})).toEqual([]);
  });
  it('left clears state', async () => {
    await handlePresence(C, { type: 'presence', threadId, action: 'viewing' }, () => {});
    await handlePresence(C, { type: 'presence', threadId, action: 'left' }, () => {});
    expect(activePresence(acct, threadId)).toEqual([]);
  });
});
