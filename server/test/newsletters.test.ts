/** T6.3 F-40: newsletter detection, per-sender choice, Read later, one-click unsubscribe (no digest). */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';
import { q, one, run } from '../src/db.ts';
import { queryEmails, listMailboxes } from '../src/mail/store.ts';
import { sweepRetention } from '../src/classify/retention.ts';
import { setUserSetting } from '../src/classify/settings.ts';
import { detectNewsletter, rawHeaders, readMinutes, unsubMethod, unsubscribe, setSenderChoice } from '../src/mail/newsletters.ts';
import { makeApp, login, resetLimiters } from './app.ts';

let A: number, B: number, acct: number, inbox: number, trash: number, archive: number, acctB: number, inboxB: number;
let app: Awaited<ReturnType<typeof makeApp>>;
let cka = '', ckb = '';
const api = (ck: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck } });

const NEWS = { 'List-Id': 'Weekly <weekly.news.test>', 'List-Unsubscribe': '<https://news.test/u/abc>, <mailto:unsub@news.test?subject=remove%20me>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };

/** rawEmail + extra headers */
function mailWith(headers: Record<string, string>, o: { from?: string; subject?: string; body?: string; deliveredTo?: string } = {}): Buffer {
  const base = rawEmail({ from: o.from ?? 'Weekly <hello@news.test>', to: 'a@demo.test', subject: o.subject ?? 'Issue 1', body: o.body, deliveredTo: o.deliveredTo }).toString();
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return Buffer.from(base.replace('\r\nSubject:', `\r\n${extra}\r\nSubject:`));
}
const rowOf = (subject: string) => one<any>('SELECT * FROM messages WHERE subject = ? AND user_id = ?', [subject, A]);
const inboxIds = async (u = A) => (await queryEmails(u, { filter: { inMailbox: 'u:inbox' }, position: 0, limit: 50 })).ids;
const laterIds = async (u = A) => (await queryEmails(u, { filter: { readLater: true }, position: 0, limit: 50 })).ids;

beforeEach(async () => {
  await resetDb(); resetLimiters();
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test');
  acct = await makeAccount('a@demo.test', { userId: A });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox'); trash = await makeMailbox(acct, 'Trash', 'trash'); archive = await makeMailbox(acct, 'Archive', 'archive');
  acctB = await makeAccount('b@demo.test', { userId: B });
  inboxB = await makeMailbox(acctB, 'INBOX', 'inbox');
  app = await makeApp();
  cka = await login(app, 'a@x.test'); ckb = await login(app, 'b@x.test');
});

describe('detection', () => {
  const d = (h: Record<string, string>, from = 'a@b.test') => detectNewsletter(new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v])), from);
  it('fires on list / bulk / ESP headers and not on plain mail', () => {
    expect(d({ 'List-Unsubscribe': '<mailto:x@y.test>' }).isNewsletter).toBe(true);
    expect(d({ 'List-Id': 'Foo <foo.list.test>' })).toMatchObject({ isNewsletter: true, sender: 'foo.list.test', listId: 'foo.list.test' });
    expect(d({ Precedence: 'bulk' }).isNewsletter).toBe(true);
    expect(d({ Precedence: 'list' }).isNewsletter).toBe(true);
    for (const h of ['X-Mailchimp-ID', 'X-SG-EID', 'X-Mailgun-Sid', 'Feedback-ID']) expect(d({ [h]: '1' }).isNewsletter).toBe(true);
    expect(d({ Precedence: 'normal' }).isNewsletter).toBe(false);
    expect(d({}, 'Bob@X.test')).toMatchObject({ isNewsletter: false, sender: 'bob@x.test' });
    expect(detectNewsletter(new Map(), 'a@b.test', 'newsletter').isNewsletter).toBe(true);   // existing AI verdict
  });
  it('reads unfolded raw headers and stores them at ingest, with reading time', async () => {
    const h = rawHeaders(mailWith({ 'List-Unsubscribe': '<https://n.test/u>,\r\n <mailto:u@n.test>' }));
    expect(h.get('list-unsubscribe')).toBe('<https://n.test/u>, <mailto:u@n.test>');
    await ingest(acct, inbox, mailWith(NEWS, { body: Array(460).fill('word').join(' ') }), {});
    const r = await rowOf('Issue 1');
    expect(r).toMatchObject({ is_newsletter: true, newsletter_sender: 'weekly.news.test', read_minutes: 2, list_unsubscribe_post: 'List-Unsubscribe=One-Click' });
    expect(r.list_unsubscribe).toContain('https://news.test/u/abc');
    await ingest(acct, inbox, rawEmail({ from: 'bob@x.test', to: 'a@demo.test', subject: 'Plain' }), {});
    expect((await rowOf('Plain')).is_newsletter).toBe(false);
    expect(readMinutes('one two')).toBe(1);
    expect(unsubMethod(r.list_unsubscribe, r.list_unsubscribe_post)).toBe('one-click');
    expect(unsubMethod('<https://x.test/u>', null)).toBe('link');
    expect(unsubMethod('<mailto:u@x.test>', null)).toBe('mailto');
    expect(unsubMethod(null, null)).toBeNull();
  });
  it('exposes the prompt data on the API email', async () => {
    await ingest(acct, inbox, mailWith(NEWS), {});
    const id = (await inboxIds())[0];
    const { getEmails } = await import('../src/mail/store.ts');
    const [e] = await getEmails(A, [id]);
    expect(e.newsletter).toEqual({ sender: 'weekly.news.test', choice: null, unsubscribe: 'one-click' });
    expect(e.readLater).toBe(false);
    expect(e.readMinutes).toBe(1);
  });
});

describe('read later routing', () => {
  it('first newsletter stays in the Inbox; after "Read later" new mail from that sender skips it', async () => {
    await ingest(acct, inbox, mailWith(NEWS, { subject: 'Issue 1' }), { isLive: true });
    expect(await inboxIds()).toHaveLength(1);
    const first = `m${(await rowOf('Issue 1')).id}`;
    const res = await api(cka, 'PUT', '/api/newsletters/senders', { sender: 'weekly.news.test', choice: 'read_later', emailId: first });
    expect(res.statusCode).toBe(200);
    expect(await inboxIds()).toEqual([]);
    expect(await laterIds()).toEqual([first]);
    await ingest(acct, inbox, mailWith(NEWS, { subject: 'Issue 2' }), { isLive: true });
    expect(await inboxIds()).toEqual([]);
    expect(await laterIds()).toHaveLength(2);
    // unread count of the Inbox ignores Read later mail
    expect((await listMailboxes(A)).find((m) => m.id === 'u:inbox')!.unreadEmails).toBe(0);
    // a different sender is untouched
    await ingest(acct, inbox, mailWith({ 'List-Id': 'Other <other.test>' }, { subject: 'Other', from: 'o@other.test' }), { isLive: true });
    expect(await inboxIds()).toHaveLength(1);
    // switching back to Inbox: new mail stays, the prompted one returns
    await api(cka, 'PUT', '/api/newsletters/senders', { sender: 'weekly.news.test', choice: 'inbox', emailId: first });
    await ingest(acct, inbox, mailWith(NEWS, { subject: 'Issue 3' }), { isLive: true });
    expect((await inboxIds()).length).toBe(3);
  });
  it('never moves VIP or snoozed mail', async () => {
    await run("INSERT INTO vip_senders(user_id, kind, value, created_at) VALUES (?, 'address', 'hello@news.test', 0)", [A]);
    await setSenderChoice(A, 'weekly.news.test', 'read_later');
    await ingest(acct, inbox, mailWith(NEWS, { subject: 'VIP issue' }), { isLive: true });
    expect(await laterIds()).toEqual([]);
    expect(await inboxIds()).toHaveLength(1);
    await run('DELETE FROM vip_senders');
    await ingest(acct, inbox, mailWith(NEWS, { subject: 'Snoozed issue' }), { isLive: true });
    const r = await rowOf('Snoozed issue');
    expect(r.read_later).toBe(true);
    await run('UPDATE messages SET read_later = false, snoozed_until = ? WHERE id = ?', [Date.now() + 3_600_000, r.id]);
    await setSenderChoice(A, 'weekly.news.test', 'read_later', `m${r.id}`);   // the explicit choice must not flag snoozed mail
    expect((await rowOf('Snoozed issue')).read_later).toBe(false);
  });
  it('archives after read when the setting is on', async () => {
    await ingest(acct, inbox, mailWith(NEWS), { isLive: true });
    const id = `m${(await rowOf('Issue 1')).id}`;
    await setSenderChoice(A, 'weekly.news.test', 'read_later', id);
    await api(cka, 'PUT', '/api/newsletters/settings', { archiveAfterRead: true });
    const { setKeywords } = await import('../src/mail/store.ts');
    await setKeywords(A, id, { $seen: true });
    expect(await laterIds()).toEqual([]);
    expect((await rowOf('Issue 1')).mailbox_id).toBe(archive);
  });
});

describe('unsubscribe', () => {
  it('one-click: POSTs List-Unsubscribe=One-Click to the https URL, then adds a Trash filter + marks the sender', async () => {
    await ingest(acct, inbox, mailWith(NEWS), {});
    const calls: any[] = [];
    const r = await unsubscribe(A, `m${(await rowOf('Issue 1')).id}`, { request: async (url, o) => { calls.push({ url, ...o }); return { status: 200, text: '' }; } });
    expect(r.method).toBe('one-click');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://news.test/u/abc', method: 'POST', body: 'List-Unsubscribe=One-Click' });
    expect(calls[0].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const f = (await q<any>('SELECT * FROM filters WHERE user_id = ?', [A]))[0];
    expect(JSON.parse(f.actions)).toEqual([{ type: 'delete' }]);
    expect(JSON.parse(f.conditions)[0]).toMatchObject({ field: 'from', value: 'hello@news.test' });
    expect((await q<any>('SELECT choice FROM newsletter_senders WHERE user_id = ?', [A]))[0].choice).toBe('unsubscribed');
  });
  it('one-click goes through the SSRF guard (private address refused unless allow-listed)', async () => {
    await ingest(acct, inbox, mailWith({ ...NEWS, 'List-Unsubscribe': '<https://127.0.0.1:1/u>' }), {});
    await expect(unsubscribe(A, `m${(await rowOf('Issue 1')).id}`)).rejects.toThrow(/private or local/);
    expect(await q('SELECT 1 FROM filters WHERE user_id = ?', [A])).toHaveLength(0);   // failed → nothing changed
  });
  it('a failing sender response is reported and changes nothing', async () => {
    await ingest(acct, inbox, mailWith(NEWS), {});
    await expect(unsubscribe(A, `m${(await rowOf('Issue 1')).id}`, { request: async () => ({ status: 500, text: '' }) })).rejects.toThrow(/HTTP 500/);
    expect(await q('SELECT 1 FROM newsletter_senders')).toHaveLength(0);
  });
  it('mailto: sends an empty mail from the identity it was delivered to (when no one-click)', async () => {
    await run("INSERT INTO identities(user_id, account_id, email, display_name) VALUES (?,?,?,?)", [A, acct, 'shop@demo.test', 'Shop']);
    const ident = (await one<any>("SELECT id FROM identities WHERE email = 'shop@demo.test'")).id;
    await ingest(acct, inbox, mailWith({ 'List-Id': '<l.news.test>', 'List-Unsubscribe': '<mailto:unsub@news.test?subject=remove%20me>' }, { deliveredTo: 'shop@demo.test' }), {});
    const sent: any[] = [];
    const r = await unsubscribe(A, `m${(await rowOf('Issue 1')).id}`, { send: async (_u, p) => { sent.push(p); } });
    expect(r.method).toBe('mailto');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ accountId: acct, fromEmail: 'shop@demo.test', identityId: ident, subject: 'remove me', html: '', to: [{ email: 'unsub@news.test' }] });
  });
  it('link only: hands the URL back to the browser; archive setting makes an archive filter', async () => {
    await setUserSetting(A, 'unsub_action', 'archive');
    await ingest(acct, inbox, mailWith({ 'List-Unsubscribe': '<https://news.test/manage?id=1>' }), {});
    const r = await unsubscribe(A, `m${(await rowOf('Issue 1')).id}`);
    expect(r).toMatchObject({ method: 'link', url: 'https://news.test/manage?id=1' });
    expect(JSON.parse((await q<any>('SELECT actions FROM filters'))[0].actions)).toEqual([{ type: 'move', value: 'archive' }]);
  });
  it('the filter really diverts the sender\'s next mail', async () => {
    await ingest(acct, inbox, mailWith(NEWS), {});
    await unsubscribe(A, `m${(await rowOf('Issue 1')).id}`, { request: async () => ({ status: 200, text: '' }) });
    const { loadFilters, evaluateFilters } = await import('../src/mail/filters.ts');
    const acts = evaluateFilters({ from: 'Weekly <hello@news.test>', to: '', cc: '', subject: 'x', body: '', hasAttachment: false, accountEmail: 'a@demo.test' }, await loadFilters(A));
    expect(acts).toEqual([{ type: 'delete' }]);
  });
});

describe('retention of Read later items', () => {
  it('trashes old unstarred items; keeps starred, VIP, snoozed and young ones', async () => {
    await setUserSetting(A, 'dry_run', 'false');
    await setSenderChoice(A, 'weekly.news.test', 'read_later');
    for (const s of ['old', 'starred', 'young', 'snoozed']) await ingest(acct, inbox, mailWith(NEWS, { subject: s }), { isLive: true });
    const old = Date.now() - 40 * 86_400_000;
    await run("UPDATE messages SET read_later_at = ? WHERE subject IN ('old','starred','snoozed')", [old]);
    await run("UPDATE messages SET flagged = true WHERE subject = 'starred'");
    await run("UPDATE messages SET snoozed_until = ? WHERE subject = 'snoozed'", [Date.now() + 3_600_000]);
    await sweepRetention();
    const role = async (s: string) => (await one<any>('SELECT mb.role FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.subject = ?', [s])).role;
    expect(await role('old')).toBe('trash');
    expect(await role('starred')).toBe('inbox');
    expect(await role('young')).toBe('inbox');
    expect(await role('snoozed')).toBe('inbox');
    // the rule is changeable: switch it off → nothing more moves
    await api(cka, 'PUT', '/api/newsletters/settings', { retentionOn: false });
    await run("UPDATE messages SET read_later_at = ? WHERE subject = 'young'", [old]);
    await sweepRetention();
    expect(await role('young')).toBe('inbox');
  });
  it('a VIP sender is never trashed by it', async () => {
    await setUserSetting(A, 'dry_run', 'false');
    await setSenderChoice(A, 'weekly.news.test', 'read_later');
    await ingest(acct, inbox, mailWith(NEWS, { subject: 'v' }), { isLive: true });
    await run("UPDATE messages SET read_later_at = ?", [Date.now() - 40 * 86_400_000]);
    await run("INSERT INTO vip_senders(user_id, kind, value, created_at) VALUES (?, 'domain', 'news.test', 0)", [A]);
    await sweepRetention();
    expect((await rowOf('v')).mailbox_id).toBe(inbox);
  });
});

describe('isolation', () => {
  it('user B cannot see, change or unsubscribe through user A\'s data', async () => {
    await ingest(acct, inbox, mailWith(NEWS), {});
    const id = `m${(await rowOf('Issue 1')).id}`;
    await api(cka, 'PUT', '/api/newsletters/senders', { sender: 'weekly.news.test', choice: 'read_later', emailId: id });
    expect((await api(ckb, 'GET', '/api/newsletters/senders')).json().items).toEqual([]);
    expect((await api(ckb, 'POST', '/api/newsletters/unsubscribe', { emailId: id })).statusCode).toBe(404);
    expect((await api(ckb, 'PUT', '/api/newsletters/senders', { sender: 'x', choice: 'read_later', emailId: id })).statusCode).toBe(404);
    const sid = (await api(cka, 'GET', '/api/newsletters/senders')).json().items[0].id;
    expect((await api(ckb, 'DELETE', `/api/newsletters/senders/${sid}`)).statusCode).toBe(404);
    expect(await laterIds(B)).toEqual([]);
    // B's own choice for the same sender key does not affect A, and B's mail is routed by B's choices only
    await api(ckb, 'PUT', '/api/newsletters/senders', { sender: 'weekly.news.test', choice: 'inbox' });
    await ingest(acctB, inboxB, mailWith(NEWS, { subject: 'For B' }), { isLive: true });
    expect(await inboxIds(B)).toHaveLength(1);
    expect((await api(cka, 'GET', '/api/newsletters/senders')).json().items[0].choice).toBe('read_later');
    expect((await api(cka, 'GET', '/api/newsletters/settings')).json().retentionDays).toBe(30);
  });
  it('validates input', async () => {
    expect((await api(cka, 'PUT', '/api/newsletters/senders', { sender: 'x', choice: 'bogus' })).statusCode).toBe(400);
    expect((await api(cka, 'PUT', '/api/newsletters/settings', { retentionDays: 0 })).statusCode).toBe(400);
    expect((await api(cka, 'POST', '/api/newsletters/unsubscribe', { emailId: 'm999999' })).statusCode).toBe(404);
  });
});
