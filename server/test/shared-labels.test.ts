/** T8.2: shared labels — offer → pending → accept / reject / later; apply by responders; isolation. */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const { q, one } = await import('../src/db.ts');
const { queryEmails, getEmails } = await import('../src/mail/store.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

let app: Awaited<ReturnType<typeof makeApp>>;
let A: number, B: number, C: number, D: number;      // A owns, B responder, C viewer, D no share
let acct: number, other: number, msgId: string, otherMsg: string;
let work: number, secret: number;
const ck: Record<string, string> = {};
const api = (who: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck[who] } });
const offer = (userId: number, extra: any = {}) => api('A', 'PUT', `/api/accounts/${acct}/shares`, { userId, role: 'responder', shareLabels: true, ...extra });
const respond = (who: string, action: string) => api(who, 'POST', `/api/labels/shared/${acct}/respond`, { action });
const notifs = async (userId: number) => q<any>("SELECT * FROM events WHERE user_id = ? AND type = 'labels.offered'", [userId]);
const labelIds = async (who: string) => ((await api(who, 'GET', '/api/labels')).json() as any[]).map((l) => l.id);

beforeEach(async () => {
  await resetDb(); resetLimiters();
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test'); C = await makeUser('c@x.test'); D = await makeUser('d@x.test');
  acct = await makeAccount('support@demo.test', { userId: A, name: 'Support' });
  other = await makeAccount('private@demo.test', { userId: A });
  const inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  const oinbox = await makeMailbox(other, 'INBOX', 'inbox');
  msgId = `m${(await ingest(acct, inbox, rawEmail({ from: 'c@ext.test', to: 'support@demo.test', subject: 'Invoice help' })))!.rowId}`;
  otherMsg = `m${(await ingest(other, oinbox, rawEmail({ from: 'c@ext.test', to: 'private@demo.test', subject: 'Private' })))!.rowId}`;
  app = await makeApp();
  for (const [k, e] of Object.entries({ A: 'a@x.test', B: 'b@x.test', C: 'c@x.test', D: 'd@x.test' })) ck[k] = await login(app, e);
  work = (await api('A', 'POST', '/api/labels', { name: 'Work', color: '#336699' })).json().id;
  secret = (await api('A', 'POST', '/api/labels', { name: 'Secret' })).json().id;
  { const r = await api("A", "PUT", `/api/accounts/${acct}/shares`, { userId: C, role: "viewer", shareLabels: true, labelIds: [work] }); expect(r.statusCode, r.body).toBe(200); }
  expect((await offer(B, { labelIds: [work] })).statusCode).toBe(200);
});

describe('offer and answer', () => {
  it('starts pending, notifies once, and hides the labels until accepted', async () => {
    expect((await api('B', 'GET', '/api/labels/shared')).json()).toMatchObject([{ accountId: acct, status: 'pending', count: 1, owner: 'a@x.test', labels: [{ name: 'Work' }] }]);
    expect(await labelIds('B')).toEqual([]);
    await offer(B, { labelIds: [work] }); await offer(B, { labelIds: [work, secret] });   // saving again does not re-notify
    expect(await notifs(B)).toHaveLength(1);
    expect(await q('SELECT 1 FROM notifications WHERE user_id = ?', [B]).then((r) => r.length)).toBe(1);
  });

  it('accept shows read-only shared labels; they cannot be edited or deleted by B', async () => {
    expect((await respond('B', 'accept')).statusCode).toBe(200);
    const list = (await api('B', 'GET', '/api/labels')).json();
    expect(list).toMatchObject([{ id: work, name: 'Work', shared: true, sharedBy: expect.any(String) }]);
    expect((await api('B', 'PUT', `/api/labels/${work}`, { name: 'Hacked' })).statusCode).toBe(404);
    await api('B', 'DELETE', `/api/labels/${work}`);
    expect(await one('SELECT name FROM labels WHERE id = ?', [work])).toMatchObject({ name: 'Work' });
  });

  it('reject and decide-later keep the labels hidden; later keeps it pending; changing mind works', async () => {
    expect((await respond('B', 'later')).statusCode).toBe(200);
    expect((await api('B', 'GET', '/api/labels/shared')).json()[0]).toMatchObject({ status: 'pending' });
    expect((await api('B', 'GET', '/api/labels/shared')).json()[0].hideBannerUntil).toBeGreaterThan(Date.now());
    expect(await labelIds('B')).toEqual([]);
    await respond('B', 'reject');
    expect((await api('B', 'GET', '/api/labels/shared')).json()[0]).toMatchObject({ status: 'rejected' });
    expect(await labelIds('B')).toEqual([]);
    await respond('B', 'accept');
    expect(await labelIds('B')).toEqual([work]);
    await respond('B', 'leave');
    expect(await labelIds('B')).toEqual([]);
  });

  it('owner sees who accepted and can stop sharing; labels stay on the messages for the owner', async () => {
    await respond('B', 'accept');
    await api('B', 'POST', '/api/bulk', { ids: [msgId], action: 'label', value: work });
    const shares = (await api('A', 'GET', `/api/accounts/${acct}/shares`)).json();
    expect(shares.find((s: any) => s.userId === B)).toMatchObject({ labelsStatus: 'accepted', labelIds: [work] });
    await api('A', 'PUT', `/api/accounts/${acct}/shares`, { userId: B, role: 'responder', shareLabels: false });
    expect(await labelIds('B')).toEqual([]);
    expect((await api('A', 'GET', `/api/accounts/${acct}/shares`)).json().find((s: any) => s.userId === B)).toMatchObject({ labelsStatus: 'none', labelsShared: false });
    expect(await q('SELECT 1 FROM message_labels WHERE message_id = ? AND label_id = ?', [Number(msgId.slice(1)), work])).toHaveLength(1);
    expect((await api('B', 'GET', '/api/labels/shared')).json()).toEqual([]);
  });
});

describe('applying', () => {
  it('responder who accepted can add and remove; A and C see B\'s label; owner\'s other labels survive', async () => {
    await api('A', 'POST', '/api/bulk', { ids: [msgId], action: 'label', value: secret });
    await respond('B', 'accept'); await respond('C', 'accept');
    expect((await api('B', 'POST', '/api/bulk', { ids: [msgId], action: 'label', value: work })).statusCode).toBe(200);
    const uids: Record<string, number> = { A, B, C };
    const lab = async (who: string) => (await getEmails(uids[who], [msgId]))[0]?.labelIds;
    expect(await lab('A')).toEqual(expect.arrayContaining([work, secret]));
    expect(await lab('C')).toEqual([work]);                   // C only sees what was shared with C
    expect(await lab('B')).toEqual([work]);
    expect((await api('B', 'POST', '/api/bulk', { ids: [msgId], action: 'unlabel', value: work })).statusCode).toBe(200);
    expect(await q('SELECT label_id FROM message_labels WHERE message_id = ?', [Number(msgId.slice(1))])).toEqual([{ label_id: secret }]);
  });

  it('viewer cannot apply; unaccepted/rejected cannot apply; unshared label cannot be applied', async () => {
    await respond('C', 'accept');
    expect((await api('C', 'POST', '/api/bulk', { ids: [msgId], action: 'label', value: work })).statusCode).toBe(403);
    expect((await api('B', 'POST', '/api/bulk', { ids: [msgId], action: 'label', value: work })).statusCode).toBe(403);   // pending
    await respond('B', 'accept');
    expect((await api('B', 'POST', '/api/bulk', { ids: [msgId], action: 'label', value: secret })).statusCode).toBe(403);  // not in the picked set
    expect(await q('SELECT 1 FROM message_labels')).toEqual([]);
  });

  it('cannot apply a shared label to mail outside that shared mailbox', async () => {
    await respond('B', 'accept');
    expect((await api('B', 'POST', '/api/bulk', { ids: [otherMsg], action: 'label', value: work })).json().affected).toBe(0);
    expect(await q('SELECT 1 FROM message_labels')).toEqual([]);
  });
});

describe('search and isolation', () => {
  it('label: search works for B only for shared labels', async () => {
    await api('A', 'POST', '/api/bulk', { ids: [msgId], action: 'label', value: secret });
    await respond('B', 'accept');
    await api('B', 'POST', '/api/bulk', { ids: [msgId], action: 'label', value: work });
    const uids: Record<string, number> = { A, B };
    const search = async (who: string, text: string, label?: number) => (await queryEmails(uids[who], { filter: { text: text || undefined, label }, position: 0, limit: 20 } as any)).ids;
    expect(await search('B', 'label:Work')).toEqual([msgId]);
    expect(await search('B', 'label:Secret')).toEqual([]);
    expect(await search('B', '', work)).toEqual([msgId]);
    expect(await search('B', '', secret)).toEqual([]);
    expect(await search('A', 'label:Secret')).toEqual([msgId]);
  });

  it('a user with no share sees nothing and cannot respond', async () => {
    expect((await api('D', 'GET', '/api/labels/shared')).json()).toEqual([]);
    expect(await labelIds('D')).toEqual([]);
    expect((await respond('D', 'accept')).statusCode).toBe(404);
    expect(await q('SELECT labels_status FROM mailbox_shares WHERE user_id = ?', [D])).toEqual([]);
    expect((await api('D', 'POST', '/api/bulk', { ids: [msgId], action: 'label', value: work })).json().affected).toBe(0);
    expect(await q('SELECT 1 FROM message_labels')).toEqual([]);
  });

  it('only the owner (or admin) can offer labels; offered labels must be the owner\'s', async () => {
    expect((await api('B', 'PUT', `/api/accounts/${acct}/shares`, { userId: D, role: 'viewer', shareLabels: true })).statusCode).toBe(404);
    const foreign = (await api('B', 'POST', '/api/labels', { name: 'Bs' })).json().id;
    await api('A', 'PUT', `/api/accounts/${acct}/shares`, { userId: B, role: 'responder', shareLabels: true, labelIds: [foreign] });
    expect(await q('SELECT 1 FROM shared_label_offers WHERE label_id = ?', [foreign])).toEqual([]);
  });

  it('removing the share removes the offer', async () => {
    await respond('B', 'accept');
    await api('A', 'DELETE', `/api/accounts/${acct}/shares/${B}`);
    expect(await labelIds('B')).toEqual([]);
    expect(await q('SELECT 1 FROM shared_label_offers WHERE user_id = ?', [B])).toEqual([]);
  });
});
