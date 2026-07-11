import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { resetDb, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';

const sendMailMock = vi.fn(async () => ({ messageId: 'ok' }));
vi.mock('../src/mail/send.ts', async (importOriginal) => {
  const mod = await importOriginal<any>();
  return { ...mod, smtpTransport: async () => ({ sendMail: sendMailMock }) };
});

import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import Fastify from 'fastify';
import { q, one, run, insertId } from '../src/db.ts';
import { createAppPassword, facadeLogin } from '../src/facade/auth.ts';
import { startImapFacade } from '../src/facade/imap.ts';
import { startSmtpFacade } from '../src/facade/smtp.ts';
import { registerCardDav } from '../src/facade/carddav.ts';
import { harvestContacts, listContacts, contactToVcf, parseVcf } from '../src/contacts.ts';

const IMAP_PORT = 11430;
const SMTP_PORT = 15870;

let acct: number, inbox: number, trash: number, sent: number, secret = '';
let imapServer: any, smtpServer: any;

beforeAll(async () => {
  await resetDb();
  acct = await makeAccount('alice@demo.test');
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  trash = await makeMailbox(acct, 'Trash', 'trash');
  sent = await makeMailbox(acct, 'Sent', 'sent');
  await insertId("INSERT INTO labels(user_id, name) VALUES (?, 'Receipts')", [TEST_USER]);

  for (let i = 0; i < 3; i++) {
    await ingest(acct, inbox, rawEmail({
      from: `p${i}@x.test`, to: 'alice@demo.test', subject: `Facade ${i}`, body: `body number ${i}`,
      messageId: `<f${i}@x>`, date: new Date(Date.UTC(2026, 5, 1 + i)).toUTCString(),
    }));
  }

  const created = await createAppPassword(TEST_USER, 'Test device', ['imap', 'smtp', 'carddav']);
  secret = created.secret;
  imapServer = startImapFacade(IMAP_PORT);
  smtpServer = startSmtpFacade(SMTP_PORT);
  await new Promise((r) => setTimeout(r, 300));
});

afterAll(async () => {
  imapServer?.close();
  smtpServer?.close();
});

describe('app passwords', () => {
  it('valid secret logs in with the right scope; wrong secret fails', async () => {
    expect(await facadeLogin('test@local', secret, 'imap')).toBeTruthy();
    expect(await facadeLogin('test@local', 'sp-wrong', 'imap')).toBeNull();
    expect(await facadeLogin('nobody@x', secret, 'imap')).toBeNull();
  });
});

describe('IMAP facade (real imapflow client)', () => {
  it('login, list folders, select INBOX, read a message body', async () => {
    const client = new ImapFlow({ host: '127.0.0.1', port: IMAP_PORT, secure: false, logger: false,
      auth: { user: 'test@local', pass: secret } });
    await client.connect();

    const folders = await client.list();
    const names = folders.map((f) => f.path);
    expect(names).toContain('INBOX');
    expect(names).toContain('Trash');
    expect(names).toContain('Labels/Receipts');

    const lock = await client.getMailboxLock('INBOX');
    try {
      expect((client.mailbox as any).exists).toBe(3);
      const msgs: any[] = [];
      for await (const m of client.fetch('1:*', { uid: true, flags: true, envelope: true, source: true })) msgs.push(m);
      expect(msgs.length).toBe(3);
      expect(msgs[0].envelope.subject).toBe('Facade 0');
      expect(Buffer.from(msgs[0].source).toString()).toContain('body number 0');
    } finally { lock.release(); }
    await client.logout().catch(() => {});
  });

  it('flag changes via the facade hit the store', async () => {
    const client = new ImapFlow({ host: '127.0.0.1', port: IMAP_PORT, secure: false, logger: false,
      auth: { user: 'test@local', pass: secret } });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd('1', ['\\Flagged']);
      const row = await one<any>("SELECT flagged FROM messages WHERE subject = 'Facade 0'");
      expect(row.flagged).toBe(true);
    } finally { lock.release(); }
    await client.logout().catch(() => {});
  });

  it('move to Trash via the facade moves the message in the store', async () => {
    const client = new ImapFlow({ host: '127.0.0.1', port: IMAP_PORT, secure: false, logger: false,
      auth: { user: 'test@local', pass: secret } });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const target = await one<any>("SELECT id FROM messages WHERE subject = 'Facade 2'");
      await client.messageMove(String(target.id), 'Trash', { uid: true });
      const row = await one<any>('SELECT mailbox_id FROM messages WHERE id = ?', [target.id]);
      expect(row.mailbox_id).toBe(trash);
    } finally { lock.release(); }
    await client.logout().catch(() => {});
  });

  it('label folders expose labelled mail; COPY adds the label', async () => {
    const client = new ImapFlow({ host: '127.0.0.1', port: IMAP_PORT, secure: false, logger: false,
      auth: { user: 'test@local', pass: secret } });
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageCopy('1', 'Labels/Receipts');
    } finally { lock.release(); }
    lock = await client.getMailboxLock('Labels/Receipts');
    try {
      expect((client.mailbox as any).exists).toBe(1);
    } finally { lock.release(); }
    await client.logout().catch(() => {});
  });
});

describe('SMTP submission facade', () => {
  it('authenticates with the app password and relays via the owning account', async () => {
    const t = nodemailer.createTransport({
      host: '127.0.0.1', port: SMTP_PORT, secure: false,
      auth: { user: 'test@local', pass: secret }, tls: { rejectUnauthorized: false },
    });
    await t.sendMail({
      from: 'alice@demo.test', to: 'bob@x.test',
      subject: 'Sent through facade', text: 'hello from a real client',
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const args = (sendMailMock.mock.calls as any[])[0][0];
    expect(args.envelope.to).toEqual(['bob@x.test']);
    // sent copy queued to the account's Sent folder
    const ops = await q<any>("SELECT payload FROM op_queue WHERE op = 'append'");
    expect(ops.some((o) => JSON.parse(o.payload).targetRole === 'sent')).toBe(true);
  });

  it('rejects a bad app password', async () => {
    const t = nodemailer.createTransport({
      host: '127.0.0.1', port: SMTP_PORT, secure: false,
      auth: { user: 'test@local', pass: 'sp-bad' },
    });
    await expect(t.sendMail({ from: 'a@b.c', to: 'd@e.f', text: 'x' })).rejects.toThrow(/credentials|Invalid/i);
  });
});

describe('contacts + CardDAV', () => {
  it('harvests recipients of sent mail and answered senders', async () => {
    await ingest(acct, sent, rawEmail({
      from: 'alice@demo.test', to: '"Marta Klein" <marta@klein.test>', subject: 'Out', messageId: '<out1@d>',
    }));
    await run("UPDATE messages SET answered = true WHERE subject = 'Facade 0'");
    const scanned = await harvestContacts();
    expect(scanned).toBeGreaterThan(0);
    const contacts = await listContacts(TEST_USER);
    const marta = contacts.find((c) => c.emails?.includes('marta@klein.test'));
    expect(marta).toBeTruthy();
    expect(marta!.display_name).toBe('Marta Klein');
    expect(contacts.some((c) => c.emails?.includes('p0@x.test'))).toBe(true); // replied-to sender
  });

  it('vCard round-trip', async () => {
    const contacts = await listContacts(TEST_USER);
    const vcf = contactToVcf(contacts[0]);
    expect(vcf).toContain('BEGIN:VCARD');
    const parsed = parseVcf(vcf);
    expect(parsed[0].emails[0]).toBe(contacts[0].emails![0]);
  });

  it('CardDAV PROPFIND + REPORT serve the addressbook with Basic auth', async () => {
    const app = Fastify({ logger: false });
    registerCardDav(app);
    await app.ready();
    const basic = 'Basic ' + Buffer.from(`test@local:${secret}`).toString('base64');

    const noAuth = await app.inject({ method: 'PROPFIND' as any, url: '/dav/' });
    expect(noAuth.statusCode).toBe(401);

    const pf = await app.inject({ method: 'PROPFIND' as any, url: `/dav/addressbooks/${TEST_USER}/default/`, headers: { authorization: basic, depth: '1' } });
    expect(pf.statusCode).toBe(207);
    expect(pf.body).toContain('addressbook');
    expect(pf.body).toContain('.vcf');

    const rep = await app.inject({ method: 'REPORT' as any, url: `/dav/addressbooks/${TEST_USER}/default/`, headers: { authorization: basic }, payload: '<x/>' });
    expect(rep.statusCode).toBe(207);
    expect(rep.body).toContain('BEGIN:VCARD');

    const contacts = await listContacts(TEST_USER);
    const get = await app.inject({ method: 'GET', url: `/dav/addressbooks/${TEST_USER}/default/${contacts[0].id}.vcf`, headers: { authorization: basic } });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain('BEGIN:VCARD');
    await app.close();
  });
});
