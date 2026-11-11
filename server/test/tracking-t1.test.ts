import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeAccount, makeMailbox, ingest, TEST_USER } from './helpers.ts';

const sent: { envelope: any; raw: Buffer }[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { sendEmail } = await import('../src/mail/send.ts');
const { recordOpen, classifyOpen, openReport } = await import('../src/mail/tracking.ts');
const { getEmails, queryEmails } = await import('../src/mail/store.ts');
const { q, one, run } = await import('../src/db.ts');
const { resetLimiters } = await import('./app.ts');

function payload(accountId: number, extra: Partial<any> = {}) {
  return {
    accountId, fromEmail: 'alice@demo.test',
    to: [{ name: 'Bob', email: 'bob@x.test' }], cc: [], bcc: [],
    subject: 'Quote for office cleaning', html: '<p>hello</p>', attachmentIds: [], track: true, ...extra,
  };
}

let acct: number, sentBox: number;
/** The raw is quoted-printable: undo soft line breaks before looking for the pixel URL. */
const body = (raw: Buffer) => raw.toString().replace(/=\r?\n/g, '').replace(/=3D/g, '=');

beforeEach(async () => {
  await resetDb(); resetLimiters(); sent.length = 0;
  acct = await makeAccount('alice@demo.test');
  await makeMailbox(acct, 'INBOX', 'inbox');
  sentBox = await makeMailbox(acct, 'Sent', 'sent');
});

/** What sync would do: the Sent copy comes back via IMAP and is ingested. */
async function ingestSentCopy(raw: Buffer) {
  await ingest(acct, sentBox, raw);
  return (await one<{ id: number }>('SELECT id FROM messages WHERE mailbox_id = ? ORDER BY id DESC LIMIT 1', [sentBox]))!.id;
}

describe('F-15 tracking', () => {
  it('toggle off: no pixel, no tracked_sends row', async () => {
    await sendEmail(TEST_USER, payload(acct, { track: false }));
    expect(body(sent[0].raw)).not.toContain('/t/');
    expect(await q('SELECT 1 FROM tracked_sends')).toHaveLength(0);
  });

  it('toggle on: pixel + tracked_sends row', async () => {
    const r = await sendEmail(TEST_USER, payload(acct));
    expect(r.trackingToken).toMatch(/^[a-f0-9]{32}$/);
    expect(body(sent[0].raw)).toContain(`/t/${r.trackingToken}.gif`);
    expect(await one('SELECT 1 FROM tracked_sends WHERE token = ?', [r.trackingToken])).toBeTruthy();
  });

  it('no pixel when every recipient is your own mailbox, or a domain on the no-track list', async () => {
    await sendEmail(TEST_USER, payload(acct, { to: [{ name: '', email: 'ALICE@demo.test' }] }));
    expect(body(sent[0].raw)).not.toContain('/t/');
    await run('UPDATE users SET settings_json = ? WHERE id = ?', [JSON.stringify({ noTrackDomains: ['x.test'] }), TEST_USER]);
    await sendEmail(TEST_USER, payload(acct));
    expect(body(sent[1].raw)).not.toContain('/t/');
  });

  it('GoogleImageProxy hit is stored proxied and left out of real opens', async () => {
    const r = await sendEmail(TEST_USER, payload(acct));
    const id = await ingestSentCopy(sent[0].raw);
    await run('UPDATE tracked_sends SET sent_at = ?', [Date.now() - 60_000]);
    await recordOpen(r.trackingToken!, '66.249.1.1', 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)');
    await recordOpen(r.trackingToken!, '203.0.113.9', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)');
    const o = await one<any>('SELECT proxied, client FROM tracking_opens WHERE ip = ?', ['66.249.1.1']);
    expect(o).toMatchObject({ proxied: true, client: 'Gmail (Google image proxy)' });
    const email = (await getEmails(TEST_USER, [`m${id}`]))[0];
    expect(email.openCount).toBe(1);
    expect(email.autoOpenCount).toBe(1);
  });

  it('an open within 2 s of sending is a scanner', () => {
    expect(classifyOpen('Mozilla/5.0 (Windows NT 10.0) Chrome/120', { sentAt: 1000, now: 2500 }).proxied).toBe(true);
    expect(classifyOpen('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36', { sentAt: 1000, now: 9000 })).toEqual({ client: 'Chrome on Windows', proxied: false });
    expect(classifyOpen('Mozilla/5.0').proxied).toBe(true);
  });

  it('first open creates a notification whose link opens the report, which lists the hit', async () => {
    const r = await sendEmail(TEST_USER, payload(acct));
    const id = await ingestSentCopy(sent[0].raw);
    await run('UPDATE tracked_sends SET sent_at = ?', [Date.now() - 60_000]);
    await recordOpen(r.trackingToken!, '198.51.100.7', 'Mozilla/5.0 (X11; Linux x86_64) Thunderbird/115.0');
    const n = await one<any>("SELECT title, link FROM notifications WHERE type = 'mail.opened'");
    expect(n.title).toBe('Bob opened "Quote for office cleaning"');
    expect(n.link).toBe(`/mail/msg/m${id}/opens`);
    const report = (await openReport(TEST_USER, `m${id}`))!;
    expect(report.summary).toMatchObject({ total: 1, real: 1, uniqueDevices: 1 });
    expect(report.opens[0]).toMatchObject({ client: 'Thunderbird', proxied: false, ip: '198.51.100.7' });
  });

  it('per-recipient tracking sends one copy per recipient and the report names who opened', async () => {
    const r = await sendEmail(TEST_USER, payload(acct, {
      perRecipientTracking: true,
      to: [{ name: 'Bob', email: 'bob@x.test' }], cc: [{ name: 'Cara', email: 'cara@y.test' }],
    }));
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.envelope.to)).toEqual([['bob@x.test'], ['cara@y.test']]);
    const tokens = sent.map((s) => body(s.raw).match(/\/t\/([a-f0-9]{32})\.gif/)![1]);
    expect(new Set(tokens).size).toBe(2);
    // both copies still show the full To/Cc
    for (const s of sent) expect(s.raw.toString()).toMatch(/Cc: Cara <cara@y\.test>/);
    expect((await q('SELECT 1 FROM tracked_sends WHERE group_token = ?', [r.trackingToken])).length).toBe(2);

    // Sent copy comes back via sync carrying the group token
    const { putBlob } = await import('../src/s3.ts');
    const sentKey = (await one<any>("SELECT payload FROM op_queue WHERE op = 'append' ORDER BY id DESC LIMIT 1"))!.payload;
    const raw = (await import('./helpers.ts')).blobStore.get(JSON.parse(sentKey).s3Key)!;
    expect(body(raw)).toContain(`/t/${r.trackingToken}.gif`);
    void putBlob;
    const id = await ingestSentCopy(raw);
    await run('UPDATE tracked_sends SET sent_at = ?', [Date.now() - 60_000]);
    await recordOpen(tokens[1], '192.0.2.1', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148');
    const report = (await openReport(TEST_USER, `m${id}`))!;
    expect(report.perRecipient).toBe(true);
    expect(report.opens[0]).toMatchObject({ recipient: 'Cara <cara@y.test>', client: 'Apple Mail (iOS)' });
    expect((await getEmails(TEST_USER, [`m${id}`]))[0].openCount).toBe(1);
    const n = await one<any>("SELECT title FROM notifications WHERE type = 'mail.opened'");
    expect(n.title).toBe('Cara opened "Quote for office cleaning"');
    // Bob opening his own copy is a separate notification, not a bump on Cara's
    await recordOpen(tokens[0], '192.0.2.2', 'Mozilla/5.0 (X11; Linux x86_64) Thunderbird/115.0');
    const titles = (await q<any>("SELECT title, count FROM notifications WHERE type = 'mail.opened' ORDER BY id")).map((x: any) => `${x.title}|${x.count}`);
    expect(titles).toEqual(['Cara opened "Quote for office cleaning"|1', 'Bob opened "Quote for office cleaning"|1']);
    void queryEmails;
  });

  it('drafts remember the tracking toggle', async () => {
    const { saveDraft } = await import('../src/mail/send.ts');
    await saveDraft(TEST_USER, payload(acct, { track: false }));
    const op = await one<any>("SELECT payload FROM op_queue WHERE op = 'append' ORDER BY id DESC LIMIT 1");
    const raw = (await import('./helpers.ts')).blobStore.get(JSON.parse(op.payload).s3Key)!.toString();
    expect(raw).toContain('X-Seamless-Track: 0');
    expect(raw).not.toContain('/t/');
  });
});
