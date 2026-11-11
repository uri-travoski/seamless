import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, makeUser, TEST_USER, rawEmail } from './helpers.ts';
import { handleEmail, disposedList, clearDisposedCache, type Env, type InboundMessage } from '../../workers/inbound/src/index.ts';

const { q, one, run } = await import('../src/db.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');
const { sign } = await import('../src/transport/inbound/push.ts');
const { syncManager } = await import('../src/imap/sync.ts');
const { runDueJobs } = await import('../src/jobs/runner.ts');
const { matchReplyIdentity } = await import('../src/mail/replyfrom.ts');
const { generateLocalPart } = await import('../src/mail/disposable.ts');

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let inbox: { token: string; secret: string; accountId: number };

const post = (raw: Buffer, rcpt: string) => {
  const ts = String(Date.now());
  return app.inject({
    method: 'POST', url: `/api/ingest/${inbox.token}`, payload: raw,
    headers: { 'content-type': 'message/rfc822', 'x-seamless-timestamp': ts, 'x-seamless-rcpt': rcpt, 'x-seamless-signature': sign(inbox.secret, ts, raw) },
  });
};
const mail = (to: string, from = 'News <news@shop.test>', subject = 'Hello') => rawEmail({ from, to, subject });
const create = async (payload: any = {}, c = cookie) =>
  app.inject({ method: 'POST', url: '/api/disposable', headers: { cookie: c }, payload: { domain: 'push.test', ...payload } });
const act = (id: number, action: string, c = cookie) => app.inject({ method: 'POST', url: `/api/disposable/${id}/${action}`, headers: { cookie: c } });

beforeEach(async () => {
  await resetDb(); resetLimiters(); clearDisposedCache();
  app = await makeApp();
  cookie = await login(app);
  const res = await app.inject({ method: 'POST', url: '/api/push-inboxes', headers: { cookie }, payload: { name: 'Push', email: 'me@push.test', domains: ['push.test'] } });
  const j = res.json();
  inbox = { token: j.token, secret: j.secret, accountId: j.accountId };
});
afterEach(() => { syncManager.removeAllListeners('newMail'); });

describe('generators', () => {
  it('random is 6 chars a-z0-9, words is two words, prefix gets 2 chars', () => {
    expect(generateLocalPart('random')).toMatch(/^[a-z0-9]{6}$/);
    expect(generateLocalPart('words')).toMatch(/^[a-z]+\.[a-z]+$/);
    expect(generateLocalPart('prefix', 'Bunnings')).toMatch(/^bunnings\.[a-z0-9]{2}$/);
  });
});

describe('create / receive', () => {
  it('creates on a push domain, rejects other domains; mail shows with the chip and is searchable as is:disposable', async () => {
    expect((await create({ domain: 'nope.test' })).statusCode).toBe(400);
    const res = await create({ generator: 'prefix', prefix: 'bunnings', label: 'Bunnings newsletter' });
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.address).toMatch(/^bunnings\.[a-z0-9]{2}@push\.test$/);
    const seen: any[] = [];
    syncManager.on('newMail', (e) => seen.push(e));
    const r = await post(mail(d.address), d.address);
    expect(r.statusCode).toBe(202);
    const list = (await app.inject({ method: 'GET', url: '/api/disposable', headers: { cookie } })).json();
    expect(list.addresses[0]).toMatchObject({ receivedCount: 1, signupDomain: 'shop.test', lastSender: 'news@shop.test' });
    expect(list.domains).toEqual([{ accountId: inbox.accountId, domain: 'push.test' }]);
    const row = await one<any>('SELECT disposable_id FROM messages WHERE id = ?', [r.json().id]);
    expect(row.disposable_id).toBe(d.id);
    expect(seen).toHaveLength(1);
    const { getEmails } = await import('../src/mail/store.ts');
    const [email] = await getEmails(TEST_USER, [`m${r.json().id}`]);
    expect(email.disposable).toMatchObject({ id: d.id, label: 'Bunnings newsletter', status: 'active' });
    const { queryEmails } = await import('../src/mail/store.ts');
    expect((await queryEmails(TEST_USER, { filter: { text: 'is:disposable' }, position: 0, limit: 10 })).ids).toEqual([`m${r.json().id}`]);
    expect((await queryEmails(TEST_USER, { filter: { text: `disposable:${d.id + 1}` }, position: 0, limit: 10 })).ids).toEqual([]);
  });

  it('dispose → next message dropped at the endpoint (counted), no newMail; undo restores', async () => {
    const d = (await create({ label: 'x' })).json();
    expect((await post(mail(d.address), d.address)).statusCode).toBe(202);
    expect((await act(d.id, 'dispose')).json().status).toBe('disposed');
    const seen: any[] = [];
    syncManager.on('newMail', (e) => seen.push(e));
    const r = await post(mail(d.address, 'a@b.test', 'second'), d.address);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ dropped: true, reason: 'disposed' });
    expect(seen).toHaveLength(0);
    expect((await q('SELECT 1 FROM messages WHERE subject = ?', ['second']))).toHaveLength(0);
    expect((await one<any>('SELECT dropped_count, received_count FROM disposable_addresses WHERE id = ?', [d.id]))).toMatchObject({ dropped_count: 1, received_count: 1 });
    // undo within 30 days; not after
    expect((await act(d.id, 'undispose')).json().status).toBe('active');
    await act(d.id, 'dispose');
    await run('UPDATE disposable_addresses SET disposed_at = ? WHERE id = ?', [Date.now() - 31 * 86_400_000, d.id]);
    expect((await act(d.id, 'undispose')).statusCode).toBe(409);
  });

  it('paused → stored, read, out of the Inbox, no newMail; resume delivers again', async () => {
    const d = (await create()).json();
    await act(d.id, 'pause');
    const seen: any[] = [];
    syncManager.on('newMail', (e) => seen.push(e));
    const r = await post(mail(d.address), d.address);
    expect(r.statusCode).toBe(202);
    const row = await one<any>('SELECT m.unread, mb.role FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?', [r.json().id]);
    expect(row).toMatchObject({ unread: false, role: 'archive' });
    expect(seen).toHaveLength(0);
    await act(d.id, 'resume');
    await post(mail(d.address, 'a@b.test', 'again'), d.address);
    expect(seen).toHaveLength(1);
  });

  it('unknown address on the catch-all follows unknown_policy', async () => {
    expect((await post(mail('stranger@push.test'), 'stranger@push.test')).statusCode).toBe(202);
    await run("UPDATE push_inboxes SET unknown_policy = 'reject' WHERE token = ?", [inbox.token]);
    const r = await post(mail('stranger2@push.test', 'a@b.test', 'nope'), 'stranger2@push.test');
    expect(r.json()).toEqual({ dropped: true, reason: 'unknown' });
    expect((await post(mail('me@push.test', 'a@b.test', 'mine'), 'me@push.test')).statusCode).toBe(202);
    const d = (await create()).json();
    expect((await post(mail(d.address, 'a@b.test', 'known'), d.address)).statusCode).toBe(202);
  });
});

describe('expiry', () => {
  it('the disposable.expire job disposes once the time has come (idempotent)', async () => {
    const d = (await create({ expiresInDays: 1 })).json();
    expect(await q("SELECT 1 FROM jobs WHERE kind = 'disposable.expire'")).toHaveLength(1);
    await run('UPDATE disposable_addresses SET expires_at = ? WHERE id = ?', [Date.now() - 1000, d.id]);
    await run("UPDATE jobs SET run_at = ? WHERE kind = 'disposable.expire'", [Date.now() - 1000]);
    await runDueJobs();
    expect((await one<any>('SELECT status, disposed_at FROM disposable_addresses WHERE id = ?', [d.id])).status).toBe('disposed');
    const { expireDue } = await import('../src/mail/disposable.ts');
    expect(await expireDue(d.id)).toBe(false);
  });
});

describe('reply + leak', () => {
  it('active disposable addresses are identities of their account and win reply matching', async () => {
    const d = (await create()).json();
    const ids = (await app.inject({ method: 'GET', url: '/api/identities', headers: { cookie } })).json();
    expect(ids).toContainEqual({ accountId: inbox.accountId, email: d.address, name: 'Push', isAlias: true });
    const r = await post(mail(d.address), d.address);
    const m = (await app.inject({ method: 'POST', url: '/api/identity/match', headers: { cookie }, payload: { emailId: `m${r.json().id}` } })).json();
    expect(m).toMatchObject({ accountId: inbox.accountId, email: d.address, isAlias: true });
    await act(d.id, 'dispose');
    const ids2 = (await app.inject({ method: 'GET', url: '/api/identities', headers: { cookie } })).json();
    expect(ids2.find((i: any) => i.email === d.address)).toBeUndefined();
    expect(matchReplyIdentity).toBeTypeOf('function');
  });

  it('mail from another registrable domain raises disposable.leak once per domain', async () => {
    const d = (await create({ label: 'Shop' })).json();
    await post(mail(d.address, 'a@shop.test', 'welcome'), d.address);
    await post(mail(d.address, 'b@mail.shop.test', 'same org'), d.address);
    expect(await q("SELECT 1 FROM events WHERE type = 'disposable.leak'")).toHaveLength(0);
    await post(mail(d.address, 'spam@evil.test', 'buy'), d.address);
    await post(mail(d.address, 'spam2@evil.test', 'buy more'), d.address);
    const ev = await q<any>("SELECT payload FROM events WHERE type = 'disposable.leak'");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ senderDomain: 'evil.test', signupDomain: 'shop.test', address: d.address });
    await post(mail(d.address, 'x@other.test', 'third'), d.address);
    expect(await q("SELECT 1 FROM events WHERE type = 'disposable.leak'")).toHaveLength(2);
    const st = (await app.inject({ method: 'GET', url: `/api/disposable/${d.id}/stats`, headers: { cookie } })).json();
    expect(st.received).toBe(5);
    expect(st.leakDomains.sort()).toEqual(['evil.test', 'other.test']);
  });
});

describe('Worker disposed list', () => {
  it('GET /disposed is signed; the Worker rejects disposed recipients and caches 5 min', async () => {
    const d = (await create()).json();
    await act(d.id, 'dispose');
    const ts = String(Date.now());
    const get = (sig: string) => app.inject({ method: 'GET', url: `/api/ingest/${inbox.token}/disposed`, headers: { 'x-seamless-timestamp': ts, 'x-seamless-signature': sig } });
    expect((await get('sha256=bad')).statusCode).toBe(401);
    expect((await get(sign(inbox.secret, ts, Buffer.alloc(0)))).json()).toEqual({ addresses: [d.address] });

    const env: Env = { SEAMLESS_URL: 'https://mail.example.com', ROUTES: JSON.stringify({ 'push.test': 'TOK1' }), SECRETS: JSON.stringify({ TOK1: 's1' }) };
    let calls = 0;
    const getImpl = async () => { calls++; return { status: 200, json: async () => ({ addresses: [d.address.toUpperCase()] }) }; };
    const rejects: string[] = []; let posted = 0;
    const m = (to: string): InboundMessage => ({ from: 'a@x.test', to, raw: new Uint8Array([1]), rawSize: 1, forward: async () => {}, setReject: (r) => { rejects.push(r); } });
    const opts = { getImpl, fetchImpl: async () => { posted++; return { status: 202 }; }, sleep: async () => {} };
    await handleEmail(m(d.address), env, undefined, opts);
    expect(rejects).toEqual(['Address disabled']); expect(posted).toBe(0);
    await handleEmail(m('ok@push.test'), env, undefined, opts);
    expect(posted).toBe(1); expect(calls).toBe(1);   // second message used the cache
    let t = Date.now() + 6 * 60_000;
    await disposedList(env, 'TOK1', { getImpl, now: () => t });
    expect(calls).toBe(2);
  });
});

describe('isolation', () => {
  it('user B cannot see, change or dispose user A’s addresses; bulk ignores foreign ids', async () => {
    const d = (await create()).json();
    await makeUser('b@local');
    const cookieB = await login(app, 'b@local');
    expect((await app.inject({ method: 'GET', url: '/api/disposable', headers: { cookie: cookieB } })).json()).toEqual({ addresses: [], domains: [] });
    expect((await act(d.id, 'dispose', cookieB)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/disposable/${d.id}/stats`, headers: { cookie: cookieB } })).statusCode).toBe(404);
    expect((await create({}, cookieB)).statusCode).toBe(400);   // B has no push domains
    const bulk = await app.inject({ method: 'POST', url: '/api/disposable/bulk', headers: { cookie: cookieB }, payload: { ids: [d.id], action: 'dispose' } });
    expect(bulk.json()).toEqual({ updated: 0 });
    expect((await one<any>('SELECT status FROM disposable_addresses WHERE id = ?', [d.id])).status).toBe('active');
  });

  it('bulk dispose works on own addresses', async () => {
    const a = (await create()).json(); const b = (await create()).json();
    const r = await app.inject({ method: 'POST', url: '/api/disposable/bulk', headers: { cookie }, payload: { ids: [a.id, b.id], action: 'dispose' } });
    expect(r.json()).toEqual({ updated: 2 });
  });
});

describe('unknown policy API', () => {
  it('can be changed by the owner only', async () => {
    const put = (c: string, v: string) => app.inject({ method: 'PUT', url: `/api/push-inboxes/${inbox.token}`, headers: { cookie: c }, payload: { unknownPolicy: v } });
    expect((await put(cookie, 'reject')).json().unknownPolicy).toBe('reject');
    expect((await put(cookie, 'bogus')).statusCode).toBe(400);
    await makeUser('c@local');
    expect((await put(await login(app, 'c@local'), 'deliver')).statusCode).toBe(404);
  });
});
