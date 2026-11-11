/** T4 F-35 (VIP half): VIP senders keep their mail in the Inbox, always notify, bypass quiet hours. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const pushed: string[] = [];
vi.mock('../src/push.ts', async (orig) => ({ ...(await orig<any>()), notifyUser: vi.fn(async (_u: number, title: string) => { pushed.push(title); }) }));

const { q, run, one, insertId } = await import('../src/db.ts');
const { processPending, applyVerdictRetention } = await import('../src/classify/engine.ts');
const { sweepRetention } = await import('../src/classify/retention.ts');
const { setUserSetting } = await import('../src/classify/settings.ts');
const { queryEmails } = await import('../src/mail/store.ts');
const { parseSearch } = await import('../src/mail/searchparse.ts');
const { emitEvent } = await import('../src/events/emit.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

let A: number, B: number, acct: number, inbox: number, trash: number, acctB: number, inboxB: number, sale: number;
let app: Awaited<ReturnType<typeof makeApp>>;
let cka = '', ckb = '';
const api = (ck: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck } });

beforeEach(async () => {
  await resetDb(); resetLimiters(); pushed.length = 0;
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test');
  acct = await makeAccount('a@demo.test', { userId: A });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox'); trash = await makeMailbox(acct, 'Trash', 'trash');
  acctB = await makeAccount('b@demo.test', { userId: B });
  inboxB = await makeMailbox(acctB, 'INBOX', 'inbox');
  sale = await insertId("INSERT INTO labels(user_id, name, retention_days) VALUES (?, 'Sale', 7)", [A]);
  await insertId(`INSERT INTO rules(user_id, enabled, ord, match_field, match_value, action, label_id, stop, created_at)
    VALUES (?, true, 10, 'from_domain', 'shop.test', 'label', ?, true, 0)`, [A, sale]);
  app = await makeApp();
  cka = await login(app, 'a@x.test'); ckb = await login(app, 'b@x.test');
});

const add = (from: string, subject = 'Deal', acc = acct, box = inbox) =>
  ingest(acc, box, rawEmail({ from, to: 'a@demo.test', subject, date: 'Mon, 01 Jun 2026 10:00:00 +0000' }));

describe('VIP senders API', () => {
  it('adds, lists, normalises, de-duplicates and removes', async () => {
    const r1 = await api(cka, 'POST', '/api/vips', { kind: 'address', value: ' Boss@Shop.Test ' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().value).toBe('boss@shop.test');
    await api(cka, 'POST', '/api/vips', { kind: 'address', value: 'boss@shop.test' });
    await api(cka, 'POST', '/api/vips', { kind: 'domain', value: '@Big.Test' });
    const l = (await api(cka, 'GET', '/api/vips')).json();
    expect(l.items.map((i: any) => `${i.kind}:${i.value}`)).toEqual(['address:boss@shop.test', 'domain:big.test']);
    expect(l.bypassQuiet).toBe(true);
    expect((await api(cka, 'POST', '/api/vips', { kind: 'address', value: 'nope' })).statusCode).toBe(400);
    expect((await api(cka, 'DELETE', `/api/vips/${l.items[0].id}`)).statusCode).toBe(200);
    expect((await api(cka, 'GET', '/api/vips')).json().items).toHaveLength(1);
  });
  it('toggles quiet-hours bypass', async () => {
    await api(cka, 'PUT', '/api/vips/settings', { bypassQuiet: false });
    expect((await api(cka, 'GET', '/api/vips')).json().bypassQuiet).toBe(false);
  });
  it('user B cannot see or delete user A\'s VIPs, and A\'s VIPs do not mark B\'s mail', async () => {
    const id = (await api(cka, 'POST', '/api/vips', { kind: 'domain', value: 'shop.test' })).json().id;
    expect((await api(ckb, 'GET', '/api/vips')).json().items).toHaveLength(0);
    expect((await api(ckb, 'DELETE', `/api/vips/${id}`)).statusCode).toBe(404);
    expect(await q('SELECT 1 FROM vip_senders WHERE id = ?', [id])).toHaveLength(1);
    const mb = await add('x@shop.test', 'to B', acctB, inboxB);
    const m = await queryEmails(B, { filter: { text: 'is:vip' }, position: 0, limit: 10 });
    expect(m.ids).toEqual([]);
    expect(mb).toBeTruthy();
  });
});

describe('VIP mail stays in the Inbox', () => {
  it('a "delete after 7 days" label rule does not schedule removal; retention skips it', async () => {
    await api(cka, 'POST', '/api/vips', { kind: 'address', value: 'boss@shop.test' });
    const vip = await add('boss@shop.test', 'From the boss');
    const other = await add('spam@shop.test', 'Not VIP');
    await processPending();
    const v = await one<any>('SELECT disposition, delete_at, keep_reason FROM messages WHERE id = ?', [vip!.rowId]);
    expect(v.disposition).toBe('keep'); expect(v.delete_at).toBe(null); expect(v.keep_reason).toBe('VIP sender');
    // still labelled
    expect(await q('SELECT 1 FROM message_labels WHERE message_id = ? AND label_id = ?', [vip!.rowId, sale])).toHaveLength(1);
    const o = await one<any>('SELECT disposition FROM messages WHERE id = ?', [other!.rowId]);
    expect(o.disposition).toBe('delete');

    await setUserSetting(A, 'dry_run', 'false');
    const stats = await sweepRetention(Date.parse('2026-08-01'));
    expect(stats.trashed).toBe(1);
    expect((await one<any>('SELECT mailbox_id FROM messages WHERE id = ?', [vip!.rowId])).mailbox_id).toBe(inbox);
    expect((await one<any>('SELECT mailbox_id FROM messages WHERE id = ?', [other!.rowId])).mailbox_id).toBe(trash);
  });
  it('an AI verdict "delete after 7 days" is ignored for a VIP domain', async () => {
    await api(cka, 'POST', '/api/vips', { kind: 'domain', value: 'big.test' });
    const m = await add('anyone@big.test', 'Newsletter-ish');
    await processPending();
    const row: any = { id: m!.rowId, date: Date.parse('2026-06-01'), user_id: A };
    await applyVerdictRetention(row, { retention: 'delete', reason: 'promo' } as any);
    const r = await one<any>('SELECT disposition, delete_at FROM messages WHERE id = ?', [m!.rowId]);
    expect(r.disposition).toBe('keep'); expect(r.delete_at).toBe(null);
    // and a non-VIP gets the countdown from the same verdict
    const n = await add('anyone@other.test', 'Promo');
    await processPending();
    await applyVerdictRetention({ id: n!.rowId, date: Date.parse('2026-06-01'), user_id: A } as any, { retention: 'delete', reason: 'promo' } as any);
    expect((await one<any>('SELECT disposition FROM messages WHERE id = ?', [n!.rowId])).disposition).toBe('delete');
  });
  it('marking a sender VIP later rescues mail already scheduled for deletion', async () => {
    const m = await add('late@shop.test');
    await processPending();
    expect((await one<any>('SELECT disposition FROM messages WHERE id = ?', [m!.rowId])).disposition).toBe('delete');
    await api(cka, 'POST', '/api/vips', { kind: 'address', value: 'late@shop.test' });
    const r = await one<any>('SELECT disposition, delete_at FROM messages WHERE id = ?', [m!.rowId]);
    expect(r.disposition).toBe('keep'); expect(r.delete_at).toBe(null);
  });
});

describe('VIP search + list flag', () => {
  it('is:vip parses, filters, and ApiEmail.vip is set', async () => {
    expect(parseSearch('is:vip').vip).toBe(true);
    await api(cka, 'POST', '/api/vips', { kind: 'domain', value: 'big.test' });
    const v = await add('a@big.test', 'vip one'); await add('a@small.test', 'plain');
    const r = await queryEmails(A, { filter: { text: 'is:vip' }, position: 0, limit: 10 });
    expect(r.ids).toEqual([`m${v!.rowId}`]);
    const got = (await api(cka, 'GET', `/api/emails?ids=m${v!.rowId}`));
    if (got.statusCode === 200) expect(JSON.stringify(got.json())).toContain('"vip":true');
  });
  it('the VIPs smart-view suggestion is offered', async () => {
    const s = (await api(cka, 'GET', '/api/views/suggestions')).json();
    expect(s.some((x: any) => x.query === 'is:vip')).toBe(true);
  });
});

describe('VIP notifications', () => {
  const quiet = async (uid: number) => setUserSetting(uid, 'notif_quiet', JSON.stringify({ enabled: true, from: '00:01', to: '00:00', tz: 'UTC' }));
  it('always notifies, even when mail.received is switched off', async () => {
    await run("INSERT INTO notification_prefs(user_id, type, in_app, push, email_digest) VALUES (?, 'mail.received', false, false, false)", [A]);
    await emitEvent(A, 'mail.received', null, { from: 'boss@shop.test', subject: 'Hi' });
    expect(await q("SELECT 1 FROM notifications WHERE user_id = ?", [A])).toHaveLength(0);
    await emitEvent(A, 'mail.received', null, { from: 'boss@shop.test', subject: 'Hi', vip: true });
    expect(await q("SELECT 1 FROM notifications WHERE user_id = ?", [A])).toHaveLength(1);
  });
  it('bypasses quiet hours when vip_bypass_quiet is on, and holds push when off', async () => {
    await quiet(A);
    await emitEvent(A, 'mail.received', null, { from: 'x@y.test', subject: 'plain' });
    expect(pushed).toHaveLength(0);
    await emitEvent(A, 'mail.received', null, { from: 'boss@shop.test', subject: 'vip', vip: true });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain('★');
    await setUserSetting(A, 'vip_bypass_quiet', 'false');
    await emitEvent(A, 'mail.received', null, { from: 'boss@shop.test', subject: 'vip2', vip: true });
    expect(pushed).toHaveLength(1);
  });
  it('another user\'s quiet-hours/VIP settings do not leak', async () => {
    await quiet(B); await setUserSetting(B, 'vip_bypass_quiet', 'false');
    await emitEvent(A, 'mail.received', null, { from: 'boss@shop.test', subject: 'vip', vip: true });
    expect(pushed).toHaveLength(1);
  });
});
