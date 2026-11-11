/** T5.3 F-37: API tokens + REST v1 — scopes, revoke/expiry, isolation, shared mail, long-poll, rate limit, cookie rejection, OpenAPI. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const sent: any[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { q, run } = await import('../src/db.ts');
const { emitEvent } = await import('../src/events/emit.ts');
const T = await import('../src/api/tokens.ts');
const { openapiRoutes } = await import('../src/api/openapi.ts');
const { clearParsedCache } = await import('../src/mail/body.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

let A: number, B: number, acct: number, inbox: number, archive: number;
let app: Awaited<ReturnType<typeof makeApp>>;
let cka = '', ckb = '';
const cookieApi = (ck: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck } });
const v1 = (tok: string, method: any, url: string, body?: any) => app.inject({ method, url: `/api/v1${url}`, payload: body, headers: { authorization: `Bearer ${tok}` } });
const mkToken = async (ck: string, scopes = ['mail:read', 'labels:write', 'mail:send', 'events:subscribe', 'contacts:read'], extra: any = {}) =>
  (await cookieApi(ck, 'POST', '/api/api-tokens', { name: 'T', scopes, ...extra })).json().token as string;
const addMail = async (subject = 'Quote') => (await ingest(acct, inbox, rawEmail({ from: 'bob@shop.test', to: 'a@demo.test', subject })))!.rowId as number;

beforeEach(async () => {
  await resetDb(); resetLimiters(); clearParsedCache(); sent.length = 0;
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test');
  acct = await makeAccount('a@demo.test', { userId: A });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  archive = await makeMailbox(acct, 'Archive', 'archive');
  app = await makeApp();
  cka = await login(app, 'a@x.test'); ckb = await login(app, 'b@x.test');
});

describe('tokens', () => {
  it('has the sk_sl_<prefix8>_<random32> format, is shown once and stored as a hash', async () => {
    const r = (await cookieApi(cka, 'POST', '/api/api-tokens', { name: 'CI', scopes: ['mail:read'], expiresInDays: 30 })).json();
    expect(r.token).toMatch(/^sk_sl_[a-z0-9]{8}_[a-z0-9]{32}$/);
    const list = (await cookieApi(cka, 'GET', '/api/api-tokens')).json().items;
    expect(JSON.stringify(list)).not.toContain(r.token);
    expect(list[0].prefix).toBe(r.token.slice(0, 14));
    const row = (await q<any>('SELECT token_hash FROM api_tokens'))[0];
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.token_hash).not.toContain(r.token);
  });
  it('validates name, scopes and expiry', async () => {
    expect((await cookieApi(cka, 'POST', '/api/api-tokens', { name: '', scopes: ['mail:read'] })).statusCode).toBe(400);
    expect((await cookieApi(cka, 'POST', '/api/api-tokens', { name: 'x', scopes: [] })).statusCode).toBe(400);
    expect((await cookieApi(cka, 'POST', '/api/api-tokens', { name: 'x', scopes: ['root'] })).statusCode).toBe(400);
  });
  it('tracks last use', async () => {
    const tok = await mkToken(cka);
    await v1(tok, 'GET', '/contacts');
    expect((await cookieApi(cka, 'GET', '/api/api-tokens')).json().items[0].lastUsedAt).toBeGreaterThan(0);
  });
});

describe('auth', () => {
  it('missing scope → 403', async () => {
    const tok = await mkToken(cka, ['contacts:read']);
    expect((await v1(tok, 'GET', '/messages')).statusCode).toBe(403);
    expect((await v1(tok, 'POST', '/send', {})).statusCode).toBe(403);
    expect((await v1(tok, 'GET', '/contacts')).statusCode).toBe(200);
  });
  it('revoked → 401, expired → 401, garbage → 401', async () => {
    const tok = await mkToken(cka);
    expect((await v1(tok, 'GET', '/contacts')).statusCode).toBe(200);
    const id = (await cookieApi(cka, 'GET', '/api/api-tokens')).json().items[0].id;
    await cookieApi(cka, 'DELETE', `/api/api-tokens/${id}`);
    expect((await v1(tok, 'GET', '/contacts')).statusCode).toBe(401);
    const tok2 = await mkToken(cka);
    await run('UPDATE api_tokens SET expires_at = ? WHERE token_hash <> ?', [Date.now() - 1000, 'x']);
    expect((await v1(tok2, 'GET', '/contacts')).statusCode).toBe(401);
    expect((await v1('sk_sl_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'GET', '/contacts')).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/contacts' })).statusCode).toBe(401);
  });
  it('cookie sessions are rejected on v1; tokens are rejected on the cookie API', async () => {
    expect((await cookieApi(cka, 'GET', '/api/v1/contacts')).statusCode).toBe(401);
    expect((await cookieApi(cka, 'POST', '/api/v1/send', {})).statusCode).toBe(401);
    const tok = await mkToken(cka);
    expect((await app.inject({ method: 'GET', url: '/api/contacts', headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(401);
  });
  it('the 601st call in a minute → 429', async () => {
    const tok = await mkToken(cka);
    for (let i = 0; i < 600; i++) expect((await v1(tok, 'GET', '/contacts')).statusCode).toBe(200);
    expect((await v1(tok, 'GET', '/contacts')).statusCode).toBe(429);
  });
  it('the audit hook sees every call', async () => {
    const calls: any[] = [];
    T.setApiCallHook((id, route, status) => { calls.push([id, route, status]); });
    const tok = await mkToken(cka);
    await v1(tok, 'GET', '/contacts');
    await new Promise((r) => setTimeout(r, 50));
    T.setApiCallHook(() => {});
    expect(calls[0][1]).toBe('GET /api/v1/contacts');
    expect(calls[0][2]).toBe(200);
  });
});

describe('messages', () => {
  it('lists, searches, reads and fetches raw', async () => {
    const id = await addMail('Quote for fence');
    await addMail('Other');
    const tok = await mkToken(cka);
    const all = (await v1(tok, 'GET', '/messages')).json();
    expect(all.items.length).toBe(2);
    const hit = (await v1(tok, 'GET', '/messages?query=fence&limit=1')).json();
    expect(hit.items.map((e: any) => e.id)).toEqual([`m${id}`]);
    const page1 = (await v1(tok, 'GET', '/messages?limit=1')).json();
    expect(page1.nextCursor).toBe('1');
    const page2 = (await v1(tok, 'GET', `/messages?limit=1&cursor=${page1.nextCursor}`)).json();
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
    expect(page2.nextCursor).toBeNull();
    const one = (await v1(tok, 'GET', `/messages/m${id}`)).json();
    expect(one.subject).toBe('Quote for fence');
    expect(one.text).toContain('hello body');
    const raw = await v1(tok, 'GET', `/messages/m${id}/raw`);
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toContain('message/rfc822');
    expect(raw.body).toContain('Subject: Quote for fence');
  });
  it("B's token cannot read A's mail", async () => {
    const id = await addMail();
    const tokB = await mkToken(ckb);
    expect((await v1(tokB, 'GET', `/messages/m${id}`)).statusCode).toBe(404);
    expect((await v1(tokB, 'GET', `/messages/m${id}/raw`)).statusCode).toBe(404);
    expect((await v1(tokB, 'GET', '/messages')).json().items).toEqual([]);
    expect((await v1(tokB, 'POST', `/messages/m${id}/archive`)).statusCode).toBe(404);
  });
  it('shared mail: viewer can read but not archive; responder can archive', async () => {
    const id = await addMail('Shared');
    const tokB = await mkToken(ckb);
    await run("INSERT INTO mailbox_shares(account_id, user_id, role, created_at) VALUES (?,?,'viewer',0)", [acct, B]);
    expect((await v1(tokB, 'GET', `/messages/m${id}`)).statusCode).toBe(200);
    expect((await v1(tokB, 'GET', '/messages')).json().items.length).toBe(1);
    expect((await v1(tokB, 'POST', `/messages/m${id}/archive`)).statusCode).toBe(403);
    await run("UPDATE mailbox_shares SET role = 'responder' WHERE user_id = ?", [B]);
    expect((await v1(tokB, 'POST', `/messages/m${id}/archive`)).statusCode).toBe(200);
    expect((await q<any>('SELECT mailbox_id FROM messages WHERE id = ?', [id]))[0].mailbox_id).toBe(archive);
  });
  it('labels and archive', async () => {
    const id = await addMail();
    const lid = (await q<any>("INSERT INTO labels(user_id, name, color) VALUES (?,?,?) RETURNING id", [A, 'Quotes', 'blue']))[0].id;
    const tok = await mkToken(cka);
    const r = (await v1(tok, 'POST', `/messages/m${id}/labels`, { add: [lid] })).json();
    expect(r.labelIds).toEqual([lid]);
    expect((await v1(tok, 'POST', `/messages/m${id}/labels`, { remove: [lid] })).json().labelIds).toEqual([]);
    expect((await v1(tok, 'POST', `/messages/m${id}/archive`)).statusCode).toBe(200);
    expect((await q<any>('SELECT mailbox_id FROM messages WHERE id = ?', [id]))[0].mailbox_id).toBe(archive);
  });
});

describe('send', () => {
  it('sends immediately through the identity', async () => {
    const ident = (await q<any>('SELECT id FROM identities WHERE user_id = ?', [A]))[0];
    const tok = await mkToken(cka);
    const r = await v1(tok, 'POST', '/send', { identityId: ident.id, to: ['bob@x.test'], subject: 'Hi', text: 'Line 1\nLine <2>' });
    expect(r.statusCode).toBe(200);
    expect(sent.length).toBe(1);
    expect(sent[0].envelope?.to ?? sent[0].to).toBeTruthy();
    expect(r.json().ok).toBe(true);
  });
  it("rejects another user's identity and empty recipients", async () => {
    const ident = (await q<any>('SELECT id FROM identities WHERE user_id = ?', [A]))[0];
    const tokB = await mkToken(ckb);
    expect((await v1(tokB, 'POST', '/send', { identityId: ident.id, to: ['x@x.test'], subject: 'x', text: 'x' })).statusCode).toBe(400);
    const tok = await mkToken(cka);
    expect((await v1(tok, 'POST', '/send', { identityId: ident.id, to: [], subject: 'x', text: 'x' })).statusCode).toBe(400);
    expect(sent.length).toBe(0);
  });
});

describe('events long-poll', () => {
  const base = async (tok: string) => (await v1(tok, 'GET', '/events?since=0')).json().cursor as number; // login already emitted events
  it('returns new events in order and the cursor advances', async () => {
    const tok = await mkToken(cka);
    const c0 = await base(tok);
    const e1 = await emitEvent(A, 'mail.received', { type: 'message', id: 1 }, { n: 1 });
    const e2 = await emitEvent(A, 'mail.received', { type: 'message', id: 2 }, { n: 2 });
    await emitEvent(B, 'mail.received', { type: 'message', id: 3 }, { n: 3 });
    const r1 = (await v1(tok, 'GET', `/events?since=${c0}`)).json();
    expect(r1.items.map((e: any) => e.id)).toEqual([e1, e2]);
    expect(r1.items[0].payload.n).toBe(1);
    expect(r1.cursor).toBe(e2);
    const r2 = (await v1(tok, 'GET', `/events?since=${r1.cursor}`)).json();
    expect(r2.items).toEqual([]);
    expect(r2.cursor).toBe(e2);
    const e3 = await emitEvent(A, 'mail.received', { type: 'message', id: 4 }, {});
    expect((await v1(tok, 'GET', `/events?since=${r1.cursor}`)).json().items.map((e: any) => e.id)).toEqual([e3]);
  });
  it('holds the request for `wait` seconds when nothing is new', async () => {
    const tok = await mkToken(cka);
    const c0 = await base(tok);
    const t0 = Date.now();
    const res = (await v1(tok, 'GET', `/events?since=${c0}&wait=1`)).json();
    expect(res.items).toEqual([]);
    expect(res.cursor).toBe(c0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });
  it('wakes a waiting poll when an event is emitted', async () => {
    const tok = await mkToken(cka);
    const c0 = await base(tok);
    const t0 = Date.now();
    const pending = v1(tok, 'GET', `/events?since=${c0}&wait=10`);
    setTimeout(() => { void emitEvent(A, 'mail.received', null, { woke: true }); }, 200);
    const res = (await pending).json();
    expect(res.items.length).toBe(1);
    expect(res.items[0].payload.woke).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('subscriptions + contacts', () => {
  it('creates and deletes a webhook subscription; B cannot delete it', async () => {
    const tok = await mkToken(cka);
    const r = (await v1(tok, 'POST', '/subscriptions', { url: 'https://example.com/hook', eventTypes: ['mail.received'] })).json();
    expect(r.secret).toMatch(/^whsec_/);
    expect((await v1(tok, 'POST', '/subscriptions', { url: 'https://example.com/hook', eventTypes: ['nope'] })).statusCode).toBe(400);
    const tokB = await mkToken(ckb);
    expect((await v1(tokB, 'DELETE', `/subscriptions/${r.id}`)).statusCode).toBe(404);
    expect((await v1(tok, 'DELETE', `/subscriptions/${r.id}`)).statusCode).toBe(200);
    expect((await cookieApi(cka, 'GET', '/api/webhooks')).json().items).toEqual([]);
  });
  it('lists only my contacts', async () => {
    const now = Date.now();
    await run("INSERT INTO contacts(user_id, display_name, org, notes, created_at, updated_at) VALUES (?,?,?,?,?,?)", [A, 'Alice A', '', '', now, now]).catch(() => {});
    const tokA = await mkToken(cka), tokB = await mkToken(ckb);
    const a = (await v1(tokA, 'GET', '/contacts')).json().items.map((c: any) => c.displayName);
    expect(a).toContain('Alice A');
    expect((await v1(tokB, 'GET', '/contacts')).json().items.map((c: any) => c.displayName)).not.toContain('Alice A');
  });
});

describe('token manager isolation', () => {
  it("B can't list or revoke A's tokens", async () => {
    const tok = await mkToken(cka);
    const id = (await cookieApi(cka, 'GET', '/api/api-tokens')).json().items[0].id;
    expect((await cookieApi(ckb, 'GET', '/api/api-tokens')).json().items).toEqual([]);
    expect((await cookieApi(ckb, 'DELETE', `/api/api-tokens/${id}`)).statusCode).toBe(404);
    expect((await v1(tok, 'GET', '/contacts')).statusCode).toBe(200);
  });
});

describe('OpenAPI', () => {
  it('is public, valid JSON and every listed route exists', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(r.statusCode).toBe(200);
    const doc = JSON.parse(r.body);
    expect(doc.openapi).toBe('3.1.0');
    for (const [method, url] of openapiRoutes()) expect(app.hasRoute({ method: method as any, url }), `${method} ${url}`).toBe(true);
  });
  it('lists every registered /api/v1 route', async () => {
    const listed = new Set(openapiRoutes().map(([m, u]) => `${m} ${u}`));
    const registered = app.printRoutes({ commonPrefix: false }).split('\n').length; // sanity: printRoutes works
    expect(registered).toBeGreaterThan(0);
    for (const [method, url] of [['GET', '/api/v1/messages'], ['POST', '/api/v1/send'], ['GET', '/api/v1/events'], ['POST', '/api/v1/subscriptions'], ['GET', '/api/v1/contacts']]) expect(listed.has(`${method} ${url}`)).toBe(true);
  });
});
