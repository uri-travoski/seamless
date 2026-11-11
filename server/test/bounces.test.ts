import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, rawEmail, ingest, TEST_USER } from './helpers.ts';

const { q, one } = await import('../src/db.ts');
const { checkDomain, setDnsResolver } = await import('../src/transport/dns.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

const ORIG = '<orig-1@seamless.test>';
let acct: number, inbox: number, sent: number, sentRow: number;

const SENT = () => rawEmail({ from: 'alice@demo.test', to: 'ghost@x.test', subject: 'Hello ghost', messageId: ORIG });

function dsn(kind: 'rfc3464' | 'postfix' | 'gmail' | 'plain', id = ORIG, action = 'failed'): Buffer {
  const origHeaders = `From: alice@demo.test\r\nTo: ghost@x.test\r\nSubject: Hello ghost\r\nMessage-ID: ${id}\r\n`;
  const head = (subject: string, from: string) => `From: ${from}\r\nTo: alice@demo.test\r\nSubject: ${subject}\r\nDate: Wed, 08 Jul 2026 10:05:00 +0000\r\nMessage-ID: <dsn-${kind}-${action}@x.test>\r\nIn-Reply-To: ${id}\r\nMIME-Version: 1.0\r\n`;
  if (kind === 'rfc3464') {
    return Buffer.from(head('Delivery Status Notification (Failure)', 'MAILER-DAEMON@x.test') +
      `Content-Type: multipart/report; report-type=delivery-status; boundary="B"\r\n\r\n--B\r\nContent-Type: text/plain\r\n\r\nYour message could not be delivered.\r\n` +
      `--B\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; x.test\r\n\r\nFinal-Recipient: rfc822; ghost@x.test\r\nAction: ${action}\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 5.1.1 User unknown\r\n\r\n` +
      `--B\r\nContent-Type: message/rfc822\r\n\r\n${origHeaders}\r\nbody\r\n--B--\r\n`);
  }
  if (kind === 'postfix') {
    return Buffer.from(head('Undelivered Mail Returned to Sender', 'MAILER-DAEMON@mail.x.test (Mail Delivery System)') +
      `Content-Type: multipart/report; report-type=delivery-status; boundary="P"\r\n\r\n--P\r\nContent-Type: text/plain; charset=us-ascii\r\n\r\nThis is the mail system at host mail.x.test.\r\n<ghost@x.test>: host mx.x.test said: 550 5.1.1 <ghost@x.test>: Recipient address rejected: User unknown\r\n` +
      `--P\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; mail.x.test\r\n\r\nOriginal-Recipient: rfc822;ghost@x.test\r\nFinal-Recipient: rfc822;ghost@x.test\r\nAction: failed\r\nStatus: 5.1.1\r\nRemote-MTA: dns; mx.x.test\r\nDiagnostic-Code: smtp; 550 5.1.1 <ghost@x.test>: Recipient address rejected:\r\n    User unknown\r\n\r\n` +
      `--P\r\nContent-Type: text/rfc822-headers\r\n\r\n${origHeaders}\r\n--P--\r\n`);
  }
  if (kind === 'gmail') {
    // Gmail style: non-standard multipart/mixed, original attached as message/rfc822, no delivery-status part
    return Buffer.from(head('Delivery Status Notification (Failure)', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>') +
      `Content-Type: multipart/mixed; boundary="G"\r\n\r\n--G\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n** Address not found **\r\n\r\nYour message wasn't delivered to ghost@x.test because the address couldn't be found.\r\n\r\nThe response was:\r\n550 5.1.1 The email account that you tried to reach does not exist.\r\n` +
      `--G\r\nContent-Type: message/rfc822\r\n\r\n${origHeaders}\r\nbody\r\n--G--\r\n`);
  }
  return Buffer.from(rawEmail({ from: 'Bob <bob@x.test>', to: 'alice@demo.test', subject: 'Undelivered Mail Returned to Sender', body: 'lunch?' }));
}

beforeEach(async () => {
  await resetDb();
  acct = await makeAccount('alice@demo.test');
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  sent = await makeMailbox(acct, 'Sent', 'sent');
  sentRow = (await ingest(acct, sent, SENT()))!.rowId;
});

describe('F-22 bounces', () => {
  for (const kind of ['rfc3464', 'postfix', 'gmail'] as const) {
    it(`${kind} bounce links to the sent message and raises one event`, async () => {
      await ingest(acct, inbox, dsn(kind), { isLive: true });
      const rows = await q<any>('SELECT * FROM bounces');
      expect(rows).toHaveLength(1);
      expect(rows[0].message_id).toBe(sentRow);
      expect(rows[0].recipient).toBe('ghost@x.test');
      expect(rows[0].status).toMatch(/^5\.1\.1/);
      expect(rows[0].diagnostic).toMatch(/unknown|does not exist/i);
      expect(await q("SELECT 1 FROM events WHERE type = 'mail.bounced'")).toHaveLength(1);
      expect(await q("SELECT 1 FROM notifications WHERE user_id = ?", [TEST_USER])).toHaveLength(1);
      const { rowToApi, getMessageRow } = await import('../src/mail/store.ts') as any;
      void getMessageRow;
      const row = await one<any>(`SELECT m.*, a.email AS account_email, a.color AS account_color, mb.role AS mailbox_role FROM messages m JOIN accounts a ON a.id=m.account_id JOIN mailboxes mb ON mb.id=m.mailbox_id WHERE m.id = ?`, [sentRow]);
      const api = await rowToApi(row);
      expect(api.bounced).toEqual([expect.objectContaining({ recipient: 'ghost@x.test' })]);
    });
  }

  it('a delayed (not failed) report and ordinary mail are ignored', async () => {
    await ingest(acct, inbox, dsn('rfc3464', ORIG, 'delayed'), { isLive: true });
    await ingest(acct, inbox, dsn('plain'), { isLive: true });
    expect(await q('SELECT 1 FROM bounces')).toHaveLength(0);
    expect(await q("SELECT 1 FROM events WHERE type = 'mail.bounced'")).toHaveLength(0);
  });

  it('a bounce for an unknown original, or from backfill, records nothing', async () => {
    await ingest(acct, inbox, dsn('rfc3464', '<nobody@x>'), { isLive: true });
    await ingest(acct, inbox, dsn('postfix'), { isLive: false });
    expect(await q('SELECT 1 FROM bounces')).toHaveLength(0);
  });

  it("user B's bounce never attaches to user A's sent mail", async () => {
    const b = await makeUser('b@demo.test');
    const acctB = await makeAccount('bob@demo.test', { userId: b });
    const inboxB = await makeMailbox(acctB, 'INBOX', 'inbox');
    await ingest(acctB, inboxB, dsn('rfc3464'), { isLive: true });
    expect(await q('SELECT 1 FROM bounces')).toHaveLength(0);
    // and the API for A's message doesn't leak to B's rows
    await ingest(acct, inbox, dsn('rfc3464'), { isLive: true });
    expect(await q('SELECT 1 FROM bounces WHERE user_id = ?', [b])).toHaveLength(0);
    expect(await q('SELECT 1 FROM notifications WHERE user_id = ?', [b])).toHaveLength(0);
  });
});

describe('F-22 DNS helper', () => {
  const zone: Record<string, string[][]> = {
    'good.test': [['v=spf1 include:sendgrid.net ~all']],
    '_dmarc.good.test': [['v=DMARC1; p=none']],
    '_mta-sts.good.test': [['v=STSv1; id=1']],
    'bad.test': [['v=spf1 include:other.net ~all']],
    'dupe.test': [['v=spf1 -all'], ['v=spf1 +all']],
  };
  const resolver = {
    resolveTxt: async (n: string) => { if (!zone[n]) throw new Error('ENODATA'); return zone[n]; },
    resolveCname: async (n: string) => { if (n === 's1._domainkey.good.test') return ['s1.domainkey.u1.wl.sendgrid.net']; throw new Error('ENODATA'); },
    resolveMx: async (n: string) => { if (n === 'good.test') return [{ exchange: 'mx.good.test', priority: 10 }]; throw new Error('ENODATA'); },
  };
  const by = (r: any[], id: string, name?: string) => r.find((x) => x.id === id && (!name || x.name === name))!;

  it('passes a correctly configured domain', async () => {
    const r = await checkDomain('good.test', { transportKind: 'sendgrid', dkimSelectors: ['s1'] }, resolver);
    expect(by(r, 'spf').ok).toBe(true);
    expect(by(r, 'dkim').ok).toBe(true);
    expect(by(r, 'dmarc').ok).toBe(true);
    expect(by(r, 'mx').ok).toBe(true);
    expect(by(r, 'mta-sts').ok).toBe(true);
    expect(by(r, 'tls-rpt').ok).toBe(false);
    expect(r.filter((x) => x.informational).map((x) => x.id)).toEqual(['mx', 'mta-sts', 'tls-rpt']);
  });

  it('fails each missing or wrong record', async () => {
    const r = await checkDomain('bad.test', { transportKind: 'sendgrid', dkimSelectors: ['s1'] }, resolver);
    expect(by(r, 'spf').ok).toBe(false);
    expect(by(r, 'spf').hint).toContain('sendgrid.net');
    expect(by(r, 'dkim').ok).toBe(false);
    expect(by(r, 'dmarc').ok).toBe(false);
    const dupe = await checkDomain('dupe.test', {}, resolver);
    expect(by(dupe, 'spf').ok).toBe(false);
  });

  describe('route', () => {
    it('validates the domain, scopes the transport, and uses the resolver', async () => {
      resetLimiters();
      setDnsResolver(resolver);
      try {
        const app = await makeApp(); const cookie = await login(app);
        const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
        expect((await get('/api/dns-check?domain=not a domain')).statusCode).toBe(400);
        const ok = await get('/api/dns-check?domain=good.test');
        expect(ok.statusCode).toBe(200);
        expect(ok.json().records.find((x: any) => x.id === 'dmarc').ok).toBe(true);
        // a transport that belongs to someone else is a 404
        const other = await makeUser('c@demo.test');
        const { insertId } = await import('../src/db.ts');
        const tid = await insertId('INSERT INTO transports(user_id, kind, name, config_enc, created_at) VALUES (?,?,?,?,?)', [other, 'sendgrid', 'x', 'x', Date.now()]);
        expect((await get(`/api/dns-check?domain=good.test&transportId=${tid}`)).statusCode).toBe(404);
        expect((await app.inject({ method: 'GET', url: '/api/dns-check?domain=good.test' })).statusCode).toBe(401);
      } finally { setDnsResolver(null); }
    });
  });
});
