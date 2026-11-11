import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, makeUser, TEST_USER, rawEmail } from './helpers.ts';

const { q, one } = await import('../src/db.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');
const { sign } = await import('../src/transport/inbound/push.ts');
const { syncManager } = await import('../src/imap/sync.ts');

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let inbox: { token: string; secret: string; accountId: number };

const post = (raw: Buffer, o: { token?: string; secret?: string; ts?: number; rcpt?: string | null; sig?: string } = {}) => {
  const ts = String(o.ts ?? Date.now());
  return app.inject({
    method: 'POST', url: `/api/ingest/${o.token ?? inbox.token}`, payload: raw,
    headers: {
      'content-type': 'message/rfc822', 'x-seamless-timestamp': ts,
      ...(o.rcpt === null ? {} : { 'x-seamless-rcpt': o.rcpt ?? 'me@push.test' }),
      'x-seamless-signature': o.sig ?? sign(o.secret ?? inbox.secret, ts, raw),
    },
  });
};
const mail = (subject = 'Hi push', extra: Record<string, string> = {}) =>
  rawEmail({ from: 'Carol <carol@x.test>', to: 'me@push.test', subject, ...extra });

beforeEach(async () => {
  await resetDb(); resetLimiters();
  app = await makeApp();
  cookie = await login(app);
  const res = await app.inject({ method: 'POST', url: '/api/push-inboxes', headers: { cookie }, payload: { name: 'Push', email: 'me@push.test', domains: ['push.test'] } });
  expect(res.statusCode).toBe(200);
  const j = res.json();
  inbox = { token: j.token, secret: j.secret, accountId: j.accountId };
});
afterEach(() => { syncManager.removeAllListeners('newMail'); });

describe('push ingest', () => {
  it('valid HMAC → 202, stored in Inbox with delivered_to, risk assessed, newMail emitted', async () => {
    const seen: any[] = [];
    syncManager.on('newMail', (e) => seen.push(e));
    const res = await post(mail(), { rcpt: 'sales@push.test' });
    expect(res.statusCode).toBe(202);
    const id = res.json().id;
    const row = await one<any>('SELECT m.delivered_to, m.unread, mb.role FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?', [id]);
    expect(row).toMatchObject({ delivered_to: 'sales@push.test', role: 'inbox', unread: true });
    expect(await one('SELECT 1 FROM message_risk WHERE message_id = ?', [id])).toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ rowId: id, subject: 'Hi push', mailboxRole: 'inbox' });
  });

  it('falls back to Delivered-To header when no rcpt header', async () => {
    const res = await post(mail('Hdr', { deliveredTo: 'x@push.test' }), { rcpt: null });
    expect(res.statusCode).toBe(202);
    expect((await one<any>('SELECT delivered_to FROM messages WHERE id = ?', [res.json().id])).delivered_to).toBe('x@push.test');
  });

  it('bad HMAC → 401 and nothing stored', async () => {
    const res = await post(mail(), { secret: 'wrong' });
    expect(res.statusCode).toBe(401);
    expect(await q('SELECT 1 FROM messages')).toHaveLength(0);
  });

  it('tampered body → 401', async () => {
    const raw = mail();
    const ts = String(Date.now());
    const res = await post(Buffer.concat([raw, Buffer.from('x')]), { ts: Number(ts), sig: sign(inbox.secret, ts, raw) });
    expect(res.statusCode).toBe(401);
  });

  it('timestamp 6 minutes old → 401; 4 minutes old is fine', async () => {
    expect((await post(mail(), { ts: Date.now() - 6 * 60_000 })).statusCode).toBe(401);
    expect((await post(mail('ok'), { ts: Date.now() - 4 * 60_000 })).statusCode).toBe(202);
  });

  it('duplicate POST → one row', async () => {
    const raw = mail('Once');
    const a = await post(raw); const b = await post(raw);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ id: a.json().id, duplicate: true });
    expect(await q('SELECT 1 FROM messages')).toHaveLength(1);
  });

  it('unknown token → 404', async () => {
    expect((await post(mail(), { token: 'nope' })).statusCode).toBe(404);
  });

  it('oversize → 413', async () => {
    const res = await post(Buffer.alloc(30 * 1024 * 1024 + 1024, 'a'));
    expect(res.statusCode).toBe(413);
  });

  it('repeated bad signatures are rate limited', async () => {
    for (let i = 0; i < 20; i++) await post(mail(), { secret: 'wrong' });
    expect((await post(mail())).statusCode).toBe(429);
  });

  it('rotating the secret invalidates the old one', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/push-inboxes/${inbox.token}/rotate`, headers: { cookie } });
    const next = r.json().secret;
    expect(next).not.toBe(inbox.secret);
    expect((await post(mail(), { secret: inbox.secret })).statusCode).toBe(401);
    expect((await post(mail('new'), { secret: next })).statusCode).toBe(202);
  });

  it('"Send test" lands a message in the inbox', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/push-inboxes/${inbox.token}/test`, headers: { cookie } });
    expect(r.json()).toMatchObject({ ok: true, status: 202 });
    expect((await one<any>("SELECT subject FROM messages WHERE account_id = ?", [inbox.accountId])).subject).toBe('Seamless push inbound test');
  });

  it('the secret is stored encrypted and not listed', async () => {
    const stored = await one<any>('SELECT secret_enc FROM push_inboxes WHERE token = ?', [inbox.token]);
    expect(stored.secret_enc).not.toContain(inbox.secret);
    const list = await app.inject({ method: 'GET', url: '/api/push-inboxes', headers: { cookie } });
    expect(JSON.stringify(list.json())).not.toContain(inbox.secret);
    expect(list.json()[0]).toMatchObject({ token: inbox.token, domains: ['push.test'] });
  });

  it('validates domains', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/push-inboxes', headers: { cookie }, payload: { name: 'x', domains: ['not a domain'] } });
    expect(r.statusCode).toBe(400);
  });
});

describe('push inbox isolation', () => {
  it("user B can't list, rotate or test user A's inbox", async () => {
    await makeUser('b@local');
    const bCookie = await login(app, 'b@local');
    expect((await app.inject({ method: 'GET', url: '/api/push-inboxes', headers: { cookie: bCookie } })).json()).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/push-inboxes/${inbox.token}/rotate`, headers: { cookie: bCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/push-inboxes/${inbox.token}/test`, headers: { cookie: bCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/push-inboxes', headers: { cookie: bCookie }, payload: { domains: ['b.test'], transportId: 999 } })).statusCode).toBe(400);
  });
  it('mail lands only in the owner’s account', async () => {
    const res = await post(mail());
    expect((await one<any>('SELECT user_id FROM messages WHERE id = ?', [res.json().id])).user_id).toBe(TEST_USER);
  });
});
