/** T4 F-32 part 1: shared mailbox access model. A owns, B is viewer, C responder, D has no share, M manager. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const sent: any[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({
    sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { q, one } = await import('../src/db.ts');
const { queryEmails, listMailboxes, getEmails, getThreadEmailIds } = await import('../src/mail/store.ts');
const { accessibleAccountIds, canRead, canSend, canManage } = await import('../src/auth/access.ts');
const { categoryOverview } = await import('../src/mail/categories.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

let app: Awaited<ReturnType<typeof makeApp>>;
let A: number, B: number, C: number, D: number, M: number;   // users
let acct: number, inbox: number, trash: number, archive: number, otherAcct: number;
let msgId: string; let rowId: number;
const ck: Record<string, string> = {};
const api = (who: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck[who] } });
const share = (userId: number, role: string) => api('A', 'PUT', `/api/accounts/${acct}/shares`, { userId, role });

beforeEach(async () => {
  await resetDb(); resetLimiters(); sent.length = 0;
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test'); C = await makeUser('c@x.test');
  D = await makeUser('d@x.test'); M = await makeUser('m@x.test');
  acct = await makeAccount('support@demo.test', { userId: A, name: 'Support' });
  otherAcct = await makeAccount('private@demo.test', { userId: A });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  await makeMailbox(acct, "Sent", "sent");
  trash = await makeMailbox(acct, 'Trash', 'trash');
  archive = await makeMailbox(acct, 'Archive', 'archive');
  const privInbox = await makeMailbox(otherAcct, 'INBOX', 'inbox');
  await ingest(otherAcct, privInbox, rawEmail({ from: 'x@ext.test', to: 'private@demo.test', subject: 'PRIVATE secret' }));
  const r = await ingest(acct, inbox, rawEmail({ from: 'cust@ext.test', to: 'support@demo.test', subject: 'Help with invoice' }));
  rowId = r!.rowId; msgId = `m${rowId}`;
  await ingest(acct, inbox, rawEmail({ from: 'cust2@ext.test', to: 'support@demo.test', subject: 'Second ticket' }));
  app = await makeApp();
  for (const [k, e] of Object.entries({ A: 'a@x.test', B: 'b@x.test', C: 'c@x.test', D: 'd@x.test', M: 'm@x.test' })) ck[k] = await login(app, e);
  const r1 = await share(B, 'viewer'); expect(r1.statusCode, r1.body).toBe(200);
  expect((await share(C, 'responder')).statusCode).toBe(200);
  expect((await share(M, 'manager')).statusCode).toBe(200);
});

describe('access helper', () => {
  it('reports roles', async () => {
    expect((await accessibleAccountIds(A)).map((x) => x.role)).toEqual(['owner', 'owner']);
    expect(await accessibleAccountIds(B)).toEqual([{ id: acct, role: 'viewer' }]);
    expect(await accessibleAccountIds(D)).toEqual([]);
    expect([await canRead(B, acct), await canSend(B, acct), await canManage(B, acct)]).toEqual([true, false, false]);
    expect([await canRead(C, acct), await canSend(C, acct), await canManage(C, acct)]).toEqual([true, true, false]);
    expect([await canRead(M, acct), await canSend(M, acct), await canManage(M, acct)]).toEqual([true, true, true]);
    expect([await canRead(D, acct), await canSend(D, acct), await canManage(D, acct)]).toEqual([false, false, false]);
    expect(await canRead(B, otherAcct)).toBe(false);
  });
});

describe('reads', () => {
  it('list: grantees see only the shared mailbox; D sees nothing', async () => {
    for (const u of [A, B, C, M]) {
      const r = await queryEmails(u, { filter: { inMailbox: 'u:inbox' }, position: 0, limit: 50 });
      expect(r.total).toBe(u === A ? 3 : 2);
    }
    expect((await queryEmails(D, { filter: { inMailbox: 'u:inbox' }, position: 0, limit: 50 })).total).toBe(0);
    const b = await queryEmails(B, { filter: { inMailbox: `mb:${inbox}` }, position: 0, limit: 50 });
    expect(b.total).toBe(2);
    expect((await queryEmails(D, { filter: { inMailbox: `mb:${inbox}` }, position: 0, limit: 50 })).total).toBe(0);
    expect((await queryEmails(B, { filter: { accountId: otherAcct }, position: 0, limit: 50 })).total).toBe(0);
  });

  it('search finds shared mail for grantees, never for D or across accounts', async () => {
    expect((await queryEmails(B, { filter: { text: 'invoice' }, position: 0, limit: 50 })).total).toBe(1);
    expect((await queryEmails(D, { filter: { text: 'invoice' }, position: 0, limit: 50 })).total).toBe(0);
    expect((await queryEmails(B, { filter: { text: 'PRIVATE' }, position: 0, limit: 50 })).total).toBe(0);
  });

  it('scopes: unified includes shared; shared:<id> only shared; account:<id> works for grantee; D gets nothing', async () => {
    expect((await queryEmails(B, { filter: { scope: `shared:${acct}` }, position: 0, limit: 50 })).total).toBe(2);
    expect((await queryEmails(B, { filter: { scope: `account:${acct}` }, position: 0, limit: 50 })).total).toBe(2);
    expect((await queryEmails(D, { filter: { scope: `shared:${acct}` }, position: 0, limit: 50 })).total).toBe(0);
    expect((await queryEmails(D, { filter: { scope: `account:${acct}` }, position: 0, limit: 50 })).total).toBe(0);
    // the owner cannot use shared: on their own mailbox, and B cannot reach a mailbox that isn't shared
    expect((await queryEmails(A, { filter: { scope: `shared:${acct}` }, position: 0, limit: 50 })).total).toBe(0);
    expect((await queryEmails(B, { filter: { scope: `shared:${otherAcct}` }, position: 0, limit: 50 })).total).toBe(0);
  });

  it('mailboxes + counts + switcher overview', async () => {
    const mbB = await listMailboxes(B);
    expect(mbB.filter((m) => m.accountId !== null).every((m) => m.accountId === acct && m.shared && m.sharedRole === 'viewer')).toBe(true);
    expect(mbB.find((m) => m.id === 'u:inbox')!.totalEmails).toBe(2);
    expect((await listMailboxes(D)).every((m) => m.accountId === null && m.totalEmails === 0)).toBe(true);
    const ov = await categoryOverview(B);
    expect(ov.shared.map((s) => [s.id, s.role, s.unread])).toEqual([[acct, 'viewer', 2]]);
    expect(ov.unifiedUnread).toBe(2);
    expect((await categoryOverview(D)).shared).toEqual([]);
    expect((await categoryOverview(A)).shared).toEqual([]);
  });

  it('getEmails / thread ids / body / blob / raw / original / tracking', async () => {
    expect((await getEmails(B, [msgId])).length).toBe(1);
    expect((await getEmails(D, [msgId])).length).toBe(0);
    expect((await getThreadEmailIds(B, (await getEmails(B, [msgId]))[0].threadId))).toEqual([msgId]);
    expect(await getThreadEmailIds(D, (await getEmails(B, [msgId]))[0].threadId)).toEqual([]);
    for (const [who, code] of [['A', 200], ['B', 200], ['C', 200], ['D', 404]] as const) {
      expect((await api(who, 'GET', `/api/message/${msgId}/body`)).statusCode, `body ${who}`).toBe(code);
      expect((await api(who, 'GET', `/api/message/${msgId}/original`)).statusCode, `original ${who}`).toBe(code);
      expect((await api(who, 'GET', `/api/raw/${msgId}`)).statusCode, `raw ${who}`).toBe(code);
    }
    expect((await api('D', 'GET', `/api/blob/${msgId}/0`)).statusCode).toBe(404);
  });

  it('JMAP: grantee sees shared mail, D sees nothing', async () => {
    const call = (who: string, name: string, args: any) => api(who, 'POST', '/jmap/api', { using: [], methodCalls: [[name, args, 'c']] });
    const rb = (await call('B', 'Email/query', { filter: { inMailbox: 'u:inbox' } })).json();
    const rd = (await call('D', 'Email/query', { filter: { inMailbox: 'u:inbox' } })).json();
    expect(rb.methodResponses[0][1].ids.length).toBe(2);
    expect(rd.methodResponses[0][1].ids.length).toBe(0);
    const g = (await call('D', 'Email/get', { ids: [msgId] })).json();
    expect(g.methodResponses[0][1].list).toEqual([]);
  });

  it('notes are private to each reader and need read access', async () => {
    expect((await api('B', 'PUT', `/api/message/${msgId}/note`, { body: 'b private' })).statusCode).toBe(200);
    await api('D', 'PUT', `/api/message/${msgId}/note`, { body: 'd sneaky' });
    expect(await one('SELECT 1 FROM notes WHERE user_id = ?', [D])).toBeUndefined();
    expect((await getEmails(B, [msgId]))[0].hasNote).toBe(true);
    expect((await getEmails(A, [msgId]))[0].hasNote).toBe(false);
    expect((await getEmails(C, [msgId]))[0].hasNote).toBe(false);
  });
});

describe('writes', () => {
  const writes: [string, (id: string) => [any, string, any?]][] = [
    ['bulk read', (id) => ['POST', '/api/bulk', { ids: [id], action: 'read' }]],
    ['bulk star', (id) => ['POST', '/api/bulk', { ids: [id], action: 'star' }]],
    ['bulk archive', (id) => ['POST', '/api/bulk', { ids: [id], action: 'archive' }]],
    ['bulk delete', (id) => ['POST', '/api/bulk', { ids: [id], action: 'delete' }]],
    ['block sender', (id) => ['POST', '/api/block-sender', { emailId: id }]],
    ['risk safe', (id) => ['POST', `/api/risk/${id}/safe`, {}]],
    ['risk report', (id) => ['POST', `/api/risk/${id}/report`, {}]],
    ['review resolve', (id) => ['POST', `/api/review/${id}/resolve`, {}]],
  ];

  it('viewer B: every write is 403 and nothing changes', async () => {
    for (const [name, mk] of writes) {
      const [m, u, b] = mk(msgId);
      expect((await api('B', m, u, b)).statusCode, name).toBe(403);
    }
    const row = await one<any>('SELECT unread, flagged, mailbox_id FROM messages WHERE id = ?', [rowId]);
    expect(row.unread).toBe(true); expect(row.flagged).toBe(false); expect(row.mailbox_id).toBe(inbox);
    const jm = await api('B', 'POST', '/jmap/api', { using: [], methodCalls: [['Email/set', { update: { [msgId]: { 'keywords/$seen': true } } }, 'c']] });
    const after = await one<any>('SELECT unread FROM messages WHERE id = ?', [rowId]);
    expect(after.unread).toBe(true);
    void jm;
  });

  it('user D: writes change nothing', async () => {
    for (const [, mk] of writes) { const [m, u, b] = mk(msgId); await api('D', m, u, b); }
    const row = await one<any>('SELECT unread, flagged, mailbox_id FROM messages WHERE id = ?', [rowId]);
    expect(row.unread).toBe(true); expect(row.flagged).toBe(false); expect(row.mailbox_id).toBe(inbox);
  });

  it('responder C can mark read, star, archive, delete', async () => {
    expect((await api('C', 'POST', '/api/bulk', { ids: [msgId], action: 'read' })).statusCode).toBe(200);
    expect((await one<any>('SELECT unread FROM messages WHERE id = ?', [rowId])).unread).toBe(false);
    expect((await api('C', 'POST', '/api/bulk', { ids: [msgId], action: 'star' })).statusCode).toBe(200);
    expect((await api('C', 'POST', '/api/bulk', { ids: [msgId], action: 'archive' })).statusCode).toBe(200);
    expect((await one<any>('SELECT mailbox_id FROM messages WHERE id = ?', [rowId])).mailbox_id).toBe(archive);
    expect((await api('C', 'POST', '/api/bulk', { ids: [msgId], action: 'delete' })).statusCode).toBe(200);
    expect((await one<any>('SELECT mailbox_id FROM messages WHERE id = ?', [rowId])).mailbox_id).toBe(trash);
  });

  it('manager M can write too', async () => {
    expect((await api('M', 'POST', '/api/bulk', { ids: [msgId], action: 'read' })).statusCode).toBe(200);
  });

  it('grantees cannot label shared mail (labels are personal in T4)', async () => {
    const lab = (await api('C', 'POST', '/api/labels', { name: 'Mine' })).json().id;
    expect((await api('C', 'POST', '/api/bulk', { ids: [msgId], action: 'label', value: lab })).statusCode).toBe(403);
    expect(await q('SELECT 1 FROM message_labels WHERE message_id = ?', [rowId])).toEqual([]);
  });
});

describe('sending as the shared identity', () => {
  const payload = () => ({
    accountId: acct, fromEmail: 'support@demo.test', to: [{ name: '', email: 'cust@ext.test' }], cc: [], bcc: [],
    subject: 'Re: Help with invoice', html: '<p>on it</p>', attachmentIds: [], track: false, replyToEmailId: msgId,
  });

  it('responder C sends from the shared address; Sent copy lands with the owner', async () => {
    await api('C', 'PUT', '/api/prefs', { undo_send_seconds: '0' }).catch(() => {});
    const { run } = await import('../src/db.ts');
    await run("INSERT INTO user_settings(user_id, key, value) VALUES (?, 'undo_send_seconds', '0') ON CONFLICT (user_id, key) DO UPDATE SET value = '0'", [C]).catch(() => {});
    const res = await api('C', 'POST', '/api/send', payload());
    expect(res.statusCode, res.body).toBe(200);
    expect(sent.length).toBe(1);
    expect(String(sent[0].envelope?.from ?? sent[0].from?.address ?? sent[0].raw ?? '')).toContain('support@demo.test');
    // the Sent copy is queued for the shared account (it lives with the owner's mailbox)
    const ops = await q<any>("SELECT account_id, payload FROM op_queue WHERE op = 'append'");
    expect(ops.length).toBe(1); expect(ops[0].account_id).toBe(acct);
    // the original is marked answered (acting as the owner on the shared row)
    expect((await one<any>('SELECT answered FROM messages WHERE id = ?', [rowId])).answered).toBe(true);
  });

  it('viewer B gets 403 on send, draft and schedule; D is refused', async () => {
    expect((await api('B', 'POST', '/api/send', payload())).statusCode).toBe(403);
    expect((await api('B', 'POST', '/api/draft', payload())).statusCode).toBe(403);
    expect((await api('B', 'POST', '/api/schedule', { ...payload(), sendAt: Date.now() + 3600_000 })).statusCode).toBe(403);
    expect((await api('D', 'POST', '/api/send', payload())).statusCode).not.toBe(200);
    expect(sent.length).toBe(0);
  });
});

describe('revoking and sharing rules', () => {
  it('revoking removes access immediately', async () => {
    expect((await queryEmails(C, { filter: {}, position: 0, limit: 50 })).total).toBe(2);
    expect((await api('A', 'DELETE', `/api/accounts/${acct}/shares/${C}`)).statusCode).toBe(200);
    expect((await queryEmails(C, { filter: {}, position: 0, limit: 50 })).total).toBe(0);
    expect((await api('C', 'GET', `/api/message/${msgId}/body`)).statusCode).toBe(404);
    expect((await api('C', 'POST', '/api/bulk', { ids: [msgId], action: 'read' })).statusCode).toBe(200); // silently affects nothing
    expect((await one<any>('SELECT unread FROM messages WHERE id = ?', [rowId])).unread).toBe(true);
    expect((await api('C', 'POST', '/api/send', { accountId: acct, fromEmail: 'support@demo.test', to: [{ name: '', email: 'x@y.test' }], cc: [], bcc: [], subject: 's', html: 'h', attachmentIds: [], track: false })).statusCode).not.toBe(200);
  });

  it('changing the role takes effect at once', async () => {
    await share(B, 'responder');
    expect((await api('B', 'POST', '/api/bulk', { ids: [msgId], action: 'read' })).statusCode).toBe(200);
    await share(B, 'viewer');
    expect((await api('B', 'POST', '/api/bulk', { ids: [msgId], action: 'star' })).statusCode).toBe(403);
  });

  it('only the owner (or an admin) manages shares', async () => {
    expect((await api('B', 'PUT', `/api/accounts/${acct}/shares`, { userId: D, role: 'viewer' })).statusCode).toBe(404);
    expect((await api('M', 'PUT', `/api/accounts/${acct}/shares`, { userId: D, role: 'viewer' })).statusCode).toBe(404);
    expect((await api('D', 'GET', `/api/accounts/${acct}/shares`)).statusCode).toBe(404);
    expect((await api('B', 'DELETE', `/api/accounts/${acct}/shares/${C}`)).statusCode).toBe(404);
    expect(await canRead(D, acct)).toBe(false);
    expect(await canRead(C, acct)).toBe(true);
  });

  it('validation: bad role, sharing with the owner, unknown user', async () => {
    expect((await share(D, 'owner')).statusCode).toBe(400);
    expect((await share(A, 'viewer')).statusCode).toBe(400);
    expect((await share(99999, 'viewer')).statusCode).toBe(400);
  });

  it('GET /api/shares shows what you share and what is shared with you; nobody else’s', async () => {
    const a = (await api('A', 'GET', '/api/shares')).json();
    const mine = a.owned.find((o: any) => o.accountId === acct);
    expect(mine.shares.map((s: any) => [s.email, s.role]).sort()).toEqual([['b@x.test', 'viewer'], ['c@x.test', 'responder'], ['m@x.test', 'manager']]);
    expect(a.sharedWithMe).toEqual([]);
    const b = (await api('B', 'GET', '/api/shares')).json();
    expect(b.owned).toEqual([]);
    expect(b.sharedWithMe.map((s: any) => [s.accountId, s.role])).toEqual([[acct, 'viewer']]);
    const d = (await api('D', 'GET', '/api/shares')).json();
    expect(d.owned).toEqual([]); expect(d.sharedWithMe).toEqual([]);
  });

  it('deleting the user or the mailbox drops the share', async () => {
    const { run } = await import('../src/db.ts');
    await run('DELETE FROM users WHERE id = ?', [B]);
    expect(await q('SELECT 1 FROM mailbox_shares WHERE user_id = ?', [B])).toEqual([]);
    await run('DELETE FROM accounts WHERE id = ?', [acct]);
    expect(await q('SELECT 1 FROM mailbox_shares')).toEqual([]);
  });
});
