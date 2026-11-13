import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, makeUser, TEST_USER, rawEmail } from './helpers.ts';

const { q, one, run } = await import('../src/db.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');
const { sign } = await import('../src/transport/inbound/push.ts');
const { syncManager } = await import('../src/imap/sync.ts');
const { sweepRetention } = await import('../src/classify/retention.ts');
const { setUserSetting } = await import('../src/classify/settings.ts');
const { cleanupStopped } = await import('../src/mail/disposable.ts');

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let inbox: { token: string; secret: string; accountId: number };
const DAY = 86_400_000;

const post = (raw: Buffer, rcpt: string) => {
  const ts = String(Date.now());
  return app.inject({
    method: 'POST', url: `/api/ingest/${inbox.token}`, payload: raw,
    headers: { 'content-type': 'message/rfc822', 'x-seamless-timestamp': ts, 'x-seamless-rcpt': rcpt, 'x-seamless-signature': sign(inbox.secret, ts, raw) },
  });
};
let n = 0;
const mail = (to: string, subject = `Hello ${++n}`) => rawEmail({ from: 'News <news@shop.test>', to, subject });
const create = async (payload: any = {}, c = cookie) =>
  (await app.inject({ method: 'POST', url: '/api/disposable', headers: { cookie: c }, payload: { domain: 'push.test', ...payload } })).json();
const act = (id: number, action: string, c = cookie) => app.inject({ method: 'POST', url: `/api/disposable/${id}/${action}`, headers: { cookie: c } });
const stored = async (subject: string) => q<any>('SELECT id FROM messages WHERE subject = ?', [subject]);

beforeEach(async () => {
  await resetDb(); resetLimiters();
  app = await makeApp();
  cookie = await login(app);
  const res = await app.inject({ method: 'POST', url: '/api/push-inboxes', headers: { cookie }, payload: { name: 'Push', email: 'me@push.test', domains: ['push.test'] } });
  const j = res.json();
  inbox = { token: j.token, secret: j.secret, accountId: j.accountId };
});
afterEach(() => { syncManager.removeAllListeners('newMail'); });

describe('stopped mail: Bin, then retention purge', () => {
  it('stop → Bin → purged by the normal Trash retention', async () => {
    const d = await create();
    await act(d.id, 'stop');
    const r = await post(mail(d.address, 'binned'), d.address);
    expect(r.statusCode).toBe(202);
    await setUserSetting(TEST_USER, 'dry_run', 'false');
    await run('UPDATE messages SET trashed_at = ? WHERE id = ?', [Date.now() - 31 * DAY, r.json().id]);
    const s = await sweepRetention();
    expect(s.purged).toBe(1);
    expect(await stored('binned')).toHaveLength(0);
  });

  it('the cap: 100 stored, then deleted on arrival with no counter, no row and no event', async () => {
    const d = await create();
    await act(d.id, 'stop');
    await setUserSetting(TEST_USER, 'stop_cap', '3');
    for (let i = 0; i < 3; i++) expect((await post(mail(d.address, `in-${i}`), d.address)).statusCode).toBe(202);
    const eventsBefore = (await q('SELECT 1 FROM events')).length;
    const r = await post(mail(d.address, 'over-cap'), d.address);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ dropped: true, reason: 'disposed' });
    expect(await stored('over-cap')).toHaveLength(0);
    expect((await one<any>('SELECT stopped_stored, received_count FROM disposable_addresses WHERE id = ?', [d.id]))).toMatchObject({ stopped_stored: 3, received_count: 3 });
    expect((await q('SELECT 1 FROM events')).length).toBe(eventsBefore);
  });

  it('default cap is 100 and the window is 15 days', async () => {
    const d = await create();
    await act(d.id, 'stop');
    await run('UPDATE disposable_addresses SET stopped_stored = 99 WHERE id = ?', [d.id]);
    expect((await post(mail(d.address), d.address)).statusCode).toBe(202);
    expect((await post(mail(d.address, 'hundred-and-one'), d.address)).json()).toMatchObject({ dropped: true });
    expect(await stored('hundred-and-one')).toHaveLength(0);
  });

  it('15 days after Stop mail is deleted on arrival; Stop again opens a new window and cap', async () => {
    const d = await create();
    await act(d.id, 'stop');
    await run('UPDATE disposable_addresses SET stopped_at = ?, stopped_stored = 5 WHERE id = ?', [Date.now() - 16 * DAY, d.id]);
    const r = await post(mail(d.address, 'late'), d.address);
    expect(r.json()).toMatchObject({ dropped: true });
    expect(await stored('late')).toHaveLength(0);
    expect((await one<any>('SELECT stopped_stored FROM disposable_addresses WHERE id = ?', [d.id])).stopped_stored).toBe(5);   // nothing counted
    await act(d.id, 'start');
    await act(d.id, 'stop');
    expect((await one<any>('SELECT stopped_stored FROM disposable_addresses WHERE id = ?', [d.id])).stopped_stored).toBe(0);
    expect((await post(mail(d.address, 'fresh'), d.address)).statusCode).toBe(202);
  });

  it('stop_bin_days is a setting', async () => {
    const d = await create();
    await act(d.id, 'stop');
    await setUserSetting(TEST_USER, 'stop_bin_days', '2');
    await run('UPDATE disposable_addresses SET stopped_at = ? WHERE id = ?', [Date.now() - 3 * DAY, d.id]);
    expect((await post(mail(d.address, 'too-late'), d.address)).json()).toMatchObject({ dropped: true });
  });
});

describe('one-week expiry and Keep', () => {
  it('mail on an active disposable address gets delete_at = received + 7 days; the sweep moves it to the Bin; other mail is untouched', async () => {
    const d = await create();
    const r = await post(mail(d.address, 'week'), d.address);
    const plain = await post(mail('me@push.test', 'plain'), 'me@push.test');
    const row = await one<any>('SELECT delete_at FROM messages WHERE id = ?', [r.json().id]);
    expect(Number(row.delete_at)).toBeGreaterThan(Date.now() + 6.9 * DAY);
    expect(Number(row.delete_at)).toBeLessThan(Date.now() + 7.1 * DAY);
    expect((await one<any>('SELECT delete_at FROM messages WHERE id = ?', [plain.json().id])).delete_at).toBeNull();
    // the API shows the countdown
    const { getEmails } = await import('../src/mail/store.ts');
    expect((await getEmails(TEST_USER, [`m${r.json().id}`]))[0].disposable).toMatchObject({ kept: false, deleteAt: Number(row.delete_at) });
    await run('UPDATE messages SET delete_at = ? WHERE id = ?', [Date.now() - 1000, r.json().id]);   // dry_run stays at its default: the rule is not gated
    expect((await sweepRetention()).trashed).toBe(1);
    const moved = await one<any>('SELECT mb.role, m.trashed_at FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?', [r.json().id]);
    expect(moved.role).toBe('trash');
    expect(Number(moved.trashed_at)).toBeGreaterThan(0);
    expect((await one<any>('SELECT mb.role FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?', [plain.json().id])).role).toBe('inbox');
  });

  it('disposable_expire_days is a setting (1–90)', async () => {
    const put = (v: any) => app.inject({ method: 'PUT', url: '/api/disposable/settings', headers: { cookie }, payload: v });
    expect((await put({ expireDays: 0 })).statusCode).toBe(400);
    expect((await put({ expireDays: 91 })).statusCode).toBe(400);
    expect((await put({ expireDays: 3 })).json()).toMatchObject({ expireDays: 3, stopBinDays: 15, stopCap: 100, stoppedDeleteDays: 183 });
    const d = await create();
    const r = await post(mail(d.address), d.address);
    expect(Number((await one<any>('SELECT delete_at FROM messages WHERE id = ?', [r.json().id])).delete_at)).toBeLessThan(Date.now() + 3.1 * DAY);
  });

  it('Keep removes the countdown and protects the message from the sweep', async () => {
    const d = await create();
    const r = await post(mail(d.address, 'keep-me'), d.address);
    const k = await app.inject({ method: 'POST', url: `/api/messages/${r.json().id}/keep`, headers: { cookie } });
    expect(k.json()).toEqual({ kept: 1 });
    expect(await one<any>('SELECT delete_at, keep_reason FROM messages WHERE id = ?', [r.json().id])).toMatchObject({ delete_at: null, keep_reason: 'kept by user' });
    expect((await sweepRetention()).trashed).toBe(0);
  });

  it('Keep all from this address keeps old and future mail; bulk Keep works', async () => {
    const d = await create();
    const a = await post(mail(d.address), d.address); const b = await post(mail(d.address), d.address);
    expect((await app.inject({ method: 'POST', url: `/api/disposable/${d.id}/keep-all`, headers: { cookie } })).json()).toEqual({ kept: 2 });
    const c = await post(mail(d.address), d.address);
    for (const id of [a, b, c].map((x) => x.json().id)) expect(await one<any>('SELECT delete_at, keep_reason FROM messages WHERE id = ?', [id])).toMatchObject({ delete_at: null, keep_reason: 'kept by user' });
    const d2 = await create();
    const e = await post(mail(d2.address), d2.address); const f = await post(mail(d2.address), d2.address);
    const bulk = await app.inject({ method: 'POST', url: '/api/messages/keep', headers: { cookie }, payload: { ids: [e.json().id, f.json().id] } });
    expect(bulk.json()).toEqual({ kept: 2 });
  });

  it('Keep is not available on other users’ mail', async () => {
    const d = await create();
    const r = await post(mail(d.address), d.address);
    await makeUser('b@local');
    const cb = await login(app, 'b@local');
    expect((await app.inject({ method: 'POST', url: `/api/messages/${r.json().id}/keep`, headers: { cookie: cb } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/messages/keep', headers: { cookie: cb }, payload: { ids: [r.json().id] } })).json()).toEqual({ kept: 0 });
    expect((await one<any>('SELECT delete_at FROM messages WHERE id = ?', [r.json().id])).delete_at).not.toBeNull();
  });
});

describe('automatic cleanup of long-stopped addresses', () => {
  it('removes only addresses stopped > 6 months, with their leftover Bin mail; the address then counts as unknown', async () => {
    const old = await create(); const recent = await create(); const active = await create();
    for (const d of [old, recent]) await act(d.id, 'stop');
    const bin = await post(mail(old.address, 'old-bin'), old.address);
    await run('UPDATE disposable_addresses SET stopped_at = ? WHERE id = ?', [Date.now() - 184 * DAY, old.id]);
    await run('UPDATE disposable_addresses SET stopped_at = ? WHERE id = ?', [Date.now() - 170 * DAY, recent.id]);
    expect(await cleanupStopped()).toBe(1);
    expect(await q('SELECT id FROM disposable_addresses ORDER BY id')).toEqual([{ id: recent.id }, { id: active.id }].sort((a, b) => a.id - b.id));
    expect(await stored('old-bin')).toHaveLength(0);
    expect(bin.statusCode).toBe(202);
    // mail to the deleted address follows the domain policy (default for the Cloudflare route: deliver)
    expect((await post(mail(old.address, 'back'), old.address)).statusCode).toBe(202);
    expect((await one<any>('SELECT disposable_id FROM messages WHERE subject = ?', ['back'])).disposable_id).toBeNull();
  });

  it('"Never" (0) keeps everything; the setting is per user', async () => {
    const d = await create();
    await act(d.id, 'stop');
    await run('UPDATE disposable_addresses SET stopped_at = ? WHERE id = ?', [Date.now() - 400 * DAY, d.id]);
    await setUserSetting(TEST_USER, 'stopped_delete_days', '0');
    expect(await cleanupStopped()).toBe(0);
    await setUserSetting(TEST_USER, 'stopped_delete_days', '183');
    expect(await cleanupStopped()).toBe(1);
  });
});

describe('migration of paused / disposed', () => {
  it('migration 52 turns both into stopped and keeps the counters', async () => {
    const d = await create(); const e = await create();
    await run("ALTER TABLE disposable_addresses DROP CONSTRAINT disposable_addresses_status_check");
    await run("UPDATE disposable_addresses SET status = 'paused', received_count = 4 WHERE id = ?", [d.id]);
    await run("UPDATE disposable_addresses SET status = 'disposed', disposed_at = ?, received_count = 7, dropped_count = 2, stopped_at = NULL WHERE id = ?", [Date.now() - 40 * DAY, e.id]);
    const { MIGRATIONS } = await import('../src/db.ts');
    const sql = MIGRATIONS.find((m: any) => m.id === 52)!.sql
      .replace(/ALTER TABLE disposable_addresses ADD COLUMN[^\n]*\n/g, '').replace(/ALTER TABLE push_inboxes ADD COLUMN[^\n]*\n/g, '');
    await run(sql);
    const rows = await q<any>('SELECT id, status, received_count, dropped_count, stopped_at FROM disposable_addresses ORDER BY id');
    expect(rows.map((r) => r.status)).toEqual(['stopped', 'stopped']);
    expect(rows.map((r) => r.received_count)).toEqual([4, 7]);
    expect(rows[1].dropped_count).toBe(2);
    expect(Number(rows[1].stopped_at)).toBeLessThan(Date.now() - 39 * DAY);
  });
});

describe('Stop / Start / bulk API and audit', () => {
  it('writes audit entries for stop, start, keep-all and bulk', async () => {
    const d = await create();
    await act(d.id, 'stop'); await act(d.id, 'start'); await act(d.id, 'keep-all');
    await app.inject({ method: 'POST', url: '/api/disposable/bulk', headers: { cookie }, payload: { ids: [d.id], action: 'stop' } });
    const actions = (await q<any>("SELECT action FROM audit_log WHERE action LIKE 'disposable.%' ORDER BY id")).map((r) => r.action);
    expect(actions).toEqual(['disposable.stop', 'disposable.start', 'disposable.keep_all', 'disposable.bulk']);
  });

  it('search helpers: disposable:<address part>', async () => {
    const d = await create({ address: 'shopping.ab@push.test' });
    const r = await post(mail(d.address), d.address);
    const { queryEmails } = await import('../src/mail/store.ts');
    expect((await queryEmails(TEST_USER, { filter: { text: 'disposable:shopping' }, position: 0, limit: 10 })).ids).toEqual([`m${r.json().id}`]);
    expect((await queryEmails(TEST_USER, { filter: { text: 'disposable:nothing' }, position: 0, limit: 10 })).ids).toEqual([]);
  });
});
