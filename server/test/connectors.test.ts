/** T5.2 F-36: DMS / BizBooks / task connectors, extraction, rule actions, isolation. */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import http from 'node:http';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const { q, run } = await import('../src/db.ts');
const { runDueJobs } = await import('../src/jobs/runner.ts');
const { setLookupForTests } = await import('../src/integrations/ssrf.ts');
const { clearParsedCache } = await import('../src/mail/body.ts');
const { regexBill, normaliseDate, setExtractorForTests } = await import('../src/integrations/extract.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
let hits: Hit[] = [];
const echo = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { hits.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = 200; res.end('{"ok":true}'); });
});
await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${(echo.address() as any).port}`;
afterAll(() => { echo.close(); });

let A: number, B: number, ADMIN: number, acct: number, inbox: number;
let app: Awaited<ReturnType<typeof makeApp>>;
let cka = '', ckb = '', ckAdmin = '';
const api = (ck: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck } });

beforeEach(async () => {
  await resetDb(); resetLimiters(); hits = []; setLookupForTests(); clearParsedCache(); setExtractorForTests(async () => null);
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test'); ADMIN = await makeUser('admin@x.test', 'admin');
  acct = await makeAccount('a@demo.test', { userId: A });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  app = await makeApp();
  cka = await login(app, 'a@x.test'); ckb = await login(app, 'b@x.test'); ckAdmin = await login(app, 'admin@x.test');
  await api(ckAdmin, 'POST', '/api/webhook-allowlist', { value: '127.0.0.1' });
});
afterEach(() => { setLookupForTests(); setExtractorForTests(); });

const mkConn = async (connector: string, connectorConfig: any, cookie = cka) =>
  (await api(cookie, 'POST', '/api/webhooks', { name: connector, connector, connectorConfig })).json();
const pdfMail = (subject: string, body: string, withPdf = true) => Buffer.from([
  'From: Acme Pty Ltd <billing@acme.test>', 'To: a@demo.test', `Subject: ${subject}`, 'Date: Wed, 08 Jul 2026 10:00:00 +0000',
  'Message-ID: <bill1@acme.test>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '',
  '--B', 'Content-Type: text/plain; charset=utf-8', '', body, '',
  ...(withPdf ? ['--B', 'Content-Type: application/pdf; name="inv.pdf"', 'Content-Disposition: attachment; filename="inv.pdf"', 'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 fake').toString('base64'), ''] : []),
  '--B--', '',
].join('\r\n'));
const addPdf = async (subject = 'Invoice INV-1042', body = 'Invoice INV-1042\nABN 51 824 753 556\nGST $10.00\nTotal due: $110.00\nDue date: 15/08/2026') =>
  (await ingest(acct, inbox, pdfMail(subject, body)))!.rowId as number;
const runJobs = async () => { await run("UPDATE jobs SET run_at = 0 WHERE kind = 'webhook.deliver' AND status = 'pending'"); await runDueJobs(); };

describe('extraction', () => {
  it('regex fallback finds ABN, totals, GST, due date and invoice number', () => {
    const f = regexBill('Tax Invoice No: INV-1042\nABN 51 824 753 556\nGST $10.00\nTotal due: $1,110.50\nDue date: 5 March 2026', 'Acme');
    expect(f).toEqual({ supplier: 'Acme', abn: '51824753556', total: 1110.5, gst: 10, dueDate: '2026-03-05', invoiceNumber: 'INV-1042' });
    expect(normaliseDate('5/3/26')).toBe('2026-03-05');
  });
});

describe('DMS connector', () => {
  it('POSTs multipart with the attachment, metadata JSON and bearer token', async () => {
    const c = await mkConn('dms', { baseUrl: BASE, token: 'dms-token' });
    expect(c.connector).toBe('dms'); expect(JSON.stringify(c)).not.toContain('dms-token');
    const id = await addPdf();
    const r = (await api(cka, 'POST', `/api/messages/m${id}/send-to/dms`, {})).json();
    expect(r.ok).toBe(true);
    expect(hits).toHaveLength(1);
    const h = hits[0];
    expect(h.method).toBe('POST'); expect(h.url).toBe('/api/inbox/upload');
    expect(h.headers.authorization).toBe('Bearer dms-token');
    expect(h.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const text = h.body.toString('utf8');
    expect(text).toContain('name="file"; filename="inv.pdf"');
    expect(text).toContain('%PDF-1.4 fake');
    const meta = JSON.parse(text.match(/name="metadata"[^\r]*\r\nContent-Type: application\/json\r\n\r\n(.*)\r\n/)![1]);
    expect(meta).toMatchObject({ sender: 'billing@acme.test', subject: 'Invoice INV-1042', messageId: '<bill1@acme.test>' });
  });
  it('an email without attachments is not sent and is not retried', async () => {
    await mkConn('dms', { baseUrl: BASE, token: 't' });
    const id = (await ingest(acct, inbox, rawEmail({ from: 'x@y.test', to: 'a@demo.test', subject: 'none' })))!.rowId;
    const r = (await api(cka, 'POST', `/api/messages/m${id}/send-to/dms`, {})).json();
    expect(r.ok).toBe(false); expect(r.message).toContain('no attachments');
    expect(hits).toHaveLength(0);
    expect(await q("SELECT 1 FROM jobs WHERE kind = 'webhook.deliver' AND status = 'pending'")).toHaveLength(0);
  });
});

describe('BizBooks connector', () => {
  it('regex fallback fills the JSON fields without an AI provider; PDF is base64', async () => {
    await mkConn('bizbooks', { baseUrl: BASE, token: 'bb' });
    const id = await addPdf();
    expect((await api(cka, 'POST', `/api/messages/m${id}/send-to/bizbooks`, {})).json().ok).toBe(true);
    const h = hits[0];
    expect(h.url).toBe('/api/bills-inbox'); expect(h.headers.authorization).toBe('Bearer bb');
    const b = JSON.parse(h.body.toString());
    expect(b).toMatchObject({ supplier: 'Acme Pty Ltd', abn: '51824753556', total: 110, gst: 10, dueDate: '2026-08-15', invoiceNumber: 'INV-1042', messageId: '<bill1@acme.test>' });
    expect(Buffer.from(b.pdfBase64, 'base64').toString()).toBe('%PDF-1.4 fake');
  });
  it('AI extraction (stub) overrides regex values and regex fills gaps', async () => {
    setExtractorForTests(async () => ({ supplier: 'Acme Trading', total: 999.5, abn: null, dueDate: '2026-09-01' }));
    await mkConn('bizbooks', { baseUrl: BASE, token: 'bb' });
    const id = await addPdf();
    await api(cka, 'POST', `/api/messages/m${id}/send-to/bizbooks`, {});
    expect(JSON.parse(hits[0].body.toString())).toMatchObject({ supplier: 'Acme Trading', total: 999.5, dueDate: '2026-09-01', abn: '51824753556', gst: 10 });
  });
});

describe('task connectors', () => {
  it('Todoist: JSON with subject, link back and AI due date', async () => {
    setExtractorForTests(async (_u, task) => (task === 'task' ? { dueDate: '2026-07-20' } : null));
    await mkConn('todoist', { baseUrl: BASE, token: 'td', projectId: '77' });
    const id = await addPdf('Please review contract');
    const r = (await api(cka, 'POST', `/api/messages/m${id}/send-to/tasks`, {})).json();
    expect(r.ok).toBe(true);
    expect(hits[0].method).toBe('POST'); expect(hits[0].url).toBe('/rest/v2/tasks'); expect(hits[0].headers.authorization).toBe('Bearer td');
    expect(JSON.parse(hits[0].body.toString())).toEqual({ content: 'Please review contract', description: `http://localhost:4900/mail/msg/m${id}`.replace('http://localhost:4900', (await import('../src/config.ts')).config.publicUrl), due_date: '2026-07-20', project_id: '77' });
  });
  it('Vikunja: PUT to the project tasks path', async () => {
    await mkConn('vikunja', { baseUrl: BASE, token: 'vk', projectId: '5' });
    const id = await addPdf('Call back');
    await api(cka, 'POST', `/api/messages/m${id}/send-to/tasks`, {});
    expect(hits[0].method).toBe('PUT'); expect(hits[0].url).toBe('/api/v1/projects/5/tasks');
    expect(JSON.parse(hits[0].body.toString())).toMatchObject({ title: 'Call back' });
  });
  it('generic task webhook is signed', async () => {
    const c = await mkConn('task-webhook', { baseUrl: `${BASE}/t` });
    const id = await addPdf('Generic');
    await api(cka, 'POST', `/api/messages/m${id}/send-to/tasks`, {});
    expect(hits[0].url).toBe('/t'); expect(String(hits[0].headers['x-seamless-signature'])).toMatch(/^sha256=/);
    expect(JSON.parse(hits[0].body.toString()).title).toBe('Generic'); expect(c.id).toBeGreaterThan(0);
  });
  it('validates required config', async () => {
    expect((await api(cka, 'POST', '/api/webhooks', { name: 'x', connector: 'vikunja', connectorConfig: { baseUrl: BASE, token: 't' } })).statusCode).toBe(400);
    expect((await api(cka, 'POST', '/api/webhooks', { name: 'x', connector: 'nope', connectorConfig: {} })).statusCode).toBe(400);
  });
});

describe('summary + buttons', () => {
  it('only reports connectors that are set up', async () => {
    expect((await api(cka, 'GET', '/api/connectors')).json()).toEqual({ dms: false, bizbooks: false, tasks: false });
    await mkConn('dms', { baseUrl: BASE, token: 't' });
    expect((await api(cka, 'GET', '/api/connectors')).json()).toEqual({ dms: true, bizbooks: false, tasks: false });
    const id = await addPdf();
    expect((await api(cka, 'POST', `/api/messages/m${id}/send-to/bizbooks`, {})).statusCode).toBe(400);
  });
});

describe('rule actions', () => {
  it('a filter with send_to_dms queues exactly one delivery on ingest and never blocks it', async () => {
    const c = await mkConn('dms', { baseUrl: BASE, token: 't' });
    await api(cka, 'POST', '/api/filters', { name: 'bills', match: 'all', conditions: [{ field: 'subject', op: 'contains', value: 'Invoice' }], actions: [{ type: 'send_to_dms' }, { type: 'send_to_dms' }] });
    await api(cka, 'POST', '/api/filters', { name: 'bills2', match: 'all', conditions: [{ field: 'from', op: 'contains', value: 'acme' }], actions: [{ type: 'send_to_dms' }] });
    const r = await ingest(acct, inbox, pdfMail('Invoice 7', 'Total due: $5.00'), { isLive: true });
    expect(r).toBeTruthy();
    expect(await q('SELECT 1 FROM webhook_deliveries WHERE webhook_id = ?', [c.id])).toHaveLength(1);   // three identical actions across two filters → one delivery
    await runJobs();
    expect(hits).toHaveLength(1);
  });
  it('send_to_webhook(id) queues a delivery to that plain webhook; unknown id is ignored', async () => {
    const w = (await api(cka, 'POST', '/api/webhooks', { name: 'plain', url: `${BASE}/p`, eventTypes: ['mail.received'] })).json();
    await api(cka, 'POST', '/api/filters', { name: 'f', match: 'all', conditions: [{ field: 'subject', op: 'contains', value: 'Hi' }], actions: [{ type: 'send_to_webhook', value: String(w.id) }, { type: 'send_to_webhook', value: '99999' }] });
    await ingest(acct, inbox, rawEmail({ from: 'x@y.test', to: 'a@demo.test', subject: 'Hi there' }), { isLive: true });
    await runJobs();
    const mine = hits.filter((h) => h.url === '/p');
    expect(mine).toHaveLength(1);
    expect(JSON.parse(mine[0].body.toString()).type).toBe('connector.send');
  });
});

describe('isolation', () => {
  it("B cannot send A's mail through B's connector, nor use A's connector", async () => {
    await mkConn('dms', { baseUrl: BASE, token: 'a' });
    const bc = await mkConn('dms', { baseUrl: BASE, token: 'b' }, ckb);
    const id = await addPdf();
    expect((await api(ckb, 'POST', `/api/messages/m${id}/send-to/dms`, {})).statusCode).toBe(404);
    expect((await api(ckb, 'POST', `/api/messages/m${id}/send-to/dms`, { webhookId: 1 })).statusCode).toBe(404);
    expect(hits).toHaveLength(0);
    expect((await api(ckb, 'GET', '/api/webhooks')).json().items.map((w: any) => w.id)).toEqual([bc.id]);
  });
});
