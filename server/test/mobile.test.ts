/** T9.1 Android app support: devices, config, FCM v1 sender (fake Google), what is pushed, sessions. */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { q, one, run, getSetting } from '../src/db.ts';
import { makeApp, login, resetLimiters } from './app.ts';
import { setFcmTestHooks, buildAssertion, parseServiceAccount } from '../src/push/fcm.ts';
import { emitEvent } from '../src/events/emit.ts';
import { raiseAlert } from '../src/alerts/engine.ts';
import { setStoredMode } from '../src/mode.ts';
import { sessionUser } from '../src/auth/sessions.ts';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SA = JSON.stringify({ type: 'service_account', project_id: 'demo-proj', client_email: 'push@demo-proj.iam.gserviceaccount.com', private_key: PRIV, token_uri: 'https://oauth2.fake/token' });

interface Call { url: string; body: any; raw: string; auth?: string }
let calls: Call[] = [];
let sendStatus: (token: string) => { status: number; body: any } = () => ({ status: 200, body: { name: 'projects/demo-proj/messages/1' } });
let clock = 1_800_000_000_000;
let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;

function fakeFetch(url: string, init: any) {
  const raw = String(init?.body ?? '');
  if (url === 'https://oauth2.fake/token') {
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(raw)), raw });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ access_token: `at-${calls.filter((c) => c.url.endsWith('/token')).length}`, expires_in: 3600 }), text: async () => '' });
  }
  const body = JSON.parse(raw);
  calls.push({ url, body, raw, auth: init.headers.Authorization });
  const r = sendStatus(body.message.token);
  return Promise.resolve({ ok: r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) });
}
const sends = () => calls.filter((c) => c.url.includes('messages:send'));
const settle = () => new Promise((r) => setTimeout(r, 150));

const TOK_A = 'A'.repeat(40);
const TOK_B = 'B'.repeat(40);
const asMobile = { 'x-seamless-client': 'android/0.1.0', 'x-seamless-device': 'Pixel 9' };

async function mobileLogin(email = 'test@local') {
  const res = await app.inject({ method: 'POST', url: '/api/login', headers: asMobile, payload: { email, password: 'password123' } });
  expect(res.statusCode).toBe(200);
  return `smsession=${res.cookies.find((c) => c.name === 'smsession')!.value}`;
}
const register = (ck: string, token: string, extra: object = {}) =>
  app.inject({ method: 'POST', url: '/api/mobile/device', headers: { cookie: ck }, payload: { fcmToken: token, deviceName: 'Pixel 9', appVersion: '0.1.0', ...extra } });
const configure = () => app.inject({ method: 'PUT', url: '/api/mobile/fcm', headers: { cookie }, payload: { serviceAccount: SA } });

async function newMail(subject = 'Quarterly numbers', body = 'Hi there, '.repeat(30)) {
  const acct = await makeAccount('me@demo.test');
  const inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  const r = await ingest(acct, inbox, rawEmail({ from: 'Ann Lee <ann@client.test>', to: 'me@demo.test', subject, body }));
  await emitEvent(TEST_USER, 'mail.received', { type: 'message', id: r!.rowId }, { messageId: r!.rowId, accountId: acct, from: 'Ann Lee <ann@client.test>', subject });
  await settle();
  return { acct, rowId: r!.rowId };
}

beforeAll(async () => { app = await makeApp(); });
beforeEach(async () => {
  await resetDb(); resetLimiters();
  await run("DELETE FROM settings WHERE key IN ('fcm_service_account','app_mode')");
  calls = []; sendStatus = () => ({ status: 200, body: { name: 'x' } });
  clock = 1_800_000_000_000;
  setFcmTestHooks({ fetch: fakeFetch as any, now: () => clock });
  cookie = await login(app);
});
afterEach(async () => { setFcmTestHooks({}); await setStoredMode('live'); });

describe('devices and config', () => {
  it('upserts by token, lists, and deletes', async () => {
    const mk = await mobileLogin();
    expect((await register(mk, TOK_A)).statusCode).toBe(200);
    expect((await register(mk, TOK_A, { appVersion: '0.2.0', hideContent: true })).statusCode).toBe(200);
    const list = (await app.inject({ method: 'GET', url: '/api/mobile/device', headers: { cookie: mk } })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ appVersion: '0.2.0', hideContent: true, notifyMail: true, notifyAlerts: true });
    expect((await register(mk, 'short')).statusCode).toBe(400);
    const del = await app.inject({ method: 'DELETE', url: `/api/mobile/device?fcmToken=${TOK_A}`, headers: { cookie: mk } });
    expect(del.json().removed).toBe(1);
    expect(await q('SELECT 1 FROM mobile_devices')).toHaveLength(0);
  });

  it('DELETE without a token removes this session\'s phone only', async () => {
    const mk = await mobileLogin();
    await register(mk, TOK_A); await register(cookie, TOK_B);
    await app.inject({ method: 'DELETE', url: '/api/mobile/device', headers: { cookie: mk } });
    expect((await q<any>('SELECT fcm_token FROM mobile_devices')).map((r) => r.fcm_token)).toEqual([TOK_B]);
  });

  it('user B cannot see or delete user A\'s devices', async () => {
    await makeUser('b@local');
    const ckB = await login(app, 'b@local');
    await register(cookie, TOK_A);
    expect((await app.inject({ method: 'GET', url: '/api/mobile/device', headers: { cookie: ckB } })).json()).toEqual([]);
    const del = await app.inject({ method: 'DELETE', url: `/api/mobile/device?fcmToken=${TOK_A}`, headers: { cookie: ckB } });
    expect(del.json().removed).toBe(0);
    expect(await q('SELECT 1 FROM mobile_devices')).toHaveLength(1);
  });

  it('config returns the switcher, mode, version and pushEnabled', async () => {
    let c = (await app.inject({ method: 'GET', url: '/api/mobile/config', headers: { cookie } })).json();
    expect(c.pushEnabled).toBe(false);
    expect(c.mode).toBe('live');
    expect(c.serverVersion).toMatch(/\d/);
    expect(c.appMinVersion).toBeTruthy();
    expect(c.mailboxSwitcher.categories.length).toBeGreaterThan(0);
    const sw = (await app.inject({ method: 'GET', url: '/api/categories', headers: { cookie } })).json();
    expect(c.mailboxSwitcher).toEqual(sw);
    await configure();
    c = (await app.inject({ method: 'GET', url: '/api/mobile/config', headers: { cookie } })).json();
    expect(c.pushEnabled).toBe(true);
    await setStoredMode('viewing');
    expect((await app.inject({ method: 'GET', url: '/api/mobile/config', headers: { cookie } })).json().mode).toBe('viewing');
  });

  it('requires a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/mobile/config' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/mobile/device', payload: { fcmToken: TOK_A } })).statusCode).toBe(401);
  });
});

describe('Firebase key (admin)', () => {
  it('is admin-only, validated, encrypted at rest and never returned', async () => {
    await makeUser('b@local');
    const ckB = await login(app, 'b@local');
    expect((await app.inject({ method: 'PUT', url: '/api/mobile/fcm', headers: { cookie: ckB }, payload: { serviceAccount: SA } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/mobile/fcm', headers: { cookie: ckB } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/mobile/fcm', headers: { cookie }, payload: { serviceAccount: 'nope' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/mobile/fcm', headers: { cookie }, payload: { serviceAccount: JSON.stringify({ type: 'service_account', project_id: 'x' }) } })).statusCode).toBe(400);
    const ok = await configure();
    expect(ok.json()).toEqual({ configured: true, projectId: 'demo-proj', clientEmail: 'push@demo-proj.iam.gserviceaccount.com' });
    expect(ok.body).not.toContain('PRIVATE KEY');
    expect((await app.inject({ method: 'GET', url: '/api/mobile/fcm', headers: { cookie } })).body).not.toContain('PRIVATE KEY');
    const stored = (await getSetting('fcm_service_account'))!;
    expect(stored).not.toContain('PRIVATE KEY'); expect(stored).not.toContain('demo-proj');
    expect((await app.inject({ method: 'DELETE', url: '/api/mobile/fcm', headers: { cookie } })).json().configured).toBe(false);
  });
});

describe('FCM sender', () => {
  it('signs an RS256 JWT with the right claims and posts to the v1 URL with the bearer token', async () => {
    await configure(); await register(cookie, TOK_A);
    const r = await app.inject({ method: 'POST', url: '/api/mobile/test-push', headers: { cookie } });
    expect(r.json()).toEqual({ devices: 1, sent: 1 });
    const tok = calls.find((c) => c.url.endsWith('/token'))!;
    expect(tok.body.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, b, s] = tok.body.assertion.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'push@demo-proj.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.fake/token' });
    expect(claims.exp - claims.iat).toBe(3600);
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    const send = sends()[0];
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/demo-proj/messages:send');
    expect(send.auth).toBe('Bearer at-1');
    expect(send.body.message.token).toBe(TOK_A);
    expect(send.body.message.data.type).toBe('test');
    expect(send.body.message.notification).toBeUndefined();   // data-only
  });

  it('caches the access token ~55 min, then fetches a new one', async () => {
    await configure(); await register(cookie, TOK_A);
    const post = () => app.inject({ method: 'POST', url: '/api/mobile/test-push', headers: { cookie } });
    await post(); await post(); await post();
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    clock += 54 * 60_000; await post();
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    clock += 2 * 60_000; await post();
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(2);
    expect(sends().at(-1)!.auth).toBe('Bearer at-2');
  });

  it('buildAssertion/parseServiceAccount reject junk', () => {
    expect(() => parseServiceAccount('{')).toThrow(/valid JSON/);
    expect(() => parseServiceAccount(JSON.stringify({ type: 'service_account', project_id: 'p', client_email: 'e', private_key: 'not a key' }))).toThrow(/private key/);
    expect(buildAssertion(parseServiceAccount(SA), clock).split('.')).toHaveLength(3);
  });

  it('push is off (no calls, test-push explains) when Firebase is not configured', async () => {
    await register(cookie, TOK_A);
    const r = await app.inject({ method: 'POST', url: '/api/mobile/test-push', headers: { cookie } });
    expect(r.statusCode).toBe(400);
    await newMail();
    expect(calls).toHaveLength(0);
  });

  it('test-push with no phone registered says so', async () => {
    await configure();
    expect((await app.inject({ method: 'POST', url: '/api/mobile/test-push', headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('what is pushed', () => {
  it('new mail → one minimal data message per device, collapse key per conversation', async () => {
    await configure(); await register(cookie, TOK_A); await register(cookie, TOK_B);
    const { acct, rowId } = await newMail();
    const s = sends();
    expect(s).toHaveLength(2);
    expect(s.map((c) => c.body.message.token).sort()).toEqual([TOK_A, TOK_B]);
    const m = s[0].body.message;
    expect(m.data).toMatchObject({ type: 'mail', messageId: String(rowId), accountId: String(acct), sender: 'Ann Lee', subject: 'Quarterly numbers' });
    expect(m.data.snippet.length).toBeLessThanOrEqual(100);
    expect(m.data.snippet.length).toBeGreaterThan(20);
    expect(Object.values(m.data).every((v) => typeof v === 'string')).toBe(true);
    expect(m.android.collapse_key).toMatch(/^thread-/);
    expect(m.notification).toBeUndefined();
  });

  it('"hide message content" sends only "New mail"', async () => {
    await configure(); await register(cookie, TOK_A, { hideContent: true }); await register(cookie, TOK_B);
    await newMail('Secret plans', 'confidential body');
    const byTok = Object.fromEntries(sends().map((c) => [c.body.message.token, c.body.message.data]));
    expect(byTok[TOK_A]).toMatchObject({ type: 'mail', subject: 'New mail', hidden: '1' });
    expect(JSON.stringify(byTok[TOK_A])).not.toMatch(/Secret|confidential|Ann/);
    expect(byTok[TOK_B].subject).toBe('Secret plans');
  });

  it('a device with mail notifications off gets none', async () => {
    await configure(); await register(cookie, TOK_A, { notifyMail: false }); await register(cookie, TOK_B);
    await newMail();
    expect(sends().map((c) => c.body.message.token)).toEqual([TOK_B]);
  });

  it('a muted mailbox and a user who turned push off for mail get none', async () => {
    await configure(); await register(cookie, TOK_A);
    const acct = await makeAccount('me@demo.test');
    const inbox = await makeMailbox(acct, 'INBOX', 'inbox');
    await run('INSERT INTO notification_mutes(user_id, account_id) VALUES (?,?)', [TEST_USER, acct]).catch(() => run('INSERT INTO notification_mutes(user_id, account_id, created_at) VALUES (?,?,?)', [TEST_USER, acct, Date.now()]));
    const r = await ingest(acct, inbox, rawEmail({ from: 'x@y.test', to: 'me@demo.test', subject: 's' }));
    await emitEvent(TEST_USER, 'mail.received', { type: 'message', id: r!.rowId }, { messageId: r!.rowId, accountId: acct, from: 'x@y.test', subject: 's' });
    await settle();
    expect(sends()).toHaveLength(0);
  });

  it('Viewing mode sends no push', async () => {
    await configure(); await register(cookie, TOK_A);
    await setStoredMode('viewing');
    await newMail();
    expect(sends()).toHaveLength(0);
  });

  it('only the owner\'s devices hear about their mail', async () => {
    await configure();
    const b = await makeUser('b@local'); const ckB = await login(app, 'b@local');
    await register(ckB, TOK_B); await register(cookie, TOK_A);
    await newMail();
    expect(sends().map((c) => c.body.message.token)).toEqual([TOK_A]);
    expect(b).toBeGreaterThan(0);
  });

  it('critical alerts always go out — even with mail notifications off or hidden content — on the alert channel type', async () => {
    await configure(); await register(cookie, TOK_A, { notifyMail: false }); await register(cookie, TOK_B, { hideContent: true });
    const acct = await makeAccount('me@demo.test');
    const { alert } = await raiseAlert(TEST_USER, 'mailbox.sync', { type: 'account', id: acct, accountId: acct }, 'Mailbox me@demo.test stopped working', 'connect ECONNREFUSED');
    await settle();
    const byTok = Object.fromEntries(sends().map((c) => [c.body.message.token, c.body.message]));
    expect(byTok[TOK_A].data).toMatchObject({ type: 'alert', alertId: String(alert.id), accountId: String(acct), subject: 'Mailbox me@demo.test stopped working' });
    expect(byTok[TOK_B].data).toMatchObject({ type: 'alert', hidden: '1' });
    expect(byTok[TOK_B].data.subject).not.toMatch(/me@demo/);
    // the same open problem is not pushed twice
    await raiseAlert(TEST_USER, 'mailbox.sync', { type: 'account', id: acct, accountId: acct }, 'Mailbox me@demo.test stopped working', 'connect ECONNREFUSED');
    await settle();
    expect(sends()).toHaveLength(2);
  });

  it('alerts can be switched off per device', async () => {
    await configure(); await register(cookie, TOK_A, { notifyAlerts: false });
    const acct = await makeAccount('me@demo.test');
    await raiseAlert(TEST_USER, 'mailbox.sync', { type: 'account', id: acct, accountId: acct }, 't', 'b');
    await settle();
    expect(sends()).toHaveLength(0);
  });

  it('UNREGISTERED tokens are deleted, others kept', async () => {
    await configure(); await register(cookie, TOK_A); await register(cookie, TOK_B);
    sendStatus = (t) => t === TOK_A ? { status: 404, body: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } } : { status: 200, body: {} };
    await newMail();
    expect((await q<any>('SELECT fcm_token FROM mobile_devices')).map((r) => r.fcm_token)).toEqual([TOK_B]);
  });

  it('other FCM errors keep the token', async () => {
    await configure(); await register(cookie, TOK_A);
    sendStatus = () => ({ status: 500, body: { error: { status: 'INTERNAL' } } });
    await newMail();
    expect(await q('SELECT 1 FROM mobile_devices')).toHaveLength(1);
  });
});

describe('mobile sessions', () => {
  it('are labelled "Seamless for Android — <device>" and revocable (the phone then gets 401)', async () => {
    const mk = await mobileLogin();
    await register(mk, TOK_A);
    const list = (await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie } })).json();
    const phone = list.find((s: any) => s.label);
    expect(phone.label).toBe('Seamless for Android — Pixel 9');
    expect(list.filter((s: any) => s.label)).toHaveLength(1);       // the browser session has no label
    expect((await app.inject({ method: 'GET', url: '/api/mobile/config', headers: { cookie: mk } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/sessions/${phone.id}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/mobile/config', headers: { cookie: mk } })).statusCode).toBe(401);
    expect(await q('SELECT 1 FROM mobile_devices')).toHaveLength(0);   // push stops with the session
  });

  it('stay valid 90 days after last use (renewed), while browser sessions keep the 90-day cap from sign-in', async () => {
    const mk = await mobileLogin();
    const tokenOf = (c: string) => c.split('=')[1];
    const DAY = 86_400_000;
    const t0 = Date.now();
    // use it every 60 days, 150 days in total
    for (const d of [60, 120, 150]) {
      const u = await sessionUser(tokenOf(mk), t0 + d * DAY);
      expect(u, `day ${d}`).not.toBeNull();
    }
    // a browser session is cut off at 90 days from sign-in even if used
    const web = tokenOf(cookie);
    for (const d of [25, 50, 75, 89]) expect(await sessionUser(web, t0 + d * DAY), `web day ${d}`).not.toBeNull();
    expect(await sessionUser(web, t0 + 91 * DAY)).toBeNull();
    // and the phone expires after 90 days of not being used
    expect(await sessionUser(tokenOf(mk), t0 + 150 * DAY + 91 * DAY)).toBeNull();
  });

  it('a normal browser login has no label and ignores a forged client header on other requests', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie, 'x-seamless-client': 'android/9' } })).json();
    expect(list.every((s: any) => s.label === '')).toBe(true);
    expect(await one("SELECT 1 FROM sessions WHERE client <> ''")).toBeUndefined();
  });

  it('/api/me tells a signed-out app the server name and version (login screen "Check")', async () => {
    const r = (await app.inject({ method: 'GET', url: '/api/me' })).json();
    expect(r.loggedIn).toBe(false);
    expect(r.server.name).toBe('Seamless');
    expect(r.server.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
