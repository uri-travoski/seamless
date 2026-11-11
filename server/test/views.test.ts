/** T4 F-34: search operators, saved views, counts, notify-on-match, isolation. */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const { q, run, one } = await import('../src/db.ts');
const { queryEmails } = await import('../src/mail/store.ts');
const { parseSearch, parseDuration, parseSize } = await import('../src/mail/searchparse.ts');
const { notifyViewMatches, clearViewCounts } = await import('../src/mail/views.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

const DAY = 86_400_000;

describe('operator parser', () => {
  it('opened / replied', () => {
    expect(parseSearch('opened:yes').opened).toBe(true);
    expect(parseSearch('opened:no').opened).toBe(false);
    expect(parseSearch('replied:no').replied).toBe(false);
    expect(parseSearch('replied:maybe').replied).toBeNull();
  });
  it('older_than / newer_than units', () => {
    expect(parseSearch('older_than:7d').olderThanMs).toBe(7 * DAY);
    expect(parseSearch('older_than:2w').olderThanMs).toBe(14 * DAY);
    expect(parseSearch('newer_than:3m').newerThanMs).toBe(90 * DAY);
    expect(parseSearch('newer_than:1y').newerThanMs).toBe(365 * DAY);
    expect(parseDuration('x')).toBeNull();
  });
  it('size> and size<', () => {
    expect(parseSearch('size>5mb').sizeMin).toBe(5 * 1024 * 1024);
    expect(parseSearch('size<100kb').sizeMax).toBe(100 * 1024);
    expect(parseSize('2gb')).toBe(2 * 1024 ** 3);
    expect(parseSearch('size>5mb invoice').fts).toBe("'invoice':*");
  });
  it('is:waiting / is:snoozed', () => {
    expect(parseSearch('is:waiting').waiting).toBe(true);
    expect(parseSearch('is:snoozed').snoozed).toBe(true);
  });
});

let A: number, B: number, acct: number, inbox: number, sent: number, acctB: number, inboxB: number;
let app: Awaited<ReturnType<typeof makeApp>>;
let cka = '', ckb = '';
const api = (ck: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck } });
const list = async (uid: number, text: string) => (await queryEmails(uid, { filter: { text }, position: 0, limit: 100 })).ids;
const subj = async (ids: string[]) => (await q<any>('SELECT subject FROM messages WHERE id = ANY(?::int[]) ORDER BY subject', [ids.map((i) => Number(i.slice(1)))])).map((r: any) => r.subject);

beforeEach(async () => {
  await resetDb(); resetLimiters(); clearViewCounts();
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test');
  acct = await makeAccount('a@demo.test', { userId: A });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  sent = await makeMailbox(acct, 'Sent', 'sent');
  acctB = await makeAccount('b@demo.test', { userId: B });
  inboxB = await makeMailbox(acctB, 'INBOX', 'inbox');
  app = await makeApp();
  cka = await login(app, 'a@x.test'); ckb = await login(app, 'b@x.test');
});

async function add(subject: string, opts: { box?: number; from?: string; ageDays?: number; size?: number; acc?: number } = {}) {
  const r = await ingest(opts.acc ?? acct, opts.box ?? inbox, rawEmail({ from: opts.from ?? 'x@ext.test', to: 'a@demo.test', subject }));
  if (opts.ageDays !== undefined) await run('UPDATE messages SET date = ?, sort_date = ? WHERE id = ?', [Date.now() - opts.ageDays * DAY, Date.now() - opts.ageDays * DAY, r!.rowId]);
  if (opts.size !== undefined) await run('UPDATE messages SET size = ? WHERE id = ?', [opts.size, r!.rowId]);
  return r!.rowId;
}

describe('operators against the database', () => {
  it('older_than / newer_than', async () => {
    await add('old', { ageDays: 20 }); await add('mid', { ageDays: 5 }); await add('new', { ageDays: 0 });
    expect(await subj(await list(A, 'older_than:2w'))).toEqual(['old']);
    expect(await subj(await list(A, 'newer_than:7d'))).toEqual(['mid', 'new']);
  });
  it('size>/size<', async () => {
    await add('big', { size: 6 * 1024 * 1024 }); await add('small', { size: 50 * 1024 });
    expect(await subj(await list(A, 'size>5mb'))).toEqual(['big']);
    expect(await subj(await list(A, 'size<100kb'))).toEqual(['small']);
  });
  it('opened:yes|no only looks at tracked mail and ignores proxy opens', async () => {
    const o = await add('opened', { box: sent }); const n = await add('unopened', { box: sent }); const px = await add('proxy-only', { box: sent });
    await add('plain', { box: sent });
    await run("UPDATE messages SET tracking_token = 'tok-o' WHERE id = ?", [o]);
    await run("UPDATE messages SET tracking_token = 'tok-n' WHERE id = ?", [n]);
    await run("UPDATE messages SET tracking_token = 'tok-p' WHERE id = ?", [px]);
    await run("INSERT INTO tracked_sends(token, user_id, message_id, group_token, recipient, subject, sent_at) VALUES ('tok-o-r1', ?, ?, 'tok-o', 'r@x.test', 's', 1)", [A, o]);
    await run("INSERT INTO tracking_opens(token, ts, proxied) VALUES ('tok-o-r1', 1, false), ('tok-p', 1, true)");
    expect(await subj(await list(A, 'in:sent opened:yes'))).toEqual(['opened']);
    expect(await subj(await list(A, 'in:sent opened:no'))).toEqual(['proxy-only', 'unopened']);
  });
  it('replied:yes|no via $answered or a later message from someone else in the thread', async () => {
    const a = await add('answered-flag'); await run('UPDATE messages SET answered = true WHERE id = ?', [a]);
    const t = await ingest(acct, inbox, rawEmail({ from: 'c@ext.test', to: 'a@demo.test', subject: 'threaded', messageId: '<t1@x>' }));
    await run('UPDATE messages SET date = ? WHERE id = ?', [Date.now() - 2 * DAY, t!.rowId]);
    const rep = await ingest(acct, sent, rawEmail({ from: 'a@demo.test', to: 'c@ext.test', subject: 'Re: threaded', inReplyTo: '<t1@x>', references: ['<t1@x>'] }));
    await run('UPDATE messages SET date = ? WHERE id = ?', [Date.now() - DAY, rep!.rowId]);
    await add('lonely');
    const yes = await subj(await list(A, 'in:inbox replied:yes'));
    expect(yes).toEqual(['answered-flag', 'threaded']);
    expect(await subj(await list(A, 'in:inbox replied:no'))).toEqual(['lonely']);
  });
  it('is:waiting and is:snoozed', async () => {
    const w = await add('waiting-one', { box: sent }); await add('other', { box: sent });
    await run("INSERT INTO followups(user_id, message_id, due_at, created_at, status) VALUES (?,?,?,?, 'waiting')", [A, w, Date.now() + DAY, Date.now()]);
    expect(await subj(await list(A, 'in:sent is:waiting'))).toEqual(['waiting-one']);
    const s = await add('sleepy'); await add('awake');
    await run('UPDATE messages SET snoozed_until = ? WHERE id = ?', [Date.now() + DAY, s]);
    expect(await subj(await list(A, 'is:snoozed'))).toEqual(['sleepy']);
  });
  it('existing operators still combine (category / risk / business / assigned / status stay parsed)', () => {
    const p = parseSearch('category:work business:"Acme Co" risk:high assigned:me status:open');
    expect([p.category, p.business, p.risk, p.assigned, p.status]).toEqual(['work', 'Acme Co', 'high', 'me', 'open']);
  });
});

describe('saved views API', () => {
  it('CRUD + reorder + suggestions', async () => {
    const r1 = await api(cka, 'POST', '/api/views', { name: 'Big', query: 'size>5mb', icon: 'paperclip', color: '#ff0000' }); const v1 = r1.json();
    const v2 = (await api(cka, 'POST', '/api/views', { name: 'Old', query: 'older_than:1y' })).json();
    expect(v1.name).toBe('Big'); expect(v2.sortOrder).toBeGreaterThan(v1.sortOrder);
    expect((await api(cka, 'POST', '/api/views', { name: '', query: 'x' })).statusCode).toBe(400);
    const ord = (await api(cka, 'PUT', '/api/views/order', { ids: [v2.id, v1.id] })).json();
    expect(ord.map((v: any) => v.name)).toEqual(['Old', 'Big']);
    const up = (await api(cka, 'PUT', `/api/views/${v1.id}`, { name: 'Huge', pinned: false })).json();
    expect(up.name).toBe('Huge'); expect(up.pinned).toBe(false);
    const sug = (await api(cka, 'GET', '/api/views/suggestions')).json();
    expect(sug.length).toBeGreaterThan(0);
    expect(sug.some((s: any) => s.query === 'size>5mb')).toBe(false); // already saved: not suggested
    await api(cka, 'POST', '/api/views/suggestions/dismiss');
    expect((await api(cka, 'GET', '/api/views/suggestions')).json()).toEqual([]);
    expect((await api(cka, 'DELETE', `/api/views/${v2.id}`)).statusCode).toBe(200);
    expect((await api(cka, 'GET', '/api/views')).json()).toHaveLength(1);
  });

  it('counts equal the list length and are cached for 30 s', async () => {
    await add('one', { size: 6 * 1024 * 1024 }); await add('two', { size: 7 * 1024 * 1024 }); await add('three', { size: 10 });
    const v = (await api(cka, 'POST', '/api/views', { name: 'Big', query: 'size>5mb' })).json();
    const hidden = (await api(cka, 'POST', '/api/views', { name: 'NoCount', query: 'size>5mb', showCount: false })).json();
    const counts = (await api(cka, 'GET', '/api/views/counts')).json();
    expect(counts[String(v.id)]).toBe(2);
    expect(counts[String(v.id)]).toBe((await list(A, 'size>5mb')).length);
    expect(counts[String(hidden.id)]).toBeUndefined();
    await add('four', { size: 8 * 1024 * 1024 });
    expect((await api(cka, 'GET', '/api/views/counts')).json()[String(v.id)]).toBe(2); // cached
    clearViewCounts();
    expect((await api(cka, 'GET', '/api/views/counts')).json()[String(v.id)]).toBe(3);
  });

  it('isolation: B cannot see, edit, delete or count A\'s views, and A\'s mail is not in B\'s counts', async () => {
    const v = (await api(cka, 'POST', '/api/views', { name: 'Mine', query: 'older_than:1d' })).json();
    await add('old', { ageDays: 3 });
    expect((await api(ckb, 'GET', '/api/views')).json()).toEqual([]);
    expect((await api(ckb, 'PUT', `/api/views/${v.id}`, { name: 'Hacked' })).statusCode).toBe(404);
    expect((await api(ckb, 'DELETE', `/api/views/${v.id}`)).statusCode).toBe(404);
    await api(ckb, 'PUT', '/api/views/order', { ids: [v.id] });
    expect((await one<any>('SELECT sort_order, name FROM saved_views WHERE id = ?', [v.id]))).toMatchObject({ name: 'Mine' });
    const vb = (await api(ckb, 'POST', '/api/views', { name: 'Theirs', query: 'older_than:1d' })).json();
    expect((await api(ckb, 'GET', '/api/views/counts')).json()[String(vb.id)]).toBe(0);
    expect((await api(cka, 'GET', '/api/views/counts')).json()[String(v.id)]).toBe(1);
  });
});

describe('notify on match', () => {
  it('fires once per message per view, only for matches, only for views with notify', async () => {
    const vn = (await api(cka, 'POST', '/api/views', { name: 'Big mail', query: 'size>5mb', notify: true })).json();
    await api(cka, 'POST', '/api/views', { name: 'Silent', query: 'size>5mb', notify: false });
    const big = await add('big', { size: 6 * 1024 * 1024 });
    const small = await add('small', { size: 10 });
    expect(await notifyViewMatches(A, small)).toBe(0);
    expect(await notifyViewMatches(A, big)).toBe(1);
    expect(await notifyViewMatches(A, big)).toBe(0); // same message again: nothing
    const n = await q<any>("SELECT type, title, body FROM notifications WHERE user_id = ? AND type = 'view.match'", [A]);
    expect(n).toHaveLength(1);
    expect(n[0].title).toContain('Big mail');
    expect(n[0].body).toContain('big');
    expect(vn.notify).toBe(true);
  });
  it('does not notify for mail that predates the view, or for another user\'s views', async () => {
    const old = await add('old big', { size: 9 * 1024 * 1024 });
    await api(cka, 'POST', '/api/views', { name: 'Big', query: 'size>5mb', notify: true });
    expect(await notifyViewMatches(A, old)).toBe(0);
    await api(ckb, 'POST', '/api/views', { name: 'B big', query: 'size>5mb', notify: true });
    const fresh = await add('fresh big', { size: 9 * 1024 * 1024 });
    expect(await notifyViewMatches(A, fresh)).toBe(1);
    expect(await q("SELECT 1 FROM notifications WHERE user_id = ?", [B])).toHaveLength(0);
  });
});
