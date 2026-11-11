import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderTemplate, aiPlaceholders } from '@seamless/shared';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { run, insertId } from '../src/db.ts';
import { makeApp, login, resetLimiters } from './app.ts';

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let acct: number; let emailId: string; let identityId: number; let bizId: number;

const api = (method: any, url: string, body?: any, ck = cookie) => app.inject({ method, url, payload: body, headers: { cookie: ck } });
let aiCalls: string[] = [];
function stubAi(reply: (prompt: string) => string) {
  vi.stubGlobal('fetch', vi.fn(async (_u: any, init: any) => {
    const body = JSON.parse(init.body);
    aiCalls.push(body.messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: reply(body.messages[1].content) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}
async function enableAi() {
  const pid = await insertId("INSERT INTO ai_providers(user_id, name, base_url, api_key_enc, model) VALUES (?, 'stub','http://stub.test/v1','','m')", [TEST_USER]);
  await run('INSERT INTO ai_tasks(user_id, task, provider_id, model, enabled) VALUES (?,?,?,?,true)', [TEST_USER, 'draft', pid, '']);
}
const mk = async (over: any = {}) => { const r = await api('POST', '/api/templates', { name: 'T', subject: 'Re: {{original.subject}}', bodyHtml: '<p>Hi {{recipient.first_name}}</p>', ...over }); if (r.statusCode !== 200) throw new Error(r.body); return r.json().id as number; };

beforeEach(async () => {
  await resetDb(); resetLimiters(); aiCalls = [];
  acct = await makeAccount('alice@demo.test', { name: 'Alice Smith' });
  const inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  const r = await ingest(acct, inbox, rawEmail({ from: 'Jane Doe <jane@client.test>', to: 'alice@demo.test', subject: 'Quote please', body: 'Can you quote the office clean?', messageId: '<q1@c>', date: 'Wed, 08 Jul 2026 10:00:00 +0000' }));
  emailId = `m${r!.rowId}`;
  app = await makeApp(); cookie = await login(app);
  bizId = (await api('POST', '/api/businesses', { name: 'OCR Pty', phone: '0400 111' })).json().id;
  const ids = (await api('GET', '/api/identities')).json();
  identityId = ids[0].id;
  await api('PUT', `/api/identities/${identityId}`, { businessId: bizId });
});
afterEach(() => vi.unstubAllGlobals());

describe('F-31 variables', () => {
  it('new variables render from a fixture', () => {
    const out = renderTemplate('{{sender.first_name}}|{{original.subject}}|{{original.date}}|{{today}}|{{business.name}}|{{identity.email}}|{{bogus}}', {
      sender: { name: 'Alice Smith', email: 'a@x.test' }, original: { subject: 'Hello', date: Date.UTC(2026, 6, 8, 2) },
      now: new Date('2026-11-11T02:00:00Z'), business: { name: 'OCR' }, identity: { email: 'a@x.test' },
    }, { html: true, highlightUnknown: true });
    expect(out).toBe('Alice|Hello|8 July 2026|11 November 2026|OCR|a@x.test|<mark data-unknown-var>{{bogus}}</mark>');
  });
  it('parses ai placeholders', () => {
    expect(aiPlaceholders('{{ai: "say hi"}} and {{ai:thanks}}').map((p) => p.instruction)).toEqual(['say hi', 'thanks']);
  });

  it('render endpoint fills variables from the message and identity', async () => {
    const id = await mk({ bodyHtml: '<p>Hi {{recipient.first_name}}, {{business.name}} {{business.phone}} {{identity.name}} re {{original.subject}} {{nope}}</p>' });
    const r = (await api('POST', `/api/templates/${id}/render`, { emailId, identityId })).json();
    expect(r.subject).toBe('Re: Quote please');
    expect(r.html).toContain('Hi Jane, OCR Pty 0400 111 Alice Smith re Quote please');
    expect(r.html).toContain('<mark data-unknown-var>{{nope}}</mark>');
    expect(r.canSendDirect).toBe(false);
  });
});

describe('F-31 AI fill', () => {
  it('calls the provider once per placeholder and wraps the result in <mark data-ai-fill>', async () => {
    await enableAi(); stubAi((p) => (p.endsWith('Instruction: first') ? 'Alpha <b>' : 'Beta'));
    const id = await mk({ bodyHtml: '<p>{{ai: "first"}}</p><p>{{ai: "second"}}</p>' });
    const r = (await api('POST', `/api/templates/${id}/render`, { emailId, identityId })).json();
    expect(aiCalls).toHaveLength(2);
    expect(aiCalls[0]).toContain('Can you quote the office clean?');
    expect(r.html).toBe('<p><mark data-ai-fill>Alpha &lt;b&gt;</mark></p><p><mark data-ai-fill>Beta</mark></p>');
    expect(r.aiFilled).toBe(true);
    expect(r.canSendDirect).toBe(false);
  });
  it('without a provider the placeholder is left for the user, with a note', async () => {
    const id = await mk({ bodyHtml: '<p>{{ai: "first"}}</p>' });
    const r = (await api('POST', `/api/templates/${id}/render`, { emailId, identityId })).json();
    expect(r.aiPending).toBe(1); expect(r.note).toMatch(/AI provider/); expect(r.html).toContain('data-ai-pending');
  });
  it('a failing provider leaves the placeholder', async () => {
    await enableAi();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const id = await mk({ bodyHtml: '<p>{{ai: "x"}}</p>' });
    const r = (await api('POST', `/api/templates/${id}/render`, { emailId })).json();
    expect(r.aiPending).toBe(1);
  });
});

describe('F-31 send direct', () => {
  it('is forced off for templates with ai placeholders, and send refuses them', async () => {
    const id = await mk({ bodyHtml: '<p>{{ai: "x"}}</p>', sendDirect: true });
    const list = (await api('GET', '/api/templates')).json();
    expect(list.find((t: any) => t.id === id)).toMatchObject({ sendDirect: false, hasAi: true });
    // even if the flag is forced in the DB, the send path refuses
    await run('UPDATE templates SET send_direct = true WHERE id = ?', [id]);
    const r = await api('POST', '/api/send', { accountId: acct, fromEmail: 'alice@demo.test', to: [{ name: '', email: 'jane@client.test' }], cc: [], bcc: [], subject: 's', html: '<p>ok</p>', attachmentIds: [], track: false, quickReplyId: id });
    expect(r.statusCode).toBe(400); expect(r.json().error).toMatch(/AI/);
  });
  it('plain send_direct templates render as direct-safe; unflagged ones are refused', async () => {
    const ok = await mk({ subject: 'Re: {{original.subject}}', bodyHtml: '<p>Thanks {{recipient.first_name}}</p>', sendDirect: true });
    const no = await mk({ bodyHtml: '<p>x</p>' });
    expect((await api('POST', `/api/templates/${ok}/render`, { emailId, identityId })).json().canSendDirect).toBe(true);
    expect((await api('POST', `/api/templates/${no}/render`, { emailId, identityId })).json().canSendDirect).toBe(false);
    const payload = (quickReplyId: number, html = '<p>ok</p>') => ({ accountId: acct, fromEmail: 'alice@demo.test', to: [{ name: '', email: 'jane@client.test' }], cc: [], bcc: [], subject: 's', html, attachmentIds: [], track: false, quickReplyId });
    expect((await api('POST', '/api/send', payload(no))).statusCode).toBe(400);
    expect((await api('POST', '/api/send', payload(ok, '<p>{{x}}</p>'))).statusCode).toBe(400);
  });
  it('use updates use_count and last_used_at', async () => {
    const id = await mk();
    await api('POST', `/api/templates/${id}/render`, { emailId, identityId });
    const t = (await api('GET', '/api/templates')).json().find((x: any) => x.id === id);
    expect(t.useCount).toBe(1); expect(t.lastUsedAt).toBeGreaterThan(0);
  });
});

describe('F-31 marketing, pins, business, isolation', () => {
  it('marketing templates get an unsubscribe mailto to the identity', async () => {
    const id = await mk({ kind: 'marketing', bodyHtml: '<p>Deal</p><p>{{unsubscribe}}</p>' });
    const r = (await api('POST', `/api/templates/${id}/render`, { emailId, identityId })).json();
    expect(r.html).toContain('mailto:alice@demo.test?subject=unsubscribe');
    const id2 = await mk({ kind: 'marketing', bodyHtml: '<p>Deal</p>' });
    expect((await api('POST', `/api/templates/${id2}/render`, { emailId, identityId })).json().html).toContain('subject=unsubscribe');
  });
  it('stores pin, order, business; rejects another user\'s business', async () => {
    const id = await mk({ businessId: bizId, pinned: true, pinOrder: 2, sendDirect: true });
    expect((await api('GET', '/api/templates')).json().find((t: any) => t.id === id)).toMatchObject({ businessId: bizId, pinned: true, pinOrder: 2, sendDirect: true, kind: 'reply' });
    const bId = await makeUser('b@local'); const bCookie = await login(app, 'b@local');
    const bBiz = (await api('POST', '/api/businesses', { name: 'B Co' }, bCookie)).json().id;
    expect((await api('POST', '/api/templates', { name: 'x', bodyHtml: '', businessId: bBiz })).statusCode).toBe(400);
    expect(bId).toBeGreaterThan(0);
  });
  it('user B cannot render or send with user A\'s template or message', async () => {
    const id = await mk({ sendDirect: true });
    await makeUser('b@local'); const bCookie = await login(app, 'b@local');
    expect((await api('POST', `/api/templates/${id}/render`, { emailId }, bCookie)).statusCode).toBe(404);
    const bt = (await api('POST', '/api/templates', { name: 'b', bodyHtml: 'x' }, bCookie)).json().id;
    expect((await api('POST', `/api/templates/${bt}/render`, { emailId }, bCookie)).statusCode).toBe(404);
    expect((await api('POST', '/api/send', { accountId: acct, fromEmail: 'x', to: [], cc: [], bcc: [], subject: '', html: '', attachmentIds: [], track: false, quickReplyId: id }, bCookie)).statusCode).toBe(400);
  });
});
