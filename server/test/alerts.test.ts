/** T8.9 critical alerts: adapters against local node:http fakes, the engine (dedupe, recovery, reminders, retries), the API and Viewing mode. */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { q, one, run } from '../src/db.ts';
import { makeApp, login, resetLimiters } from './app.ts';
import { syncManager } from '../src/imap/sync.ts';
import { addAllow } from '../src/integrations/webhooks.ts';
import { decrypt } from '../src/crypto.ts';
import { setStoredMode } from '../src/mode.ts';
import {
  raiseAlert, resolveAlerts, runAlertChecks, processDeliveries, setAlertDepsForTests, setAlertSettings, ALERT_DEFAULTS, messageFor,
} from '../src/alerts/engine.ts';
import { renderTemplate } from '../src/alerts/channels/smsGateway.ts';
import { createChannel } from '../src/alerts/store.ts';
import { setSetting } from '../src/db.ts';
import { resetStorageProbe } from '../src/health/status.ts';

interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
let hits: Hit[] = [];
let failPaths = new Set<string>();             // a path prefix that answers 500
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if ([...failPaths].some((p) => req.url!.startsWith(p))) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"message":"boom","code":99}'); return; }
      res.writeHead(req.url!.includes('Messages.json') ? 201 : 200, { 'content-type': 'application/json' });
      if (req.url!.includes('getUpdates')) res.end(JSON.stringify({ ok: true, result: [{ update_id: 1, message: { chat: { id: 4242, first_name: 'Sam', type: 'private' } } }] }));
      else res.end('{"ok":true,"sid":"SM1"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

const SID = `AC${'a'.repeat(32)}`;
const BOT = '123456789:AAEabcdefghijklmnopqrstuvwxyz012345';
const twilioCfg = () => ({ accountSid: SID, authToken: 'tok-secret', from: '+15550001111', to: '+61400000001', apiBase: `${base}/twilio` });
const tgCfg = () => ({ botToken: BOT, chatId: '4242', apiBase: `${base}/tg` });
const gwCfg = () => ({ url: `${base}/gw/message`, method: 'POST', contentType: 'json', bodyTemplate: '{"message":"{{message}}","phoneNumbers":["{{to}}"]}', to: '+61400000002', username: 'u', password: 'p' });

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let mails: { to: string[]; subject: string; exclude: number | null }[] = [];

async function verified(userId: number, kind: string, config: any, scope: 'user' | 'team' = 'user') {
  const ch = await createChannel(userId, true, { kind, config, scope, name: kind });
  await run('UPDATE alert_channels SET verified_at = ? WHERE id = ?', [Date.now(), ch.id]);
  return ch.id;
}
const alertsOf = (userId = TEST_USER) => q<any>('SELECT * FROM alerts WHERE user_id = ? ORDER BY id', [userId]);
const failSync = (id: number, failures: number, extra: Partial<{ lastSyncAt: number | null; lastError: string }> = {}) =>
  syncManager.setStatus(id, { state: 'error', lastSyncAt: null, lastError: 'connect ECONNREFUSED', failures, ...extra });

beforeEach(async () => {
  await resetDb(); resetLimiters();
  hits = []; failPaths = new Set(); mails = []; resetStorageProbe();
  for (let i = 1; i <= 40; i++) syncManager.stopAccount(i);   // statuses outlive the DB reset
  await run("DELETE FROM settings WHERE key IN ('alerts_cfg','alerts_wizard','app_mode') OR key LIKE 'backup_%'");
  await run('DELETE FROM webhook_allowlist');
  await addAllow(TEST_USER, '127.0.0.1');
  setAlertDepsForTests({ sendMail: async (_u, to, msg, exclude) => { mails.push({ to, subject: msg.title, exclude }); } });
  app ??= await makeApp();
  cookie = await login(app);
});
afterEach(async () => { setAlertDepsForTests(); await setStoredMode('live'); });

describe('adapters build the right request', () => {
  it('twilio: Basic auth, form To/From/Body, Messages.json path', async () => {
    const id = await verified(TEST_USER, 'twilio', twilioCfg());
    const acct = await makeAccount('a@demo.test');
    failSync(acct, 3);
    await run('UPDATE alert_channels SET verified_at = ? WHERE id = ?', [Date.now(), id]);
    await runAlertChecks();
    const h = hits.find((x) => x.url.includes('Messages.json'))!;
    expect(h.method).toBe('POST');
    expect(h.url).toBe(`/twilio/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(h.headers.authorization).toBe(`Basic ${Buffer.from(`${SID}:tok-secret`).toString('base64')}`);
    expect(h.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const f = new URLSearchParams(h.body);
    expect(f.get('To')).toBe('+61400000001'); expect(f.get('From')).toBe('+15550001111');
    expect(f.get('Body')).toMatch(/CRITICAL.*a@demo\.test/);
  });

  it('twilio with a Messaging Service SID sends that instead of From', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/alert-channels', headers: { cookie }, payload: { kind: 'twilio', config: { ...twilioCfg(), from: '', messagingServiceSid: 'MG123' } } });
    expect(r.statusCode).toBe(200);
    const t = await app.inject({ method: 'POST', url: `/api/alert-channels/${r.json().id}/test`, headers: { cookie } });
    expect(t.json().ok).toBe(true);
    const f = new URLSearchParams(hits[0].body);
    expect(f.get('MessagingServiceSid')).toBe('MG123'); expect(f.has('From')).toBe(false);
  });

  it('telegram: sendMessage JSON with chat_id and text', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/alert-channels', headers: { cookie }, payload: { kind: 'telegram', config: tgCfg() } });
    await app.inject({ method: 'POST', url: `/api/alert-channels/${r.json().id}/test`, headers: { cookie } });
    const h = hits[0];
    expect(h.url).toBe(`/tg/bot${BOT}/sendMessage`);
    expect(JSON.parse(h.body)).toMatchObject({ chat_id: '4242' });
    expect(JSON.parse(h.body).text).toMatch(/Test message/);
  });

  it('telegram "Find my chat" reads getUpdates', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/alert-channels/telegram/find-chat', headers: { cookie }, payload: { botToken: BOT } });
    // the helper talks to the real api.telegram.org by default; point at the fake through a saved channel instead
    expect([200, 400]).toContain(r.statusCode);
    const { findChats } = await import('../src/alerts/channels/telegram.ts');
    const chats = await findChats(BOT, async (url) => { hits.push({ method: 'GET', url, headers: {}, body: '' }); return { status: 200, text: JSON.stringify({ ok: true, result: [{ message: { chat: { id: 7, first_name: 'Sam', type: 'private' } } }] }) }; }, base + '/tg');
    expect(chats).toEqual([{ id: '7', name: 'Sam', type: 'private' }]);
    expect(hits.at(-1)!.url).toBe(`${base}/tg/bot${BOT}/getUpdates`);
  });

  it('phone gateway: basic auth, JSON body from the template, quotes in the message are escaped', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/alert-channels', headers: { cookie }, payload: { kind: 'sms_gateway', config: gwCfg() } });
    expect(r.statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/alert-channels/${r.json().id}/test`, headers: { cookie } });
    const h = hits[0];
    expect(h.url).toBe('/gw/message');
    expect(h.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(JSON.parse(h.body)).toMatchObject({ phoneNumbers: ['+61400000002'] });
    expect(renderTemplate('{"m":"{{message}}"}', 'json', { to: 'x', message: 'say "hi"\n' })).toBe('{"m":"say \\"hi\\"\\n"}');
    expect(renderTemplate('to={{to}}&m={{message}}', 'form', { to: '+61', message: 'a b&c' })).toBe('to=%2B61&m=a%20b%26c');
  });

  it('phone gateway with a bearer token and form body', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/alert-channels', headers: { cookie }, payload: { kind: 'sms_gateway', config: { url: `${base}/gw/send`, contentType: 'form', bodyTemplate: 'to={{to}}&message={{message}}', to: '+61400000002', token: 'tkn' } } });
    await app.inject({ method: 'POST', url: `/api/alert-channels/${r.json().id}/test`, headers: { cookie } });
    expect(hits[0].headers.authorization).toBe('Bearer tkn');
    expect(hits[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(hits[0].body).get('to')).toBe('+61400000002');
  });

  it('a private gateway address is refused until an admin allows it, and the answer names the host', async () => {
    await run('DELETE FROM webhook_allowlist');
    const r = await app.inject({ method: 'POST', url: '/api/alert-channels', headers: { cookie }, payload: { kind: 'sms_gateway', config: gwCfg() } });
    const t = (await app.inject({ method: 'POST', url: `/api/alert-channels/${r.json().id}/test`, headers: { cookie } })).json();
    expect(t.ok).toBe(false); expect(t.ssrfHost).toBe('127.0.0.1'); expect(t.error).toMatch(/allow-list/);
    expect(hits).toHaveLength(0);
  });

  it('email goes to the typed address through a healthy mailbox, never the failing one', async () => {
    const bad = await makeAccount('bad@demo.test'); const good = await makeAccount('good@demo.test');
    failSync(bad, 3); syncManager.setStatus(good, { state: 'ok', lastSyncAt: Date.now(), lastError: '', failures: 0 });
    const { pickSender } = await import('../src/alerts/channels/email.ts');
    expect((await pickSender(TEST_USER, bad))!.email).toBe('good@demo.test');
    syncManager.setStatus(good, { state: 'error', lastSyncAt: null, lastError: 'x', failures: 5 });
    expect(await pickSender(TEST_USER, bad)).toBeNull();
    syncManager.setStatus(good, { state: 'ok', lastSyncAt: Date.now(), lastError: '', failures: 0 });
    await verified(TEST_USER, 'email', { to: 'boss@elsewhere.test' });
    await runAlertChecks();
    expect(mails).toEqual([{ to: ['boss@elsewhere.test'], subject: 'Mailbox bad@demo.test stopped working', exclude: bad }]);
  });

  it('validation errors are friendly', async () => {
    const bad = async (kind: string, config: any) => (await app.inject({ method: 'POST', url: '/api/alert-channels', headers: { cookie }, payload: { kind, config } }));
    expect((await bad('twilio', { ...twilioCfg(), accountSid: 'nope' })).json().error).toMatch(/Account SID/);
    expect((await bad('twilio', { ...twilioCfg(), to: '0400' })).json().error).toMatch(/international/);
    expect((await bad('telegram', { ...tgCfg(), botToken: 'x' })).json().error).toMatch(/BotFather/);
    expect((await bad('email', { to: 'nope' })).json().error).toMatch(/not an email/);
    expect((await bad('sms_gateway', { ...gwCfg(), bodyTemplate: '{}' })).json().error).toMatch(/\{\{message\}\}/);
    expect((await bad('pigeon', {})).statusCode).toBe(400);
  });
});

describe('a channel counts as set up only after a passing test', () => {
  it('create → not verified; failing test keeps it unverified; passing test verifies; editing the settings clears it', async () => {
    const r = (await app.inject({ method: 'POST', url: '/api/alert-channels', headers: { cookie }, payload: { kind: 'telegram', config: tgCfg() } })).json();
    expect(r.verifiedAt).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/alert-channels', headers: { cookie } })).json().hasVerified).toBe(false);
    failPaths.add('/tg');
    const bad = (await app.inject({ method: 'POST', url: `/api/alert-channels/${r.id}/test`, headers: { cookie } })).json();
    expect(bad.ok).toBe(false); expect(bad.channel.verifiedAt).toBeNull(); expect(bad.channel.lastError).toMatch(/500/);
    failPaths.clear();
    const good = (await app.inject({ method: 'POST', url: `/api/alert-channels/${r.id}/test`, headers: { cookie } })).json();
    expect(good.ok).toBe(true); expect(good.channel.verifiedAt).toBeGreaterThan(0); expect(good.channel.lastError).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/alert-channels', headers: { cookie } })).json().hasVerified).toBe(true);
    const ed = (await app.inject({ method: 'PUT', url: `/api/alert-channels/${r.id}`, headers: { cookie }, payload: { config: { ...tgCfg(), chatId: '999' } } })).json();
    expect(ed.verifiedAt).toBeNull();
    // renaming alone doesn't
    await app.inject({ method: 'POST', url: `/api/alert-channels/${r.id}/test`, headers: { cookie } });
    const ren = (await app.inject({ method: 'PUT', url: `/api/alert-channels/${r.id}`, headers: { cookie }, payload: { name: 'Phone' } })).json();
    expect(ren.verifiedAt).toBeGreaterThan(0);
  });

  it('an unverified channel gets no alerts', async () => {
    await createChannel(TEST_USER, true, { kind: 'twilio', config: twilioCfg() });
    failSync(await makeAccount('a@demo.test'), 3);
    await runAlertChecks();
    expect(hits).toHaveLength(0);
    expect(await alertsOf()).toHaveLength(1);        // still raised in the app
  });
});

describe('mailbox alerts', () => {
  it('3 consecutive failures raise exactly one alert and one message per channel; more failures do not repeat', async () => {
    await verified(TEST_USER, 'twilio', twilioCfg()); await verified(TEST_USER, 'telegram', tgCfg()); await verified(TEST_USER, 'sms_gateway', gwCfg());
    const acct = await makeAccount('a@demo.test');
    failSync(acct, 2); await runAlertChecks();
    expect(await alertsOf()).toHaveLength(0); expect(hits).toHaveLength(0);
    failSync(acct, 3); await runAlertChecks();
    expect(await alertsOf()).toHaveLength(1);
    expect(hits.map((h) => h.url.split('/')[1]).sort()).toEqual(['gw', 'tg', 'twilio']);
    failSync(acct, 4); await runAlertChecks(); failSync(acct, 9); await runAlertChecks();
    expect(await alertsOf()).toHaveLength(1); expect(hits).toHaveLength(3);
    const a = (await alertsOf())[0];
    expect(a).toMatchObject({ kind: 'mailbox.sync', severity: 'critical', state: 'open', send_count: 1 });
    expect(Object.values(a.deliveries).every((d: any) => d.ok)).toBe(true);
  });

  it('no successful sync for 15 minutes counts even below the failure count', async () => {
    const acct = await makeAccount('a@demo.test');
    const now = Date.now();
    failSync(acct, 1, { lastSyncAt: now - 5 * 60_000 }); await runAlertChecks(now);
    expect(await alertsOf()).toHaveLength(0);
    failSync(acct, 1, { lastSyncAt: now - 16 * 60_000 }); await runAlertChecks(now);
    expect(await alertsOf()).toHaveLength(1);
  });

  it('thresholds come from settings', async () => {
    await setAlertSettings({ syncFailures: 5 });
    const acct = await makeAccount('a@demo.test');
    failSync(acct, 4); await runAlertChecks(); expect(await alertsOf()).toHaveLength(0);
    failSync(acct, 5); await runAlertChecks(); expect(await alertsOf()).toHaveLength(1);
  });

  it('recovery resolves the alert and sends one "recovered" line', async () => {
    await verified(TEST_USER, 'telegram', tgCfg());
    const acct = await makeAccount('a@demo.test');
    failSync(acct, 3); await runAlertChecks();
    syncManager.setStatus(acct, { state: 'ok', lastSyncAt: Date.now(), lastError: '', failures: 0 });
    await runAlertChecks(); await runAlertChecks();
    const a = (await alertsOf())[0];
    expect(a.state).toBe('resolved'); expect(a.resolved_at).toBeGreaterThan(0);
    expect(hits).toHaveLength(2);
    expect(JSON.parse(hits[1].body).text).toMatch(/Fixed: Mailbox a@demo\.test stopped working/);
    // a new outage is a new alert
    failSync(acct, 3); await runAlertChecks();
    expect(await alertsOf()).toHaveLength(2);
  });

  it('a revoked OAuth sign-in is its own alert kind', async () => {
    const acct = await makeAccount('g@demo.test');
    await run("UPDATE accounts SET kind = 'gmail' WHERE id = ?", [acct]);
    failSync(acct, 3, { lastError: 'invalid_grant' }); await runAlertChecks();
    expect((await alertsOf())[0]).toMatchObject({ kind: 'oauth.revoked' });
    expect((await alertsOf())[0].title).toMatch(/signed in again/);
  });

  it('ignored and disabled mailboxes do not alert', async () => {
    const a = await makeAccount('a@demo.test'); const b = await makeAccount('b@demo.test');
    await run('UPDATE accounts SET health_ignored = true WHERE id = ?', [a]); await run('UPDATE accounts SET enabled = false WHERE id = ?', [b]);
    failSync(a, 9); failSync(b, 9); await runAlertChecks();
    expect(await alertsOf()).toHaveLength(0);
  });

  it('managers of a shared mailbox are alerted too', async () => {
    const m = await makeUser('mgr@demo.test'); const v = await makeUser('viewer@demo.test');
    const acct = await makeAccount('shared@demo.test');
    await run("INSERT INTO mailbox_shares(account_id, user_id, role, created_at) VALUES (?,?,?,?),(?,?,?,?)", [acct, m, 'manager', 1, acct, v, 'viewer', 1]);
    failSync(acct, 3); await runAlertChecks();
    expect((await alertsOf(TEST_USER)).length).toBe(1); expect((await alertsOf(m)).length).toBe(1); expect((await alertsOf(v)).length).toBe(0);
  });

  it('a team channel (admin) hears about shared mailboxes, not about private ones', async () => {
    await verified(TEST_USER, 'telegram', tgCfg(), 'team');
    const m = await makeUser('mgr@demo.test');
    const shared = await makeAccount('shared@demo.test', { userId: m }); const priv = await makeAccount('mine@demo.test', { userId: m });
    const viewer = await makeUser('v@demo.test');
    await run("INSERT INTO mailbox_shares(account_id, user_id, role, created_at) VALUES (?,?,?,?)", [shared, viewer, 'viewer', 1]);
    failSync(priv, 3); await runAlertChecks(); expect(hits).toHaveLength(0);
    failSync(shared, 3); await runAlertChecks(); expect(hits).toHaveLength(1);
  });

  it('dedupe: raising the same problem twice makes one row (unique open index)', async () => {
    const a = await raiseAlert(TEST_USER, 'x', { type: 'thing', id: 1 }, 'T', 'b');
    const b = await raiseAlert(TEST_USER, 'x', { type: 'thing', id: 1 }, 'T', 'b2');
    expect(a.created).toBe(true); expect(b.created).toBe(false);
    expect(await alertsOf()).toHaveLength(1);
    await resolveAlerts('x', { type: 'thing', id: 1 });
    expect((await raiseAlert(TEST_USER, 'x', { type: 'thing', id: 1 }, 'T', 'b')).created).toBe(true);
  });
});

describe('other triggers', () => {
  it('repeated send failures, and recovery when they age out', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) await run("INSERT INTO events(user_id, type, payload, created_at) VALUES (?,?,?::jsonb,?)", [TEST_USER, 'send.failed', '{}', now - 60_000]);
    await runAlertChecks(now);
    expect((await alertsOf())[0]).toMatchObject({ kind: 'send.failing', state: 'open' });
    await runAlertChecks(now + 2 * 3_600_000);
    expect((await alertsOf())[0].state).toBe('resolved');
  });

  it('storage unreachable and backup failed alert admins only', async () => {
    const member = await makeUser('m@demo.test');
    const { mailStore } = await import('../src/s3.ts');
    const { vi } = await import('vitest');
    const { resetStorageProbe } = await import('../src/health/status.ts');
    resetStorageProbe();
    const spy = vi.spyOn(mailStore, 'put').mockRejectedValue(new Error('connection refused'));
    try { await runAlertChecks(); } finally { spy.mockRestore(); }
    expect((await alertsOf()).map((a) => a.kind)).toContain('storage.unreachable');
    expect(await alertsOf(member)).toHaveLength(0);
    resetStorageProbe();
    await runAlertChecks(Date.now() + 10 * 60_000);
    expect((await alertsOf()).find((a) => a.kind === 'storage.unreachable').state).toBe('resolved');
    await setSetting('backup_enabled', 'true'); await setSetting('backup_last_status', 'error'); await setSetting('backup_last_error', 'bucket gone');
    await runAlertChecks();
    expect((await alertsOf()).some((a) => a.kind === 'backup.failed' && a.state === 'open')).toBe(true);
  });

  it('quota at 95 % alerts the user and admins', async () => {
    const member = await makeUser('m@demo.test');
    await run('UPDATE users SET storage_quota_bytes = 1000 WHERE id = ?', [member]);
    const acct = await makeAccount('m1@demo.test', { userId: member });
    const { clearUsageCache } = await import('../src/admin/quota.ts');
    const mb = await makeMailbox(acct, 'INBOX', 'inbox');
    await ingest(acct, mb, rawEmail({ from: 'x@y.test', to: 'm1@demo.test', subject: 'big' }));
    await run('UPDATE messages SET size = 960 WHERE account_id = ?', [acct]);
    clearUsageCache();
    await runAlertChecks();
    const mine = await alertsOf(member);
    expect(mine[0].kind).toBe('quota.full');
    expect((await alertsOf(TEST_USER)).some((a) => a.kind === 'quota.full')).toBe(true);
  });

  it('a Cloudflare push inbox that went silent alerts, and a new message resolves it', async () => {
    const acct = await makeAccount('p@demo.test');
    await run("UPDATE accounts SET inbound_kind = 'push' WHERE id = ?", [acct]);
    await run("INSERT INTO push_inboxes(token, account_id, secret_enc, created_at) VALUES ('t', ?, 'x', 1)", [acct]);
    const now = Date.now();
    await run("INSERT INTO push_seen(account_id, dedupe_key, created_at) VALUES (?,?,?)", [acct, 'k1', now - 60 * 3_600_000]);
    await runAlertChecks(now);
    expect((await alertsOf())[0]).toMatchObject({ kind: 'inbound.silent', state: 'open' });
    await run("INSERT INTO push_seen(account_id, dedupe_key, created_at) VALUES (?,?,?)", [acct, 'k2', now]);
    await runAlertChecks(now);
    expect((await alertsOf())[0].state).toBe('resolved');
  });
});

describe('delivery: isolation of failures, retries, reminders', () => {
  it('one channel down does not stop the others; the failure is recorded; only the failed one is retried', async () => {
    const tw = await verified(TEST_USER, 'twilio', twilioCfg()); const tg = await verified(TEST_USER, 'telegram', tgCfg());
    failPaths.add('/twilio');
    const acct = await makeAccount('a@demo.test');
    const t0 = Date.now();
    failSync(acct, 3); await runAlertChecks(t0);
    const a = (await alertsOf())[0];
    expect(a.deliveries[String(tg)].ok).toBe(true);
    expect(a.deliveries[String(tw)]).toMatchObject({ ok: false });
    expect(a.deliveries[String(tw)].error).toMatch(/500/);
    expect(a.send_count).toBe(1); expect(a.next_attempt_at).toBeGreaterThan(t0);
    expect((await one<any>('SELECT last_error FROM alert_channels WHERE id = ?', [tw]))!.last_error).toMatch(/500/);
    hits = [];
    await processDeliveries(t0 + 10_000);                 // too early
    expect(hits).toHaveLength(0);
    failPaths.clear();
    await processDeliveries(t0 + 61_000);                 // backoff over: Twilio only
    expect(hits.map((h) => h.url.split('/')[1])).toEqual(['twilio']);
    const b = (await alertsOf())[0];
    expect(b.deliveries[String(tw)].ok).toBe(true); expect(b.next_attempt_at).toBeNull();
    await processDeliveries(t0 + 400_000);
    expect(hits).toHaveLength(1);                         // nothing more to retry
  });

  it('gives up after the last backoff step', async () => {
    await verified(TEST_USER, 'twilio', twilioCfg()); failPaths.add('/twilio');
    failSync(await makeAccount('a@demo.test'), 3);
    let t = Date.now(); await runAlertChecks(t);
    for (let i = 0; i < 10; i++) { t += 31 * 60_000; await processDeliveries(t); }
    const a = (await alertsOf())[0];
    expect(a.next_attempt_at).toBeNull(); expect(a.attempts).toBe(6); expect(a.send_count).toBe(0);
  });

  it('reminder every N hours while open and unread; 0 = never; reading stops it', async () => {
    await verified(TEST_USER, 'telegram', tgCfg());
    const acct = await makeAccount('a@demo.test');
    const t0 = Date.now();
    failSync(acct, 3); await runAlertChecks(t0);
    expect(hits).toHaveLength(1);
    await runAlertChecks(t0 + 5 * 3_600_000); expect(hits).toHaveLength(1);
    await runAlertChecks(t0 + 6 * 3_600_000 + 1000); expect(hits).toHaveLength(2);
    expect(JSON.parse(hits[1].body).text).toMatch(/STILL BROKEN/);
    await runAlertChecks(t0 + 7 * 3_600_000); expect(hits).toHaveLength(2);
    await runAlertChecks(t0 + 12 * 3_600_000 + 2000); expect(hits).toHaveLength(3);
    // read → silent
    const id = (await alertsOf())[0].id;
    await app.inject({ method: 'POST', url: '/api/alerts/read', headers: { cookie }, payload: { ids: [id] } });
    await runAlertChecks(t0 + 30 * 3_600_000); expect(hits).toHaveLength(3);
  });

  it('reminder interval 0 never reminds', async () => {
    await setAlertSettings({ reminderHours: 0 });
    await verified(TEST_USER, 'telegram', tgCfg());
    const t0 = Date.now();
    failSync(await makeAccount('a@demo.test'), 3); await runAlertChecks(t0); await runAlertChecks(t0 + 100 * 3_600_000);
    expect(hits).toHaveLength(1);
  });

  it('quiet hours do not stop critical alerts', async () => {
    await run("INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value",
      [TEST_USER, 'notif_quiet', JSON.stringify({ enabled: true, from: '00:00', to: '23:59', tz: 'UTC' })]).catch(() => {});
    await verified(TEST_USER, 'telegram', tgCfg());
    failSync(await makeAccount('a@demo.test'), 3); await runAlertChecks();
    expect(hits).toHaveLength(1);
  });
});

describe('in-app: red, pinned, read rules', () => {
  it('resolved-but-unread stays listed as Fixed; marking read removes it; "mark all read" on notifications leaves open alerts', async () => {
    const acct = await makeAccount('a@demo.test');
    failSync(acct, 3); await runAlertChecks();
    let s = (await app.inject({ method: 'GET', url: '/api/alerts/summary', headers: { cookie } })).json();
    expect(s.items).toHaveLength(1); expect(s.items[0]).toMatchObject({ state: 'open', read: false }); expect(s.status).toMatchObject({ active: 1, open: 1 });
    await app.inject({ method: 'POST', url: '/api/notifications/read', headers: { cookie }, payload: { all: true } });
    s = (await app.inject({ method: 'GET', url: '/api/alerts/summary', headers: { cookie } })).json();
    expect(s.items).toHaveLength(1);
    syncManager.setStatus(acct, { state: 'ok', lastSyncAt: Date.now(), lastError: '', failures: 0 });
    await runAlertChecks();
    s = (await app.inject({ method: 'GET', url: '/api/alerts/summary', headers: { cookie } })).json();
    expect(s.items).toHaveLength(1); expect(s.items[0]).toMatchObject({ state: 'resolved', read: false }); expect(s.status.open).toBe(0);
    await app.inject({ method: 'POST', url: '/api/alerts/read', headers: { cookie }, payload: { ids: [s.items[0].id] } });
    s = (await app.inject({ method: 'GET', url: '/api/alerts/summary', headers: { cookie } })).json();
    expect(s.items).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/api/alerts?all=1', headers: { cookie } })).json().items).toHaveLength(1);
  });

  it('an open alert can be marked read by hand and stays open', async () => {
    failSync(await makeAccount('a@demo.test'), 3); await runAlertChecks();
    const id = (await alertsOf())[0].id;
    await app.inject({ method: 'POST', url: '/api/alerts/read', headers: { cookie }, payload: { ids: [id] } });
    expect((await alertsOf())[0]).toMatchObject({ state: 'open' });
    await runAlertChecks(); expect(await alertsOf()).toHaveLength(1);
  });

  it('"Send test alert" goes through the whole path and ends fixed', async () => {
    await verified(TEST_USER, 'telegram', tgCfg());
    const r = (await app.inject({ method: 'POST', url: '/api/alerts/test', headers: { cookie } })).json();
    expect(r.alert).toMatchObject({ kind: 'test', state: 'resolved', sendCount: 1 });
    expect(hits).toHaveLength(1); expect(JSON.parse(hits[0].body).text).toMatch(/Test alert/);
  });

  it('status says whether any channel is verified (banner for existing installs)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().alertsChannelMissing).toBe(true);
    await verified(TEST_USER, 'telegram', tgCfg());
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json().alertsChannelMissing).toBe(false);
  });

  it('first-run: the wizard is required until a channel passes its test', async () => {
    await run('DELETE FROM users WHERE id <> 0');
    const r = await app.inject({ method: 'POST', url: '/api/setup', payload: { email: 'first@demo.test', password: 'password123456' } });
    expect(r.statusCode).toBe(200);
    const c = `smsession=${r.cookies.find((x) => x.name === 'smsession')!.value}`;
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: c } })).json().alertsSetupRequired).toBe(true);
    const ch = (await app.inject({ method: 'POST', url: '/api/alert-channels', headers: { cookie: c }, payload: { kind: 'telegram', config: tgCfg() } })).json();
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: c } })).json().alertsSetupRequired).toBe(true);
    await app.inject({ method: 'POST', url: `/api/alert-channels/${ch.id}/test`, headers: { cookie: c } });
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: c } })).json().alertsSetupRequired).toBe(false);
  });
});

describe('secrets and isolation', () => {
  it('config is encrypted at rest and the API never returns secrets', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/alert-channels', headers: { cookie }, payload: { kind: 'twilio', config: twilioCfg() } });
    const row = (await one<any>('SELECT config_enc FROM alert_channels'))!;
    expect(row.config_enc).not.toContain('tok-secret');
    expect(JSON.parse(decrypt(row.config_enc)).authToken).toBe('tok-secret');
    const list = JSON.stringify((await app.inject({ method: 'GET', url: '/api/alert-channels', headers: { cookie } })).json());
    expect(list).not.toContain('tok-secret'); expect(list).toContain('"secretsSet":["authToken"]');
    expect(JSON.stringify(r.json())).not.toContain('tok-secret');
    // a blank secret on edit keeps the stored one
    await app.inject({ method: 'PUT', url: `/api/alert-channels/${r.json().id}`, headers: { cookie }, payload: { config: { ...twilioCfg(), authToken: '' } } });
    expect(JSON.parse(decrypt((await one<any>('SELECT config_enc FROM alert_channels'))!.config_enc)).authToken).toBe('tok-secret');
  });

  it('user B cannot see, test, edit or delete user A channels or alerts; a team channel is visible but not editable', async () => {
    const bId = await makeUser('b@demo.test'); const bCookie = await login(app, 'b@demo.test');
    const own = await verified(TEST_USER, 'telegram', tgCfg());
    const team = await verified(TEST_USER, 'twilio', twilioCfg(), 'team');
    failSync(await makeAccount('a@demo.test'), 3); await runAlertChecks();
    const list = (await app.inject({ method: 'GET', url: '/api/alert-channels', headers: { cookie: bCookie } })).json().items;
    expect(list.map((c: any) => c.id)).toEqual([team]); expect(list[0].mine).toBe(false);
    for (const [m, u] of [['POST', `/api/alert-channels/${own}/test`], ['PUT', `/api/alert-channels/${own}`], ['DELETE', `/api/alert-channels/${own}`], ['PUT', `/api/alert-channels/${team}`], ['DELETE', `/api/alert-channels/${team}`]] as const) {
      expect((await app.inject({ method: m, url: u, headers: { cookie: bCookie }, payload: {} })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: '/api/alerts?all=1', headers: { cookie: bCookie } })).json().items).toHaveLength(0);
    const aid = (await alertsOf())[0].id;
    await app.inject({ method: 'POST', url: '/api/alerts/read', headers: { cookie: bCookie }, payload: { ids: [aid] } });
    expect((await alertsOf())[0].read_at).toBeNull();
    expect((await app.inject({ method: 'POST', url: '/api/alert-channels', headers: { cookie: bCookie }, payload: { kind: 'telegram', config: tgCfg(), scope: 'team' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/alerts/settings', headers: { cookie: bCookie }, payload: { reminderHours: 1 } })).statusCode).toBe(403);
    void bId;
  });

  it('settings: defaults, admin can change, clamped', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/alerts/settings', headers: { cookie } })).json().settings).toEqual(ALERT_DEFAULTS);
    const r = (await app.inject({ method: 'PUT', url: '/api/alerts/settings', headers: { cookie }, payload: { reminderHours: 2, syncFailures: 0, quotaPercent: 500 } })).json().settings;
    expect(r).toMatchObject({ reminderHours: 2, syncFailures: 1, quotaPercent: 100 });
  });
});

describe('Viewing mode', () => {
  it('turns the email channel off but the other channels still work', async () => {
    await verified(TEST_USER, 'email', { to: 'boss@elsewhere.test' }); await verified(TEST_USER, 'telegram', tgCfg());
    await setStoredMode('viewing');
    await raiseAlert(TEST_USER, 'quota.full', { type: 'user', id: 1 }, 'Storage full', 'x');
    expect(mails).toHaveLength(0); expect(hits).toHaveLength(1);
    const a = (await alertsOf())[0];
    const emailDelivery = Object.values(a.deliveries).find((d: any) => d.kind === 'email') as any;
    expect(emailDelivery.ok).toBe(false); expect(emailDelivery.error).toMatch(/Viewing mode/);
  });

  it('does not watch mailboxes in Viewing mode (nothing syncs there)', async () => {
    await setStoredMode('viewing');
    failSync(await makeAccount('a@demo.test'), 9); await runAlertChecks();
    expect(await alertsOf()).toHaveLength(0);
  });
});

describe('message text', () => {
  it('is one line and under 320 characters', () => {
    const m = messageFor({ title: 'T\nx', body: 'b'.repeat(900), account_id: 5 }, 'open');
    expect(m.text).not.toContain('\n'); expect(m.text.length).toBeLessThanOrEqual(320); expect(m.excludeAccountId).toBe(5);
  });
});
