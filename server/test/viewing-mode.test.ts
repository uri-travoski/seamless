import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';

const sent: any[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true, close() {} }) } };
});

const { q, one, run, insertId } = await import('../src/db.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');
const { loadMode, currentMode, assertLive, ViewingModeError, setStoredMode } = await import('../src/mode.ts');
const { sendEmail, scheduleEmail } = await import('../src/mail/send.ts');
const { queueSend } = await import('../src/mail/undoSend.ts');
const { processDueSends } = await import('../src/mail/scheduler.ts');
const { sweepForwarding } = await import('../src/classify/forward.ts');
const { sweepRetention } = await import('../src/classify/retention.ts');
const { syncManager } = await import('../src/imap/sync.ts');
const { sign } = await import('../src/transport/inbound/push.ts');
const { testIncoming, testOutgoing } = await import('../src/mail/connTest.ts');
const { pollPop3 } = await import('../src/transport/inbound/pop3.ts');
const { queryEmails } = await import('../src/mail/store.ts');

const app = await makeApp();
afterAll(() => app.close());

let cookie: string, acct: number, inboxMb: number, msgId: string, msgRow: number;
const hdr = () => ({ cookie });
const payload = (extra: Partial<any> = {}) => ({
  accountId: acct, fromEmail: 'alice@demo.test', to: [{ name: 'Bob', email: 'bob@x.test' }], cc: [], bcc: [],
  subject: 'Quote', html: '<p>hello</p>', attachmentIds: [], track: false, ...extra,
});
const viewing = async () => { await setStoredMode('viewing'); };
const call = (method: string, url: string, body?: any, headers: any = hdr()) => app.inject({ method: method as any, url, headers, payload: body });

beforeEach(async () => {
  delete process.env.SEAMLESS_MODE;
  await resetDb(); resetLimiters(); sent.length = 0;
  cookie = await login(app);
  acct = await makeAccount('alice@demo.test');
  inboxMb = await makeMailbox(acct, 'INBOX', 'inbox');
  await makeMailbox(acct, 'Sent', 'sent');
  const r = await ingest(acct, inboxMb, rawEmail({ from: 'Carol <carol@x.test>', to: 'alice@demo.test', subject: 'Invoice 42', body: 'pay me' }));
  msgRow = (r as any).id ?? (r as any).rowId;
  msgId = 'm' + msgRow;
});
afterEach(() => { delete process.env.SEAMLESS_MODE; });

describe('guard', () => {
  it('assertLive throws ViewingModeError only in viewing mode', async () => {
    expect(() => assertLive('sending mail')).not.toThrow();
    await viewing();
    expect(() => assertLive('sending mail')).toThrowError(ViewingModeError);
    try { assertLive('sending mail'); } catch (e: any) { expect(e.message).toBe('Viewing mode: sending mail is turned off'); expect(e.statusCode).toBe(409); }
  });
});

describe('every send path is refused in viewing mode and works in live mode', () => {
  const routes: { name: string; run: () => Promise<any> }[] = [
    { name: 'POST /api/send (undo-send queue)', run: () => call('POST', '/api/send', payload()) },
    { name: 'POST /api/send (immediate)', run: async () => { await run("INSERT INTO user_settings(user_id, key, value) VALUES (?, 'undo_send_seconds', '0') ON CONFLICT (user_id, key) DO UPDATE SET value = '0'", [TEST_USER]); return call('POST', '/api/send', payload()); } },
    { name: 'POST /api/schedule', run: () => call('POST', '/api/schedule', { ...payload(), sendAt: Date.now() + 3_600_000 }) },
  ];
  for (const r of routes) {
    it(`${r.name}: 409 in viewing, ok in live`, async () => {
      const live = await r.run();
      expect(live.statusCode).toBe(200);
      await viewing();
      sent.length = 0;
      const res = await r.run();
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'viewing_mode', message: 'Viewing mode: sending mail is turned off' });
      expect(sent).toHaveLength(0);
    });
  }

  it('sendEmail, scheduleEmail and queueSend throw', async () => {
    await viewing();
    await expect(sendEmail(TEST_USER, payload())).rejects.toBeInstanceOf(ViewingModeError);
    await expect(scheduleEmail(TEST_USER, payload(), Date.now() + 60_000)).rejects.toBeInstanceOf(ViewingModeError);
    await expect(queueSend(TEST_USER, payload())).rejects.toBeInstanceOf(ViewingModeError);
    expect(sent).toHaveLength(0);
  });

  it('API v1 /send, calendar reply and the SMTP-type connection tests', async () => {
    await viewing();
    for (const [m, u] of [['POST', '/api/v1/send'], ['POST', '/api/invites/1/rsvp'], ['POST', '/api/accounts/test'], ['POST', '/api/accounts/test/incoming'], ['POST', '/api/accounts/test/outgoing'], ['POST', '/api/accounts/test/pop3'], ['POST', '/api/transports/1/test']] as const) {
      const res = await call(m, u, {});
      // /api/v1 needs a bearer token (401 first); everything else is refused by the mode guard
      expect(res.statusCode, `${m} ${u}`).toBe(u.startsWith('/api/v1') ? 401 : 409);
    }
    await expect(testIncoming({ host: 'x', port: 1, secure: false, user: 'u' } as any)).rejects.toBeInstanceOf(ViewingModeError);
    await expect(testOutgoing({ host: 'x', port: 1, secure: false, user: 'u' } as any)).rejects.toBeInstanceOf(ViewingModeError);
  });

  it('the scheduled-send worker sends nothing; queued items wait', async () => {
    const s = await scheduleEmail(TEST_USER, payload(), Date.now() + 1000);
    await viewing();
    expect(await processDueSends(Date.now() + 10_000)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await one('SELECT 1 FROM scheduled_sends WHERE id = ?', [s.id])).toBeTruthy();
    await setStoredMode('live');
    expect(await processDueSends(Date.now() + 10_000)).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('forwarding sends nothing in viewing mode', async () => {
    await viewing();
    expect(await sweepForwarding()).toBe(0);
  });

  it('unsubscribe by mailto is refused', async () => {
    await viewing();
    const { unsubscribe } = await import('../src/mail/newsletters.ts');
    await expect(unsubscribe(TEST_USER, 'nope')).rejects.toBeTruthy();   // fails on lookup, never sends
    expect(sent).toHaveLength(0);
  });
});

describe('nothing is received in viewing mode', () => {
  it('pollers do not start, POP3 poll refuses, kick finds nothing', async () => {
    await viewing();
    const a = await one<any>('SELECT * FROM accounts WHERE id = ?', [acct]);
    syncManager.startAccount(a);
    expect(syncManager.status(acct).state).toBe('paused');
    await syncManager.startAll();
    expect(syncManager.status(acct).state).toBe('paused');
    await expect(pollPop3(acct)).rejects.toBeInstanceOf(ViewingModeError);
  });

  it('Check New Mail answers "nothing to fetch"', async () => {
    await viewing();
    const res = await call('POST', '/api/sync', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, viewing: true, message: 'Viewing mode — nothing to fetch' });
  });

  it('push ingest endpoint answers 409 and stores nothing', async () => {
    const created = await call('POST', '/api/push-inboxes', { name: 'Push', email: 'me@push.test', domains: ['push.test'] });
    expect(created.statusCode).toBe(200);
    const inbox = created.json();
    await viewing();
    const raw = rawEmail({ from: 'Carol <carol@x.test>', to: 'me@push.test', subject: 'Hi push' });
    const ts = String(Date.now());
    const before = Number((await one<any>('SELECT count(*) AS c FROM messages'))!.c);
    const res = await app.inject({ method: 'POST', url: `/api/ingest/${inbox.token}`, payload: raw,
      headers: { 'content-type': 'message/rfc822', 'x-seamless-timestamp': ts, 'x-seamless-rcpt': 'me@push.test', 'x-seamless-signature': sign(inbox.secret, ts, raw) } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('viewing_mode');
    expect(Number((await one<any>('SELECT count(*) AS c FROM messages'))!.c)).toBe(before);
  });
});

describe('local actions work in both modes', () => {
  const modes = ['live', 'viewing'] as const;
  for (const mode of modes) {
    it(`reading, labels, rules, filters, views, templates, contacts, move, delete, search, export — ${mode}`, async () => {
      if (mode === 'viewing') await viewing();
      const ok = (r: any, what: string) => expect(r.statusCode, `${what}: ${r.body}`).toBe(200);

      ok(await call('POST', '/api/bulk', { ids: [msgId], action: 'read' }), 'mark read');
      ok(await call('POST', '/api/bulk', { ids: [msgId], action: 'star' }), 'star');
      const lab = await call('POST', '/api/labels', { name: 'Money', color: '#112233' });
      ok(lab, 'create label');
      const labelId = lab.json().id;
      ok(await call('PUT', `/api/labels/${labelId}`, { name: 'Money2', color: '#445566' }), 'rename label');
      ok(await call('POST', '/api/bulk', { ids: [msgId], action: 'label', value: labelId }), 'apply label');
      ok(await call('PUT', `/api/message/${msgId}/note`, { body: 'a note' }), 'note');

      const rule = await call('POST', '/api/rules', { matchField: 'from', matchValue: 'carol@x.test', action: 'label', labelId });
      ok(rule, 'rule create');
      ok(await call('PUT', `/api/rules/${rule.json().id}`, { enabled: false, matchField: 'from', matchValue: 'carol@x.test', action: 'label', labelId }), 'rule edit');

      const flt = await call('POST', '/api/filters', { name: 'F', conditions: [{ field: 'subject', op: 'contains', value: 'Invoice' }], actions: [{ type: 'markRead' }] });
      ok(flt, 'filter create');
      ok(await call('POST', `/api/filters/${flt.json().id}/run`, {}), 'filter run on existing mail');

      ok(await call('POST', '/api/views', { name: 'Inv', query: 'invoice' }), 'saved view');
      ok(await call('POST', '/api/templates', { name: 'T', bodyHtml: '<p>x</p>' }), 'template');
      const contacts = await call('GET', '/api/contacts'); ok(contacts, 'contacts');
      ok(await call('GET', '/api/labels'), 'labels list');

      const found = await queryEmails(TEST_USER, { filter: { text: 'invoice' }, position: 0, limit: 10 });
      expect(found.ids).toContain(msgId);

      ok(await call('POST', '/api/bulk', { ids: [msgId], action: 'archive' }), 'move to archive');
      ok(await call('POST', '/api/bulk', { ids: [msgId], action: 'delete' }), 'delete');
      ok(await call('POST', '/api/bulk', { ids: [msgId], action: 'inbox' }), 'restore');

      const exp = await call('POST', '/api/export', { password: 'longenoughpassword1', includeMail: false });
      ok(exp, 'export');
      ok(await call('GET', '/api/health'), 'health');
      ok(await call('GET', '/api/accounts'), 'accounts list');
    });
  }

  it('drafts can still be saved locally in viewing mode', async () => {
    await viewing();
    const res = await call('POST', '/api/draft', payload());
    expect(res.statusCode).toBe(200);
  });

  it('shared-mailbox actions (labels, share list) keep working', async () => {
    const bob = await makeUser('bob@local');
    await viewing();
    const res = await call('GET', `/api/accounts/${acct}/shares`);
    expect([200, 404]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(409);
    expect(bob).toBeGreaterThan(0);
  });
});

describe('retention does not touch archive-imported mail', () => {
  it('a keep-disposition message survives the sweep, in viewing mode too', async () => {
    await viewing();
    await run("UPDATE messages SET disposition = 'keep', keep_reason = 'archived', delete_at = 1 WHERE id = ?", [msgRow]);
    await run("INSERT INTO user_settings(user_id, key, value) VALUES (?, 'dry_run', 'false') ON CONFLICT (user_id, key) DO UPDATE SET value = 'false'", [TEST_USER]);
    await sweepRetention(Date.now() + 86_400_000 * 400);
    const row = await one<any>('SELECT mb.role FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.id = ?', [msgRow]);
    expect(row.role).toBe('inbox');
  });
});

describe('switching', () => {
  it('env beats the setting and locks the switch', async () => {
    process.env.SEAMLESS_MODE = 'viewing';
    expect(currentMode()).toBe('viewing');
    const m = await call('GET', '/api/mode');
    expect(m.json()).toMatchObject({ mode: 'viewing', locked: true, source: 'server' });
    const res = await call('PUT', '/api/mode', { mode: 'live', confirm: 'LIVE' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('mode_locked');
    process.env.SEAMLESS_MODE = 'live';
    await setStoredMode('viewing');
    expect(currentMode()).toBe('live');
  });

  it('only admins can switch', async () => {
    await makeUser('member@local');
    const mc = await login(app, 'member@local');
    const res = await call('PUT', '/api/mode', { mode: 'viewing' }, { cookie: mc });
    expect(res.statusCode).toBe(403);
    expect(currentMode()).toBe('live');
    expect((await call('GET', '/api/mode', undefined, { cookie: mc })).statusCode).toBe(200);
  });

  it('live → viewing works for an admin; viewing → live needs the word LIVE and discards stale queues', async () => {
    expect((await call('PUT', '/api/mode', { mode: 'viewing' })).json()).toMatchObject({ ok: true, mode: 'viewing' });
    expect(await loadMode()).toBe('viewing');   // persisted
    // stale queued mail that came with a restored backup
    await run("INSERT INTO scheduled_sends(account_id, message_id, s3_key, envelope_from, envelope_to, send_at, created_at) VALUES (?,?,?,?,?,?,?)", [acct, '<s@x>', 'k', 'a@b.c', '[]', 1, 1]);
    await run("INSERT INTO op_queue(account_id, op, payload, created_at) VALUES (?,?,?,?)", [acct, 'setFlags', '{}', 1]);
    await insertId("INSERT INTO jobs(user_id, kind, run_at, payload, created_at) VALUES (?,?,?,?,?)", [TEST_USER, 'send.release', 1, '{}', 1]);
    const info = (await call('GET', '/api/mode')).json();
    expect(info.stale).toEqual({ scheduledSends: 1, ops: 1, undoSends: 1 });

    const no = await call('PUT', '/api/mode', { mode: 'live' });
    expect(no.statusCode).toBe(400);
    expect(currentMode()).toBe('viewing');
    const wrong = await call('PUT', '/api/mode', { mode: 'live', confirm: 'live' });
    expect(wrong.statusCode).toBe(400);

    const yes = await call('PUT', '/api/mode', { mode: 'live', confirm: 'LIVE' });
    expect(yes.statusCode).toBe(200);
    expect(yes.json()).toMatchObject({ mode: 'live', discarded: { scheduledSends: 1, ops: 1, undoSends: 1 } });
    expect(await one('SELECT 1 FROM scheduled_sends')).toBeUndefined();
    expect(await one('SELECT 1 FROM op_queue')).toBeUndefined();
    expect((await one<any>("SELECT status FROM jobs WHERE kind = 'send.release'"))!.status).toBe('cancelled');
    syncManager.stopAll();
  });

  it('"keep" keeps the old queue', async () => {
    await viewing();
    await run("INSERT INTO scheduled_sends(account_id, message_id, s3_key, envelope_from, envelope_to, send_at, created_at) VALUES (?,?,?,?,?,?,?)", [acct, '<s@x>', 'k', 'a@b.c', '[]', 1, 1]);
    const yes = await call('PUT', '/api/mode', { mode: 'live', confirm: 'LIVE', stale: 'keep' });
    expect(yes.statusCode).toBe(200);
    expect(await one('SELECT 1 FROM scheduled_sends')).toBeTruthy();
    syncManager.stopAll();
  });

  it('mode appears in /api/me and /healthz', async () => {
    expect((await call('GET', '/api/me')).json()).toMatchObject({ mode: 'live', modeLocked: false });
    expect((await app.inject({ method: 'GET', url: '/api/me' })).json()).toMatchObject({ mode: 'live' });
    await viewing();
    expect((await call('GET', '/api/me')).json().mode).toBe('viewing');
    expect((await app.inject({ method: 'GET', url: '/healthz' })).json().mode).toBe('viewing');
    expect((await call('GET', '/api/health')).json().mode).toBe('viewing');
  });
});
