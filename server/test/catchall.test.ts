import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { ImapFlow } from 'imapflow';
import net from 'node:net';
import { resetDb, makeUser, TEST_USER, rawEmail, blobStore } from './helpers.ts';

const sent: any[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { q, one, run, insertId } = await import('../src/db.ts');
const { encrypt } = await import('../src/crypto.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');
const { checkNow, hooks, testResults, PROCESSED_FOLDER, routeMessage, destInboxFor } = await import('../src/transport/inbound/catchall.ts');
const { purgeQuarantine } = await import('../src/mail/unknown.ts');

let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;

const imap = () => new ImapFlow({ host: 'localhost', port: 3144, secure: false, auth: { user: 'bob', pass: 'bobpw' }, logger: false });
async function inFolder(path: string): Promise<string[]> {
  const c = imap(); await c.connect();
  const out: string[] = [];
  try {
    if (!(await c.list()).some((m) => m.path === path)) return out;
    const lock = await c.getMailboxLock(path);
    try { for await (const m of c.fetch('1:*', { envelope: true }, { uid: false })) out.push(m.envelope?.subject ?? ''); } catch { /* empty folder */ } finally { lock.release(); }
  } finally { await c.logout(); }
  return out;
}
async function wipeProvider() {
  const c = imap(); await c.connect();
  try {
    for (const mb of await c.list()) {
      if (mb.path !== 'INBOX' && mb.path !== PROCESSED_FOLDER) continue;
      const lock = await c.getMailboxLock(mb.path);
      try { if (c.mailbox && typeof c.mailbox !== 'boolean' && c.mailbox.exists > 0) await c.messageDelete('1:*'); } finally { lock.release(); }
    }
  } finally { await c.logout(); }
}
async function putOnProvider(raws: Buffer[]) {
  const c = imap(); await c.connect();
  try { for (const r of raws) await c.append('INBOX', r); } finally { await c.logout(); }
}
const mail = (deliveredTo: string, subject: string, extra: Partial<Parameters<typeof rawEmail>[0]> = {}) =>
  rawEmail({ from: 'News <news@shop.test>', to: 'someone@else.test', subject, deliveredTo, ...extra });

let src: number;
async function setup(after: string = 'move', domains = ['burn.test']) {
  src = await insertId(`
    INSERT INTO accounts(user_id, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc,
      smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, created_at, inbound_kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'imap')`,
    [TEST_USER, 'Catch-all', 'bob@demo.test', '[]', 'localhost', 3144, false, 'bob', encrypt('bobpw'), '', 0, false, '', encrypt(''), Date.now()]);
  const res = await app.inject({ method: 'POST', url: '/api/catchall', headers: { cookie }, payload: { accountId: src, domains, after } });
  expect(res.statusCode).toBe(200);
  const { syncManager } = await import('../src/imap/sync.ts');
  syncManager.stopAccount(src);   // the tests drive passes by hand (checkNow); no background loop racing them
  return res.json() as { destAccountId: number };
}
const createAddr = async (address: string) =>
  (await app.inject({ method: 'POST', url: '/api/disposable', headers: { cookie }, payload: { domain: address.split('@')[1], address, label: 'L' } })).json();
const inboxCount = async (destId: number) => Number((await one<{ c: number }>("SELECT COUNT(*)::int AS c FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE m.account_id = ? AND b.role = 'inbox'", [destId]))!.c);

beforeEach(async () => {
  await resetDb(); resetLimiters(); blobStore.clear(); hooks.beforeFinish = undefined; testResults.clear(); sent.length = 0;
  app = await makeApp();
  cookie = await login(app);
  await wipeProvider();
});
afterAll(async () => { await wipeProvider(); });

describe('catch-all over IMAP (GreenMail)', () => {
  it('routes active → Inbox, unknown → quarantine, moves the originals to "Seamless processed"; the source account lists nothing', async () => {
    const { destAccountId } = await setup();
    const a = await createAddr('shop.k7f2q9@burn.test');
    expect(a.address).toBe('shop.k7f2q9@burn.test');
    await putOnProvider([mail('shop.k7f2q9@burn.test', 'to active'), mail('nobody.x1@burn.test', 'to unknown'), mail('who@burn.test', 'second unknown')]);
    const r = await checkNow(src);
    expect(r).toMatchObject({ error: null, routed: 3, finished: 3, failed: 0 });
    expect(await inboxCount(destAccountId)).toBe(1);
    const row = await one<any>('SELECT disposable_id, subject FROM messages WHERE account_id = ?', [destAccountId]);
    expect(row).toMatchObject({ disposable_id: a.id, subject: 'to active' });
    expect(await q("SELECT 1 FROM messages WHERE account_id = ?", [src])).toHaveLength(0);   // the catch-all mailbox itself is never listed
    const unknown = (await app.inject({ method: 'GET', url: '/api/catchall', headers: { cookie } })).json().unknown;
    expect(unknown.map((u: any) => u.address).sort()).toEqual(['nobody.x1@burn.test', 'who@burn.test']);
    expect(await inFolder('INBOX')).toEqual([]);
    expect((await inFolder(PROCESSED_FOLDER)).sort()).toEqual(['second unknown', 'to active', 'to unknown']);
    // a second pass changes nothing
    expect(await checkNow(src)).toMatchObject({ routed: 0, finished: 0 });
    expect(await inboxCount(destAccountId)).toBe(1);
  });

  it('stopped address: mail goes to the Bin, not the Inbox', async () => {
    const { destAccountId } = await setup();
    const a = await createAddr('old.aa@burn.test');
    await app.inject({ method: 'POST', url: `/api/disposable/${a.id}/stop`, headers: { cookie } });
    await putOnProvider([mail('old.aa@burn.test', 'late mail')]);
    expect(await checkNow(src)).toMatchObject({ routed: 1, error: null });
    expect(await inboxCount(destAccountId)).toBe(0);
    expect((await one<any>('SELECT stopped_stored FROM disposable_addresses WHERE id = ?', [a.id])).stopped_stored).toBe(1);
  });

  it('per-domain policy: deliver puts unknown mail in the Inbox, drop discards it, quarantine keeps it', async () => {
    const { destAccountId } = await setup('leave', ['burn.test', 'drop.test', 'open.test']);
    const dest = (await destInboxFor(src))!;
    const put = await app.inject({ method: 'PUT', url: `/api/push-inboxes/${dest.token}`, headers: { cookie }, payload: { domainPolicies: { 'drop.test': 'drop', 'open.test': 'deliver' } } });
    expect(put.statusCode).toBe(200);
    expect(put.json().domainPolicies).toEqual({ 'drop.test': 'drop', 'open.test': 'deliver' });   // overrides only; burn.test keeps the default
    await putOnProvider([mail('a@burn.test', 'q'), mail('b@drop.test', 'd'), mail('c@open.test', 'o')]);
    expect(await checkNow(src)).toMatchObject({ routed: 3, error: null });
    expect(await inboxCount(destAccountId)).toBe(1);
    expect((await one<any>('SELECT subject FROM messages WHERE account_id = ?', [destAccountId])).subject).toBe('o');
    expect((await q<any>('SELECT address FROM unknown_addresses')).map((u) => u.address)).toEqual(['a@burn.test']);
    expect((await inFolder('INBOX')).sort()).toEqual(['d', 'o', 'q']);   // `leave`: untouched at the provider
    expect(await checkNow(src)).toMatchObject({ routed: 0 });            // …and not routed twice
    expect(await inboxCount(destAccountId)).toBe(1);
  });

  it('header priority is applied end to end (Delivered-To beats To)', async () => {
    const { destAccountId } = await setup();
    const a = await createAddr('real.zz@burn.test');
    await putOnProvider([rawEmail({ from: 'x@shop.test', to: 'decoy@burn.test', subject: 'prio', deliveredTo: 'real.zz@burn.test' })]);
    await checkNow(src);
    expect((await one<any>('SELECT disposable_id FROM messages WHERE account_id = ?', [destAccountId])).disposable_id).toBe(a.id);
    expect(await q('SELECT 1 FROM unknown_addresses')).toHaveLength(0);
  });

  it('delete mode removes the provider copy only after it is stored', async () => {
    const { destAccountId } = await setup('delete');
    await createAddr('d.one@burn.test');
    await putOnProvider([mail('d.one@burn.test', 'gone after save')]);
    await checkNow(src);
    expect(await inboxCount(destAccountId)).toBe(1);
    expect(await inFolder('INBOX')).toEqual([]);
    expect(await inFolder(PROCESSED_FOLDER)).toEqual([]);
  });

  it('crash between save and move: the mail stays on the provider, is not stored twice, and is moved on the next pass', async () => {
    const { destAccountId } = await setup();
    await createAddr('crash.q@burn.test');
    await putOnProvider([mail('crash.q@burn.test', 'survivor')]);
    hooks.beforeFinish = () => { throw new Error('simulated crash'); };
    const r1 = await checkNow(src);
    expect(r1).toMatchObject({ routed: 1, finished: 0, failed: 1 });
    expect(await inFolder('INBOX')).toEqual(['survivor']);   // nothing lost
    expect(await inboxCount(destAccountId)).toBe(1);
    hooks.beforeFinish = undefined;
    const r2 = await checkNow(src);
    expect(r2).toMatchObject({ routed: 0, finished: 1, failed: 0 });
    expect(await inboxCount(destAccountId)).toBe(1);          // still exactly one copy
    expect(await inFolder('INBOX')).toEqual([]);
    expect(await inFolder(PROCESSED_FOLDER)).toEqual(['survivor']);
  });

  it('a message that fails to store is never moved or deleted (retried next time)', async () => {
    await setup('delete');
    await createAddr('fail.q@burn.test');
    await putOnProvider([mail('fail.q@burn.test', 'unstorable')]);
    const realSet = blobStore.set.bind(blobStore);
    blobStore.set = () => { throw new Error('s3 down'); };
    const r = await checkNow(src);
    blobStore.set = realSet;
    expect(r).toMatchObject({ routed: 0, failed: 1 });
    expect(await inFolder('INBOX')).toEqual(['unstorable']);
    expect(await checkNow(src)).toMatchObject({ routed: 1, finished: 1 });
  });

  it('unknown address: Create this address delivers what was held; Block drops later mail; purge after a week', async () => {
    const { destAccountId } = await setup('leave');
    await putOnProvider([mail('new.one@burn.test', 'hello 1'), mail('spam.x@burn.test', 'junk')]);
    await checkNow(src);
    const list = (await app.inject({ method: 'GET', url: '/api/catchall', headers: { cookie } })).json().unknown;
    const one_ = list.find((u: any) => u.address === 'new.one@burn.test');
    const spam = list.find((u: any) => u.address === 'spam.x@burn.test');
    const created = await app.inject({ method: 'POST', url: `/api/catchall/unknown/${one_.id}/create`, headers: { cookie }, payload: {} });
    expect(created.json()).toMatchObject({ address: 'new.one@burn.test', delivered: 1 });
    expect(await inboxCount(destAccountId)).toBe(1);
    expect(await q('SELECT 1 FROM unknown_addresses WHERE id = ?', [one_.id])).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: `/api/catchall/unknown/${spam.id}/block`, headers: { cookie } })).statusCode).toBe(200);
    expect(blobStore.size).toBeGreaterThan(0);
    await putOnProvider([mail('spam.x@burn.test', 'junk again')]);
    await checkNow(src);
    const row = await one<any>("SELECT status, dropped_count, (SELECT COUNT(*)::int FROM quarantined_mail) AS held FROM unknown_addresses WHERE id = ?", [spam.id]);
    expect(row).toMatchObject({ status: 'blocked', dropped_count: 1, held: 0 });
    // retention: held mail older than 7 days is purged, with its blob
    await putOnProvider([mail('old.hold@burn.test', 'stale')]);
    await checkNow(src);
    const heldKey = (await one<any>('SELECT s3_key FROM quarantined_mail'))!.s3_key;
    expect(blobStore.has(heldKey)).toBe(true);
    await run('UPDATE quarantined_mail SET received_at = ?', [Date.now() - 8 * 86_400_000]);
    expect(await purgeQuarantine()).toBe(1);
    expect(blobStore.has(heldKey)).toBe(false);
    expect(await q("SELECT 1 FROM unknown_addresses WHERE address = 'old.hold@burn.test'")).toHaveLength(0);
  });

  it('test mail to a random address proves routing and stores nothing', async () => {
    const { destAccountId } = await setup('leave');
    await run("INSERT INTO accounts(user_id, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [TEST_USER, 'Main', 'me@main.test', '[]', 'imap.test', 993, true, 'me', encrypt('x'), 'smtp.test', 465, true, 'me', encrypt('x'), Date.now()]);
    const t = await app.inject({ method: 'POST', url: `/api/catchall/${src}/test-mail`, headers: { cookie }, payload: {} });
    expect(t.statusCode).toBe(200);
    const { token, address } = t.json();
    expect(address).toMatch(/^seamless-test-[a-z0-9]{8}@burn\.test$/);
    expect(sent).toHaveLength(1);
    const get = async () => (await app.inject({ method: 'GET', url: `/api/catchall/test/${token}`, headers: { cookie } })).json();
    expect(await get()).toEqual({ state: 'waiting' });
    await putOnProvider([rawEmail({ from: 'me@main.test', to: address, subject: 'Seamless catch-all test', deliveredTo: address })]);
    await checkNow(src);
    expect(await get()).toMatchObject({ state: 'routed', address, via: 'delivered-to' });
    expect(await inboxCount(destAccountId)).toBe(0);
    expect(await q('SELECT 1 FROM unknown_addresses')).toHaveLength(0);
    // another user cannot see the result
    await makeUser('other@local');
    resetLimiters();
    const other = await login(app, 'other@local');
    expect((await app.inject({ method: 'GET', url: `/api/catchall/test/${token}`, headers: { cookie: other } })).json()).toEqual({ state: 'waiting' });
  });

  it('health: an unreachable catch-all mailbox reports an error and raises sync.failed from the second failure', async () => {
    await setup();
    await run("UPDATE accounts SET imap_port = 1 WHERE id = ?", [src]);
    const { syncManager } = await import('../src/imap/sync.ts');
    const seen: any[] = [];
    syncManager.on('syncFailed', (e) => seen.push(e));
    const r1 = await checkNow(src);
    expect(r1.error).toBeTruthy();
    expect(syncManager.status(src)).toMatchObject({ state: 'error', failures: 1 });
    await checkNow(src);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ accountId: src });
    syncManager.removeAllListeners('syncFailed');
  });
});

describe('catch-all API', () => {
  it('validates input, hides nothing else, and is per-user', async () => {
    await setup('leave');
    expect((await app.inject({ method: 'POST', url: '/api/catchall', headers: { cookie }, payload: { accountId: src, domains: ['not a domain'] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/catchall', headers: { cookie }, payload: { accountId: 9999, domains: ['x.test'] } })).statusCode).toBe(404);
    const list = (await app.inject({ method: 'GET', url: '/api/catchall', headers: { cookie } })).json();
    expect(list.mailboxes).toHaveLength(1);
    expect(list.mailboxes[0]).toMatchObject({ accountId: src, after: 'leave', domains: [{ domain: 'burn.test', policy: 'quarantine' }] });
    const accounts = (await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie } })).json();
    expect(accounts.find((a: any) => a.id === src).catchall).toBe(true);
    // user B cannot see, change, or act on it
    await makeUser('b@local');
    resetLimiters();
    const b = await login(app, 'b@local');
    const bl = (await app.inject({ method: 'GET', url: '/api/catchall', headers: { cookie: b } })).json();
    expect(bl).toMatchObject({ mailboxes: [], domains: [], unknown: [] });
    for (const [method, url] of [['PUT', `/api/catchall/${src}`], ['DELETE', `/api/catchall/${src}`], ['POST', `/api/catchall/${src}/check`], ['POST', `/api/catchall/${src}/test-mail`]] as const) {
      expect((await app.inject({ method, url, headers: { cookie: b }, payload: {} })).statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: '/api/catchall', headers: { cookie: b }, payload: { accountId: src, domains: ['x.test'] } })).statusCode).toBe(404);
    // domain clash across inboxes
    const other = await insertId("INSERT INTO accounts(user_id, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [TEST_USER, 'Two', 'two@x.test', '[]', 'localhost', 3144, false, 'bob', encrypt('bobpw'), '', 0, false, '', encrypt(''), Date.now()]);
    expect((await app.inject({ method: 'POST', url: '/api/catchall', headers: { cookie }, payload: { accountId: other, domains: ['burn.test'] } })).statusCode).toBe(409);
  });

  it('quarantined mail of user A is invisible to user B', async () => {
    const { destAccountId } = await setup('leave');
    await putOnProvider([mail('zz@burn.test', 'private')]);
    await checkNow(src);
    const id = (await one<any>('SELECT id FROM unknown_addresses'))!.id;
    await makeUser('b2@local'); resetLimiters();
    const b = await login(app, 'b2@local');
    for (const [method, url] of [['POST', `/api/catchall/unknown/${id}/create`], ['POST', `/api/catchall/unknown/${id}/block`], ['DELETE', `/api/catchall/unknown/${id}`]] as const) {
      expect((await app.inject({ method, url, headers: { cookie: b }, payload: {} })).statusCode).toBe(404);
    }
    expect(destAccountId).toBeGreaterThan(0);
  });

  it('disable turns it back into a normal mailbox and keeps the addresses', async () => {
    const { destAccountId } = await setup('leave');
    await createAddr('keep.me@burn.test');
    expect((await app.inject({ method: 'DELETE', url: `/api/catchall/${src}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await one<any>('SELECT catchall FROM accounts WHERE id = ?', [src])).catchall).toBe(false);
    expect(await q('SELECT 1 FROM disposable_addresses WHERE account_id = ?', [destAccountId])).toHaveLength(1);
  });
});

describe('Cloudflare route unchanged + policy UI backing', () => {
  it('default policy is still deliver; the new policies are accepted', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/push-inboxes', headers: { cookie }, payload: { name: 'Push', email: 'me@push.test', domains: ['push.test'] } });
    const j = res.json();
    expect(j.unknownPolicy).toBe('deliver');
    for (const p of ['quarantine', 'drop', 'reject', 'deliver']) {
      expect((await app.inject({ method: 'PUT', url: `/api/push-inboxes/${j.token}`, headers: { cookie }, payload: { unknownPolicy: p } })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'PUT', url: `/api/push-inboxes/${j.token}`, headers: { cookie }, payload: { unknownPolicy: 'bogus' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/api/push-inboxes/${j.token}`, headers: { cookie }, payload: { domainPolicies: { 'nope.test': 'drop' } } })).statusCode).toBe(400);
  });
});

// ---- POP3 catch-all against a tiny fake server ----
describe('catch-all over POP3', () => {
  const server = { msgs: [] as { uidl: string; raw: Buffer }[], dele: [] as number[], port: 0 };
  let listener: net.Server;
  let popAcct: number;
  let destId: number;

  const startServer = async () => {
    listener = net.createServer((sock) => {
      let buf = '', user = '', authed = false;
      const w = (x: string) => sock.write(x + '\r\n');
      sock.on('error', () => {});
      w('+OK fake pop3');
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        let i: number;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          const [cmd, ...args] = line.split(' ');
          switch (cmd.toUpperCase()) {
            case 'USER': user = args[0]; w('+OK'); break;
            case 'PASS': if (user === 'bob' && args.join(' ') === 'secret') { authed = true; w('+OK'); } else w('-ERR bad'); break;
            case 'UIDL': if (!authed) { w('-ERR'); break; } w('+OK'); server.msgs.forEach((m, k) => w(`${k + 1} ${m.uidl}`)); w('.'); break;
            case 'RETR': { const m = server.msgs[Number(args[0]) - 1]; if (!m) { w('-ERR'); break; } w('+OK'); sock.write(m.raw.toString('latin1').split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n') + '\r\n.\r\n'); break; }
            case 'DELE': server.dele.push(Number(args[0])); w('+OK'); break;
            case 'QUIT': w('+OK'); sock.end(); break;
            default: w('-ERR');
          }
        }
      });
    });
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
    server.port = (listener.address() as net.AddressInfo).port;
  };
  afterAll(() => { listener?.close(); });

  async function popSetup(after: string) {
    if (!listener) await startServer();
    server.dele = [];
    popAcct = await insertId(`
      INSERT INTO accounts(user_id, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc,
        smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, created_at, inbound_kind, pop3_host, pop3_port, pop3_secure, pop3_user, pop3_pass_enc)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pop3',?,?,?,?,?)`,
      [TEST_USER, 'Pop catch-all', 'pop@demo.test', '[]', '', 0, true, '', encrypt(''), '', 0, false, '', encrypt(''), Date.now(), '127.0.0.1', server.port, false, 'bob', encrypt('secret')]);
    const res = await app.inject({ method: 'POST', url: '/api/catchall', headers: { cookie }, payload: { accountId: popAcct, domains: ['pop.test'], after } });
    expect(res.statusCode).toBe(200);
    const { syncManager } = await import('../src/imap/sync.ts');
    syncManager.stopAccount(popAcct);
    destId = res.json().destAccountId;
  }

  it('leave (and `move`, which POP3 cannot do): UIDL tracking routes each message once, nothing is deleted', async () => {
    await popSetup('move');
    expect((await app.inject({ method: 'GET', url: '/api/catchall', headers: { cookie } })).json().mailboxes[0].after).toBe('leave');
    await createAddr('p.one@pop.test');
    server.msgs = [{ uidl: 'U1', raw: mail('p.one@pop.test', 'pop one') }, { uidl: 'U2', raw: mail('who@pop.test', 'pop unknown') }];
    expect(await checkNow(popAcct)).toMatchObject({ error: null, routed: 2, finished: 0 });
    expect(await inboxCount(destId)).toBe(1);
    expect(await q('SELECT 1 FROM unknown_addresses')).toHaveLength(1);
    server.msgs.push({ uidl: 'U3', raw: mail('p.one@pop.test', 'pop three') });
    expect(await checkNow(popAcct)).toMatchObject({ routed: 1 });
    expect(await inboxCount(destId)).toBe(2);
    expect(await checkNow(popAcct)).toMatchObject({ routed: 0 });
    expect(server.dele).toEqual([]);
  });

  it('delete: each message is deleted only after it was stored; a crash before DELE keeps it and it is not stored twice', async () => {
    await popSetup('delete');
    await createAddr('p.two@pop.test');
    server.msgs = [{ uidl: 'D1', raw: mail('p.two@pop.test', 'to delete') }];
    hooks.beforeFinish = () => { throw new Error('crash'); };
    expect(await checkNow(popAcct)).toMatchObject({ routed: 1, finished: 0, failed: 1 });
    expect(server.dele).toEqual([]);
    expect(await inboxCount(destId)).toBe(1);
    hooks.beforeFinish = undefined;
    expect(await checkNow(popAcct)).toMatchObject({ routed: 0, finished: 1 });
    expect(server.dele).toEqual([1]);
    expect(await inboxCount(destId)).toBe(1);
  });
});
