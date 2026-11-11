/** T5.1 F-36: outgoing webhooks — signing, retries, SSRF guard, filters, signed blob URLs, isolation. */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const { q, one, run } = await import('../src/db.ts');
const { emitEvent } = await import('../src/events/emit.ts');
const { runDueJobs } = await import('../src/jobs/runner.ts');
const { setLookupForTests, resolveTarget, SsrfError, isBlockedIp, safeRequest } = await import('../src/integrations/ssrf.ts');
const { clearParsedCache } = await import('../src/mail/body.ts');
const W = await import('../src/integrations/webhooks.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

interface Hit { headers: http.IncomingHttpHeaders; body: string }
let hits: Hit[] = [];
let respond = { status: 200, text: 'ok' };
const echo = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }); res.statusCode = respond.status; res.end(respond.text); });
});
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
const URL_ECHO = `http://127.0.0.1:${(echo.address() as any).port}/hook`;
afterAll(() => { echo.close(); });

let A: number, B: number, ADMIN: number, acct: number, inbox: number;
let app: Awaited<ReturnType<typeof makeApp>>;
let cka = '', ckb = '', ckAdmin = '';
const api = (ck: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck } });
const allowLocal = () => api(ckAdmin, 'POST', '/api/webhook-allowlist', { value: '127.0.0.1' });

beforeEach(async () => {
  await resetDb(); resetLimiters(); hits = []; respond = { status: 200, text: 'ok' }; setLookupForTests(); clearParsedCache();
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test'); ADMIN = await makeUser('admin@x.test', 'admin');
  acct = await makeAccount('a@demo.test', { userId: A });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  app = await makeApp();
  cka = await login(app, 'a@x.test'); ckb = await login(app, 'b@x.test'); ckAdmin = await login(app, 'admin@x.test');
});
afterEach(() => setLookupForTests());

const mkHook = async (o: any = {}) => (await api(cka, 'POST', '/api/webhooks', { name: 'Hook', url: URL_ECHO, eventTypes: ['mail.received'], ...o })).json();
const addMail = async (subject = 'Quote', from = 'bob@shop.test', extra: any = {}) => {
  const r = await ingest(acct, inbox, extra.raw ?? rawEmail({ from, to: 'a@demo.test', subject }));
  return r!.rowId as number;
};
const fire = (rowId: number) => emitEvent(A, 'mail.received', { type: 'message', id: rowId }, { messageId: rowId, subject: 'x' });
const deliveries = (hookId: number) => q<any>('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id', [hookId]);
const runJobs = async () => { await run("UPDATE jobs SET run_at = 0 WHERE kind = 'webhook.deliver' AND status = 'pending'"); await runDueJobs(); };

describe('delivery + signature', () => {
  it('POSTs a signed body that a reference implementation verifies', async () => {
    await allowLocal();
    const hook = await mkHook();
    expect(hook.secret).toMatch(/^whsec_/);
    const id = await addMail('Hello there');
    await fire(id);
    await runJobs();
    expect(hits).toHaveLength(1);
    const h = hits[0];
    const ts = String(h.headers['x-seamless-timestamp']);
    const expected = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(`${ts}.${h.body}`).digest('hex');
    expect(h.headers['x-seamless-signature']).toBe(expected);
    expect(h.headers['x-seamless-event']).toBe('mail.received');
    const body = JSON.parse(h.body);
    expect(body.type).toBe('mail.received');
    expect(body.id).toMatch(/^evt_\d+$/);
    expect(body.data.message.subject).toBe('Hello there');
    expect(body.data.message.text).toBeUndefined();   // metadata level
    const [d] = await deliveries(hook.id);
    expect(d.status).toBe('ok'); expect(d.http_status).toBe(200); expect(d.attempts).toBe(1);
    expect(String(h.headers['x-seamless-delivery'])).toBe(String(d.id));
    expect(d.request_body).toContain('Hello there');
  });

  it('does not store the secret in clear and rotates to a new one', async () => {
    const hook = await mkHook();
    const row = await one<any>('SELECT secret_enc FROM webhooks WHERE id = ?', [hook.id]);
    expect(row.secret_enc).not.toContain(hook.secret);
    const rot = (await api(cka, 'POST', `/api/webhooks/${hook.id}/rotate`)).json();
    expect(rot.secret).not.toBe(hook.secret);
    expect((await api(cka, 'GET', '/api/webhooks')).body).not.toContain(rot.secret);
  });

  it('include=body adds text/html', async () => {
    await allowLocal();
    const hook = await mkHook({ include: 'body' });
    await fire(await addMail('With body', 'bob@shop.test', { raw: rawEmail({ from: 'bob@shop.test', to: 'a@demo.test', subject: 'With body', body: 'plain words' }) }));
    await runJobs();
    expect(JSON.parse(hits[0].body).data.message.text).toContain('plain words');
  });

  it('test event delivers once and leaves no retry behind', async () => {
    await allowLocal();
    const hook = await mkHook();
    respond = { status: 500, text: 'boom' };
    const d = (await api(cka, 'POST', `/api/webhooks/${hook.id}/test`)).json();
    expect(d.eventType).toBe('webhook.test');
    expect(d.status).toBe('failed'); expect(d.httpStatus).toBe(500); expect(d.responseSnippet).toBe('boom');
    expect(await q("SELECT 1 FROM jobs WHERE kind = 'webhook.deliver' AND status = 'pending'")).toHaveLength(0);
    expect(JSON.parse(hits[0].body).type).toBe('webhook.test');
  });
});

describe('retries', () => {
  it('schedules 1m, 5m, 30m, 2h, 6h, 12h then gives up and emits webhook.failed', async () => {
    await allowLocal();
    const hook = await mkHook();
    respond = { status: 503, text: 'down' };
    await fire(await addMail());
    const [d0] = await deliveries(hook.id);
    const delays = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
    expect(W.RETRY_DELAYS_MS).toEqual(delays);
    let now = Date.now();
    for (let i = 0; i < delays.length; i++) {
      expect(await W.deliverOnce(Number(d0.id), now)).toBe('failed');
      const d = await one<any>('SELECT * FROM webhook_deliveries WHERE id = ?', [d0.id]);
      expect(Number(d.next_attempt_at)).toBe(now + delays[i]);
      expect(d.attempts).toBe(i + 1); expect(d.http_status).toBe(503);
      const job = await one<any>("SELECT run_at FROM jobs WHERE kind = 'webhook.deliver' AND status = 'pending' AND run_at = ?", [now + delays[i]]);
      expect(job).toBeTruthy();
      now += delays[i];
    }
    expect(await W.deliverOnce(Number(d0.id), now)).toBe('giving_up');
    const d = await one<any>('SELECT * FROM webhook_deliveries WHERE id = ?', [d0.id]);
    expect(d.status).toBe('giving_up'); expect(d.attempts).toBe(7); expect(d.next_attempt_at).toBeNull();
    const ev = await one<any>("SELECT payload FROM events WHERE type = 'webhook.failed' AND user_id = ?", [A]);
    expect(ev.payload.webhookId).toBe(hook.id);
    expect(await one("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'webhook.failed'", [A])).toBeTruthy();
    // finished deliveries are not attempted again
    expect(await W.deliverOnce(Number(d0.id), now)).toBe('giving_up');
    expect(hits).toHaveLength(7);
  });

  it('a later success stops the chain; redeliver resets and sends again', async () => {
    await allowLocal();
    const hook = await mkHook();
    respond = { status: 500, text: 'no' };
    await fire(await addMail());
    await runJobs();
    const [d] = await deliveries(hook.id);
    expect(d.status).toBe('failed');
    respond = { status: 200, text: 'yes' };
    expect((await api(cka, 'POST', `/api/webhook-deliveries/${d.id}/redeliver`)).statusCode).toBe(200);
    await runJobs();
    const [d2] = await deliveries(hook.id);
    expect(d2.status).toBe('ok'); expect(d2.attempts).toBe(1);
    expect(hits).toHaveLength(2);
    const log = (await api(cka, 'GET', `/api/webhooks/${hook.id}/deliveries`)).json().items;
    expect(log[0].responseSnippet).toBe('yes');
  });

  it('caps the stored response snippet at 2 KB', async () => {
    await allowLocal();
    const hook = await mkHook();
    respond = { status: 200, text: 'x'.repeat(10_000) };
    await fire(await addMail());
    await runJobs();
    const [d] = await deliveries(hook.id);
    expect(d.response_snippet.length).toBeLessThanOrEqual(2048);
  });
});

describe('SSRF guard', () => {
  it('blocks 127.0.0.1 when not allow-listed, and the delivery records why', async () => {
    const hook = await mkHook();
    await fire(await addMail());
    await runJobs();
    expect(hits).toHaveLength(0);
    const [d] = await deliveries(hook.id);
    expect(d.status).toBe('failed'); expect(d.last_error).toMatch(/blocked.*private or local/);
  });

  it('allows it once an admin allow-lists it (members cannot)', async () => {
    expect((await api(cka, 'POST', '/api/webhook-allowlist', { value: '127.0.0.1' })).statusCode).toBe(403);
    expect((await api(cka, 'GET', '/api/webhook-allowlist')).statusCode).toBe(403);
    expect((await api(ckAdmin, 'POST', '/api/webhook-allowlist', { value: 'not a host!' })).statusCode).toBe(400);
    expect((await allowLocal()).json().items).toHaveLength(1);
    const hook = await mkHook();
    await fire(await addMail());
    await runJobs();
    expect(hits).toHaveLength(1);
    expect((await q('SELECT 1 FROM webhooks WHERE id = ?', [hook.id]))).toHaveLength(1);
  });

  it('blocks a hostname that resolves to a private address (fake DNS), even mixed with a public one', async () => {
    const fake = async (h: string) => h === 'mixed.test' ? [{ address: '93.184.216.34', family: 4 }, { address: '10.1.2.3', family: 4 }] : [{ address: '10.0.0.5', family: 4 }];
    await expect(resolveTarget('http://internal.test/x', [], fake)).rejects.toBeInstanceOf(SsrfError);
    await expect(resolveTarget('http://mixed.test/x', [], fake)).rejects.toThrow(/10\.1\.2\.3/);
    // allow-listing the host name opens it
    expect((await resolveTarget('http://internal.test/x', ['internal.test'], fake)).address).toBe('10.0.0.5');
    // so does a CIDR covering the resolved address
    expect((await resolveTarget('http://internal.test/x', ['10.0.0.0/24'], fake)).address).toBe('10.0.0.5');
    // through the delivery path as well
    setLookupForTests(fake);
    const hook = await mkHook({ url: 'http://internal.test/hook' });
    await fire(await addMail());
    await runJobs();
    expect((await deliveries(hook.id))[0].last_error).toMatch(/10\.0\.0\.5/);
  });

  it('classifies address ranges', () => {
    for (const ip of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:10.0.0.1', '::'])
      expect(isBlockedIp(ip), ip).toBe(true);
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isBlockedIp(ip), ip).toBe(false);
  });

  it('only http/https, and a redirect is not followed', async () => {
    await expect(resolveTarget('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(resolveTarget('ftp://x.test/')).rejects.toThrow(/http/);
    const redir = http.createServer((_q, res) => { res.statusCode = 302; res.setHeader('Location', 'http://169.254.169.254/'); res.end(); });
    await new Promise<void>((r) => redir.listen(0, '127.0.0.1', r));
    const r = await safeRequest(`http://127.0.0.1:${(redir.address() as any).port}/`, { allow: ['127.0.0.1'] });
    expect(r.status).toBe(302);
    redir.close();
  });

  it('connects to the vetted IP, ignoring a later DNS answer', async () => {
    let calls = 0;
    const flip = async () => (++calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.9.9.9', family: 4 }]);
    const port = (echo.address() as any).port;
    const r = await safeRequest(`http://rebind.test:${port}/hook`, { lookup: flip, allow: ['127.0.0.1'], body: '{}' });
    expect(r.status).toBe(200);
    expect(hits[0].headers.host).toBe(`rebind.test:${port}`);
    expect(calls).toBe(1);
  });
});

describe('filter query + event types', () => {
  it('only mail matching filter_query is delivered; non-message events skip filtered hooks', async () => {
    await allowLocal();
    const hook = await mkHook({ filterQuery: 'from:boss@big.test' });
    await fire(await addMail('Match me', 'boss@big.test'));
    await fire(await addMail('Not me', 'other@x.test'));
    await emitEvent(A, 'mail.received', null, {});
    expect(await deliveries(hook.id)).toHaveLength(1);
    await runJobs();
    expect(JSON.parse(hits[0].body).data.message.subject).toBe('Match me');
  });

  it('ignores event types it did not subscribe to and inactive hooks', async () => {
    await allowLocal();
    const h1 = await mkHook({ eventTypes: ['mail.opened'] });
    const h2 = await mkHook({ active: false });
    await fire(await addMail());
    expect(await deliveries(h1.id)).toHaveLength(0);
    expect(await deliveries(h2.id)).toHaveLength(0);
  });

  it('validates input', async () => {
    expect((await api(cka, 'POST', '/api/webhooks', { name: 'x', url: 'ftp://a', eventTypes: ['mail.received'] })).statusCode).toBe(400);
    expect((await api(cka, 'POST', '/api/webhooks', { name: 'x', url: URL_ECHO, eventTypes: [] })).statusCode).toBe(400);
    expect((await api(cka, 'POST', '/api/webhooks', { name: 'x', url: URL_ECHO, eventTypes: ['nope'] })).statusCode).toBe(400);
    expect((await api(cka, 'POST', '/api/webhooks', { name: 'x', url: URL_ECHO, eventTypes: ['webhook.failed'] })).statusCode).toBe(400);
    expect((await api(cka, 'POST', '/api/webhooks', { name: 'x', url: URL_ECHO, eventTypes: ['mail.received'], include: 'all' })).statusCode).toBe(400);
  });
});

describe('signed blob URLs', () => {
  const withAttachment = () => Buffer.from([
    'From: bob@shop.test', 'To: a@demo.test', 'Subject: Invoice', 'Date: Wed, 08 Jul 2026 10:00:00 +0000', 'Message-ID: <inv1@test>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
    '--b1', 'Content-Type: text/plain', '', 'See attached', '',
    '--b1', 'Content-Type: application/pdf; name="inv.pdf"', 'Content-Disposition: attachment; filename="inv.pdf"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('%PDF-fake').toString('base64'), '--b1--', ''].join('\r\n'));

  it('include=raw carries working attachment and .eml URLs; they expire after 1 h', async () => {
    await allowLocal();
    const hook = await mkHook({ include: 'raw' });
    const rowId = await addMail('Invoice', 'bob@shop.test', { raw: withAttachment() });
    await fire(rowId);
    await runJobs();
    const m = JSON.parse(hits[0].body).data.message;
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0].filename).toBe('inv.pdf');
    const path = (u: string) => new URL(u).pathname;
    const att = await app.inject({ method: 'GET', url: path(m.attachments[0].url) });   // no cookie: public path
    expect(att.statusCode).toBe(200);
    expect(att.rawPayload.toString()).toBe('%PDF-fake');
    const eml = await app.inject({ method: 'GET', url: path(m.rawUrl) });
    expect(eml.statusCode).toBe(200);
    expect(eml.headers['content-type']).toContain('message/rfc822');
    expect(eml.body).toContain('Subject: Invoice');
    // expiry + tamper
    const token = path(m.rawUrl).split('/').pop()!;
    expect(W.verifyBlobToken(token)).toBeTruthy();
    expect(W.verifyBlobToken(token, Date.now() + 3_600_001)).toBeNull();
    expect((await app.inject({ method: 'GET', url: path(m.rawUrl).slice(0, -2) + 'xx' })).statusCode).toBe(404);
    const stale = W.signBlobToken({ u: A, m: rowId, p: 'raw' }, Date.now() - 2 * 3_600_000);
    expect((await app.inject({ method: 'GET', url: `/api/hooks/blob/${stale}` })).statusCode).toBe(404);
    expect(hook.id).toBeGreaterThan(0);
  });

  it("a token for user A's message does not open once access is gone (token minted for B on A's mail)", async () => {
    const rowId = await addMail();
    const forged = W.signBlobToken({ u: B, m: rowId, p: 'raw' });
    expect((await app.inject({ method: 'GET', url: `/api/hooks/blob/${forged}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/hooks/blob/${W.signBlobToken({ u: A, m: rowId, p: 'raw' })}` })).statusCode).toBe(200);
  });
});

describe('isolation', () => {
  it("user B cannot list, change, delete, test, rotate or read deliveries of A's webhook", async () => {
    await allowLocal();
    const hook = await mkHook();
    await fire(await addMail());
    const [d] = await deliveries(hook.id);
    expect((await api(ckb, 'GET', '/api/webhooks')).json().items).toHaveLength(0);
    expect((await api(ckb, 'PUT', `/api/webhooks/${hook.id}`, { name: 'hacked' })).statusCode).toBe(404);
    expect((await api(ckb, 'POST', `/api/webhooks/${hook.id}/rotate`)).statusCode).toBe(404);
    expect((await api(ckb, 'POST', `/api/webhooks/${hook.id}/test`)).statusCode).toBe(404);
    expect((await api(ckb, 'GET', `/api/webhooks/${hook.id}/deliveries`)).statusCode).toBe(404);
    expect((await api(ckb, 'POST', `/api/webhook-deliveries/${d.id}/redeliver`)).statusCode).toBe(404);
    expect((await api(ckb, 'DELETE', `/api/webhooks/${hook.id}`)).statusCode).toBe(404);
    expect((await api(cka, 'GET', '/api/webhooks')).json().items[0].name).toBe('Hook');
  });

  it("A's events never go to B's webhook", async () => {
    await allowLocal();
    await api(ckb, 'POST', '/api/webhooks', { name: 'B hook', url: URL_ECHO, eventTypes: ['mail.received'] });
    await fire(await addMail());
    expect(await q('SELECT 1 FROM webhook_deliveries')).toHaveLength(0);
  });

  it('unauthenticated requests are refused', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/webhooks' })).statusCode).toBe(401);
  });
});
