import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, TEST_USER, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';
import { makeApp, resetLimiters, login } from './app.ts';
import { q, one, run, withTransaction } from '../src/db.ts';
import { emitEvent, pruneEvents } from '../src/events/emit.ts';
import { setPrefs } from '../src/events/notifier.ts';
import { recordOpen } from '../src/mail/tracking.ts';
import { insertTrackingPixel } from '../src/mail/send.ts';

const app = await makeApp();
afterAll(() => app.close());
beforeEach(async () => { await resetDb(); resetLimiters(); });

async function trackedSent(token: string) {
  const acct = await makeAccount('alice@demo.test');
  const sent = await makeMailbox(acct, 'Sent', 'sent');
  await ingest(acct, sent, rawEmail({
    from: 'alice@demo.test', to: 'Bob <bob@x.test>', subject: 'Quote for office cleaning',
    html: insertTrackingPixel('<p>hi</p>', token),
  }));
  return { acct, msg: (await one<{ id: number }>('SELECT id FROM messages WHERE tracking_token = ?', [token]))! };
}

describe('F-04 event bus', () => {
  it('an event emitted inside a rolled-back transaction leaves no event and no notification', async () => {
    await expect(withTransaction(async (client) => {
      await emitEvent(TEST_USER, 'mail.received', { type: 'message', id: 1 }, { from: 'x', subject: 'y' }, client);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await q('SELECT 1 FROM events')).toHaveLength(0);
    expect(await q('SELECT 1 FROM notifications')).toHaveLength(0);
  });

  it('a committed transaction writes the event, then the notification', async () => {
    await withTransaction(async (client) => {
      await emitEvent(TEST_USER, 'mail.received', { type: 'message', id: 1 }, { from: 'Ann', subject: 'Hello' }, client);
      // not visible outside the transaction yet
      expect(await q('SELECT 1 FROM notifications')).toHaveLength(0);
    });
    expect(await q('SELECT 1 FROM events')).toHaveLength(1);
    const n = await q<any>('SELECT title, body FROM notifications');
    expect(n).toEqual([{ title: 'Ann', body: 'Hello' }]);
  });

  it('five pixel hits on the same message → one unread notification with count 5', async () => {
    const token = 'd'.repeat(32);
    const { msg } = await trackedSent(token);
    for (let i = 0; i < 5; i++) await recordOpen(token, `9.9.9.${i}`, 'UA');
    const rows = await q<any>("SELECT count, title, link FROM notifications WHERE type = 'mail.opened'");
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(5);
    expect(rows[0].title).toBe('Bob opened "Quote for office cleaning"');
    expect(rows[0].link).toBe(`/mail/msg/m${msg.id}/opens`);
  });

  it('same-IP repeat within 60 s is stored but not re-notified', async () => {
    const token = 'e'.repeat(32);
    await trackedSent(token);
    await recordOpen(token, '7.7.7.7', 'UA');
    await recordOpen(token, '7.7.7.7', 'UA');
    expect((await q('SELECT 1 FROM tracking_opens WHERE token = ?', [token])).length).toBe(2);
    expect((await one<any>("SELECT count FROM notifications WHERE type = 'mail.opened'"))?.count).toBe(1);
  });

  it('a read grouped notification starts a fresh one on the next open', async () => {
    const token = 'f'.repeat(32);
    await trackedSent(token);
    await recordOpen(token, '1.1.1.1', 'UA');
    await run('UPDATE notifications SET read_at = ?', [Date.now()]);
    await recordOpen(token, '1.1.1.2', 'UA');
    expect(await q("SELECT 1 FROM notifications WHERE type = 'mail.opened'")).toHaveLength(2);
  });

  it('prefs mail.received in_app=false → event row exists, no notification', async () => {
    await setPrefs(TEST_USER, [{ type: 'mail.received', inApp: false, push: false, emailDigest: false }]);
    await emitEvent(TEST_USER, 'mail.received', { type: 'message', id: 5 }, { from: 'x', subject: 'y' });
    expect(await q("SELECT 1 FROM events WHERE type = 'mail.received'")).toHaveLength(1);
    expect(await q('SELECT 1 FROM notifications')).toHaveLength(0);
  });

  it('a muted mailbox produces events but no notifications', async () => {
    const acct = await makeAccount('muted@demo.test');
    await run('INSERT INTO notification_mutes(user_id, account_id) VALUES (?,?)', [TEST_USER, acct]);
    await emitEvent(TEST_USER, 'mail.received', { type: 'message', id: 6 }, { from: 'x', subject: 'y', accountId: acct });
    expect(await q('SELECT 1 FROM events')).toHaveLength(1);
    expect(await q('SELECT 1 FROM notifications')).toHaveLength(0);
  });

  it('prune keeps 180 days of events and 365 of notifications', async () => {
    const old = Date.now() - 200 * 86_400_000;
    await emitEvent(TEST_USER, 'mail.received', null, { from: 'a', subject: 'b' });
    await run('UPDATE events SET created_at = ?', [old]);
    await run('UPDATE notifications SET created_at = ?', [old]);
    const r = await pruneEvents();
    expect(r.events).toBe(1);
    expect(r.notifications).toBe(0);
  });
});

describe('F-04 notifications API', () => {
  it('summary returns the unread badge and the latest twenty', async () => {
    for (let i = 0; i < 25; i++) await emitEvent(TEST_USER, 'mail.received', null, { from: `S${i}`, subject: `s${i}` });
    const cookie = await login(app);
    const s = (await app.inject({ method: 'GET', url: '/api/notifications/summary', headers: { cookie } })).json();
    expect(s.unread).toBe(25);
    expect(s.latest).toHaveLength(20);
    expect(s.latest[0].title).toBe('S24');
  });

  it('130 notifications: page 3 at 50/page holds items 101–130, total 130', async () => {
    const now = Date.now();
    for (let i = 0; i < 130; i++) {
      await run(`INSERT INTO notifications(user_id, type, title, created_at, updated_at) VALUES (?,?,?,?,?)`,
        [TEST_USER, 'mail.received', `n${i + 1}`, now - i * 1000, now - i * 1000]);
    }
    const cookie = await login(app);
    const page = (await app.inject({ method: 'GET', url: '/api/notifications?limit=50&offset=100', headers: { cookie } })).json();
    expect(page.total).toBe(130);
    expect(page.items).toHaveLength(30);
    expect(page.items[0].title).toBe('n101');
    expect(page.items[29].title).toBe('n130');
  });

  it('type + date filters return only matching rows, and the count matches', async () => {
    const now = Date.now();
    const ins = (type: string, at: number) => run('INSERT INTO notifications(user_id, type, title, created_at, updated_at) VALUES (?,?,?,?,?)', [TEST_USER, type, type, at, at]);
    await ins('mail.opened', now - 1 * 86_400_000);
    await ins('mail.opened', now - 10 * 86_400_000);
    await ins('mail.received', now - 1 * 86_400_000);
    const cookie = await login(app);
    const res = (await app.inject({ method: 'GET', url: `/api/notifications?types=mail.opened&from=${now - 3 * 86_400_000}&to=${now}`, headers: { cookie } })).json();
    expect(res.total).toBe(1);
    expect(res.items.map((i: any) => i.type)).toEqual(['mail.opened']);
  });

  it('mark all read clears the unread count; unread restores one', async () => {
    for (let i = 0; i < 3; i++) await emitEvent(TEST_USER, 'mail.received', null, { from: 'a', subject: 'b' });
    const cookie = await login(app);
    await app.inject({ method: 'POST', url: '/api/notifications/read', headers: { cookie }, payload: { all: true } });
    let s = (await app.inject({ method: 'GET', url: '/api/notifications/summary', headers: { cookie } })).json();
    expect(s.unread).toBe(0);
    await app.inject({ method: 'POST', url: '/api/notifications/unread', headers: { cookie }, payload: { ids: [s.latest[0].id] } });
    s = (await app.inject({ method: 'GET', url: '/api/notifications/summary', headers: { cookie } })).json();
    expect(s.unread).toBe(1);
  });

  it('user B cannot list or mark user A notifications', async () => {
    await emitEvent(TEST_USER, 'mail.received', null, { from: 'secret', subject: 'x' });
    const b = await makeUser('b@local');
    expect(b).toBeGreaterThan(0);
    const bCookie = await login(app, 'b@local');
    const list = (await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: bCookie } })).json();
    expect(list.total).toBe(0);
    const aId = (await one<{ id: number }>('SELECT id FROM notifications WHERE user_id = ?', [TEST_USER]))!.id;
    await app.inject({ method: 'POST', url: '/api/notifications/read', headers: { cookie: bCookie }, payload: { ids: [aId] } });
    await app.inject({ method: 'DELETE', url: `/api/notifications/${aId}`, headers: { cookie: bCookie } });
    const row = await one<any>('SELECT read_at FROM notifications WHERE id = ?', [aId]);
    expect(row).toBeTruthy();
    expect(row.read_at).toBeNull();
  });

  it('prefs round-trip with mutes', async () => {
    const acct = await makeAccount('alice@demo.test');
    const cookie = await login(app);
    await app.inject({ method: 'PUT', url: '/api/notification-prefs', headers: { cookie }, payload: {
      prefs: [{ type: 'mail.opened', inApp: false, push: true, emailDigest: false }], mutedAccountIds: [acct],
      quiet: { enabled: true, from: '22:00', to: '07:00' },
    } });
    const p = (await app.inject({ method: 'GET', url: '/api/notification-prefs', headers: { cookie } })).json();
    expect(p.prefs.find((x: any) => x.type === 'mail.opened')).toMatchObject({ inApp: false, push: true });
    expect(p.mutedAccountIds).toEqual([acct]);
    expect(p.quiet.enabled).toBe(true);
  });
});
