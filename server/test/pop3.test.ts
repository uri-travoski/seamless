import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import { resetDb, makeUser, TEST_USER, rawEmail } from './helpers.ts';

const sent: { envelope: any; raw: Buffer }[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { q, one, run, insertId } = await import('../src/db.ts');
const { encrypt } = await import('../src/crypto.ts');
const { pollPop3 } = await import('../src/transport/inbound/pop3.ts');
const { Pop3Client } = await import('../src/transport/inbound/pop3client.ts');
const { ensureLocalMailboxes, nextLocalUid, ingestLocal } = await import('../src/mail/localbox.ts');
const { syncManager } = await import('../src/imap/sync.ts');
const { sendEmail } = await import('../src/mail/send.ts');
const { moveEmail, queryEmails } = await import('../src/mail/store.ts');
const { testPop3Incoming } = await import('../src/mail/connTest.ts');

// ---- fake POP3 server ----
interface Msg { uidl: string; raw: Buffer }
const server = { msgs: [] as Msg[], password: 'secret', dele: [] as number[], port: 0 };
let listener: net.Server;

beforeAll(async () => {
  listener = net.createServer((sock) => {
    let buf = '', user = '', authed = false;
    const w = (s: string) => sock.write(s + '\r\n');
    const stuffed = (b: Buffer) => b.toString('latin1').split('\r\n').map((l) => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
    sock.on('error', () => {}); // probes hang up abruptly
    w('+OK fake pop3 ready');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [cmd, ...args] = line.split(' ');
        switch (cmd.toUpperCase()) {
          case 'USER': user = args[0]; w('+OK'); break;
          case 'PASS': if (user === 'bob' && args.join(' ') === server.password) { authed = true; w('+OK welcome'); } else w('-ERR invalid password'); break;
          case 'STAT': w(`+OK ${server.msgs.length} ${server.msgs.reduce((n, m) => n + m.raw.length, 0)}`); break;
          case 'UIDL': if (!authed) { w('-ERR auth first'); break; } w('+OK'); server.msgs.forEach((m, k) => w(`${k + 1} ${m.uidl}`)); w('.'); break;
          case 'RETR': { const m = server.msgs[Number(args[0]) - 1]; if (!m) { w('-ERR no such message'); break; } w('+OK'); sock.write(stuffed(m.raw) + '\r\n.\r\n'); break; }
          case 'DELE': server.dele.push(Number(args[0])); w('+OK deleted'); break;
          case 'QUIT': w('+OK bye'); sock.end(); break;
          default: w('-ERR unknown');
        }
      }
    });
  });
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
  server.port = (listener.address() as net.AddressInfo).port;
});
afterAll(() => { listener.close(); });

const mail = (n: number) => ({ uidl: `UID-${n}`, raw: rawEmail({ from: 'carol@x.test', to: 'bob@demo.test', subject: `Msg ${n}`, body: n === 1 ? 'line\r\n.dot-start\r\nend' : 'hi' }) });

async function makePop3Account(userId = TEST_USER, over: Record<string, unknown> = {}): Promise<number> {
  const id = await insertId(`
    INSERT INTO accounts(user_id, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc,
      smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, created_at, inbound_kind,
      pop3_host, pop3_port, pop3_secure, pop3_user, pop3_pass_enc, pop3_leave_on_server, pop3_delete_after_days)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [userId, 'Bob', 'bob@demo.test', '[]', '', 0, true, '', encrypt(''), 'smtp.test', 465, true, 'bob', encrypt('pw'), Date.now(), 'pop3',
    '127.0.0.1', server.port, false, 'bob', encrypt((over.pass as string) ?? 'secret'),
    over.leave ?? true, over.days ?? null]);
  await ensureLocalMailboxes(id);
  return id;
}
const count = async (acct: number, role = 'inbox') =>
  Number((await one<{ c: string }>('SELECT COUNT(*) AS c FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id WHERE m.account_id = ? AND b.role = ?', [acct, role]))!.c);

beforeEach(async () => {
  await resetDb(); sent.length = 0;
  server.msgs = [mail(1), mail(2), mail(3)]; server.password = 'secret'; server.dele = [];
});
afterEach(() => { vi.restoreAllMocks(); });

describe('local mailboxes', () => {
  it('creates the standard folders, idempotently, and hands out increasing uids', async () => {
    const acct = await makePop3Account();
    await ensureLocalMailboxes(acct);
    const boxes = await q<any>('SELECT role, path FROM mailboxes WHERE account_id = ? ORDER BY id', [acct]);
    expect(boxes.map((b) => b.role)).toEqual(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive']);
    expect(boxes.every((b) => b.path.startsWith('local:'))).toBe(true);
    const inbox = (await one<any>("SELECT id FROM mailboxes WHERE account_id = ? AND role = 'inbox'", [acct])).id;
    const uids = [await nextLocalUid(inbox), await nextLocalUid(inbox), await nextLocalUid(inbox)];
    expect(uids).toEqual([1, 2, 3]);
  });

  it('moves and flag changes on local messages never queue IMAP ops', async () => {
    const acct = await makePop3Account();
    await ingestLocal(acct, 'inbox', rawEmail({ from: 'a@x.test', to: 'bob@demo.test', subject: 'Hello' }), { isLive: true });
    const row = await one<any>('SELECT id FROM messages WHERE account_id = ?', [acct]);
    await moveEmail(TEST_USER, `m${row.id}`, 'u:trash');
    expect(await count(acct, 'trash')).toBe(1);
    expect(await q('SELECT 1 FROM op_queue')).toHaveLength(0);
  });
});

describe('POP3 client', () => {
  it('dot-unstuffs bodies and reports -ERR clearly', async () => {
    const c = new Pop3Client({ host: '127.0.0.1', port: server.port, secure: false });
    await c.connect();
    await expect(c.auth('bob', 'wrong')).rejects.toThrow(/Sign-in rejected: invalid password/);
    await c.quit();
    const c2 = new Pop3Client({ host: '127.0.0.1', port: server.port, secure: false });
    await c2.connect(); await c2.auth('bob', 'secret');
    expect((await c2.stat()).count).toBe(3);
    expect((await c2.retr(1)).toString()).toContain('\r\n.dot-start\r\n');
    await expect(c2.retr(99)).rejects.toThrow(/no such message/);
    await c2.quit();
  });

  it('connection test reports sign-in failures at the auth step', async () => {
    const ok = await testPop3Incoming({ host: '127.0.0.1', port: server.port, secure: false, user: 'bob', pass: 'secret' });
    expect(ok.ok).toBe(true);
    expect(ok.steps.at(-1)!.detail).toMatch(/3 messages/);
    const bad = await testPop3Incoming({ host: '127.0.0.1', port: server.port, secure: false, user: 'bob', pass: 'nope' });
    expect(bad.ok).toBe(false);
    expect(bad.steps.at(-1)!.step).toBe('auth');
  });
});

describe('F-23 pollPop3', () => {
  it('first poll ingests 3, second 0, a new 4th message → 1; emits newMail', async () => {
    const acct = await makePop3Account();
    const events: any[] = [];
    syncManager.on('newMail', (e) => events.push(e));
    expect((await pollPop3(acct)).fetched).toBe(3);
    expect(await count(acct)).toBe(3);
    expect(events).toHaveLength(3);
    const r2 = await pollPop3(acct);
    expect(r2).toEqual({ fetched: 0, deleted: 0, error: null });
    server.msgs.push(mail(4));
    expect((await pollPop3(acct)).fetched).toBe(1);
    expect(await count(acct)).toBe(4);
    expect(syncManager.status(acct).state).toBe('ok');
    syncManager.removeAllListeners('newMail');
    expect(server.dele).toEqual([]); // leave on server
  });

  it('delete-after-N-days sends DELE only for old, verified messages', async () => {
    const acct = await makePop3Account(TEST_USER, { days: 7 });
    await pollPop3(acct);
    expect(server.dele).toEqual([]); // nothing old yet
    // age UID-1 and UID-2; UID-2's stored message is gone → must not be deleted
    await run("UPDATE pop3_seen SET fetched_at = ? WHERE account_id = ? AND uidl IN ('UID-1','UID-2')", [Date.now() - 8 * 86_400_000, acct]);
    const row2 = (await one<any>("SELECT message_row_id FROM pop3_seen WHERE account_id = ? AND uidl = 'UID-2'", [acct])).message_row_id;
    await run('DELETE FROM messages WHERE id = ?', [row2]);
    const r = await pollPop3(acct);
    expect(r.deleted).toBe(1);
    expect(server.dele).toEqual([1]);
  });

  it('"don\'t leave on server" deletes right after a verified store', async () => {
    const acct = await makePop3Account(TEST_USER, { leave: false });
    const r = await pollPop3(acct);
    expect(r.fetched).toBe(3);
    expect(server.dele).toEqual([1, 2, 3]);
  });

  it('wrong password → error status, no crash, nothing ingested', async () => {
    const acct = await makePop3Account(TEST_USER, { pass: 'bad' });
    const r = await pollPop3(acct);
    expect(r.error).toMatch(/Sign-in rejected/);
    expect(r.fetched).toBe(0);
    const st = syncManager.status(acct);
    expect(st.state).toBe('error');
    expect(st.lastError).toMatch(/invalid password/);
    expect(st.failures).toBe(1);
  });

  it('server down → error status, no crash', async () => {
    const acct = await makePop3Account();
    await run('UPDATE accounts SET pop3_port = 1 WHERE id = ?', [acct]);
    expect((await pollPop3(acct)).error).toBeTruthy();
    expect(syncManager.status(acct).state).toBe('error');
  });

  it('sending from a POP account leaves a local Sent copy and no IMAP op', async () => {
    const acct = await makePop3Account();
    await sendEmail(TEST_USER, {
      accountId: acct, fromEmail: 'bob@demo.test', to: [{ name: '', email: 'carol@x.test' }], cc: [], bcc: [],
      subject: 'Outgoing', html: '<p>yo</p>', attachmentIds: [], track: false,
    } as any);
    expect(sent).toHaveLength(1);
    expect(await count(acct, 'sent')).toBe(1);
    expect(await q('SELECT 1 FROM op_queue')).toHaveLength(0);
  });

  it("another user's POP3 account is invisible to the list API and its mail stays scoped", async () => {
    const other = await makeUser('eve@local');
    const acctA = await makePop3Account(TEST_USER);
    const acctB = await makePop3Account(other);
    await pollPop3(acctA);
    await pollPop3(acctB);
    expect(await q('SELECT 1 FROM messages WHERE user_id = ?', [other])).toHaveLength(3);
    const { makeApp, login } = await import('./app.ts');
    const app = await makeApp();
    const ck = await login(app);
    const list = (await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: ck } })).json();
    expect(list.map((a: any) => a.id)).toEqual([acctA]);
    expect(list[0].pop3Host).toBe('127.0.0.1');
    expect(JSON.stringify(list)).not.toMatch(/pop3Pass|pass_enc/);
    expect((await app.inject({ method: 'POST', url: `/api/accounts/${acctB}/pop3/poll`, headers: { cookie: ck } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/accounts/test/pop3', headers: { cookie: ck }, payload: { accountId: acctB, pop3Host: '127.0.0.1', pop3Port: server.port, pop3User: 'bob' } })).statusCode).toBe(404);
  });

  it('creating a POP3 account through the API makes the local folders', async () => {
    const { makeApp, login } = await import('./app.ts');
    const app = await makeApp();
    const ck = await login(app);
    const res = await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie: ck }, payload: {
      inboundKind: 'pop3', email: 'bob@demo.test', name: 'Bob', pop3Host: '127.0.0.1', pop3Port: server.port, pop3Secure: false,
      pop3User: 'bob', pop3Pass: 'secret', pop3IntervalMin: 10, smtpHost: 'smtp.test', smtpPort: 465, smtpSecure: true, smtpUser: 'bob', smtpPass: 'x',
    } });
    expect(res.statusCode).toBe(200);
    const id = res.json().id;
    expect((await q('SELECT 1 FROM mailboxes WHERE account_id = ?', [id])).length).toBe(6);
    const acct = await one<any>('SELECT inbound_kind, pop3_interval_min, pop3_pass_enc FROM accounts WHERE id = ?', [id]);
    expect(acct.inbound_kind).toBe('pop3');
    expect(acct.pop3_interval_min).toBe(10);
    expect(acct.pop3_pass_enc).not.toContain('secret');
    syncManager.stopAccount(id);
  });
});
