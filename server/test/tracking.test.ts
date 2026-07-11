import { describe, it, expect } from 'vitest';
import { resetDb, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { insertTrackingPixel, htmlToPlain } from '../src/mail/send.ts';
import { extractTrackingToken } from '../src/mail/ingest.ts';
import { sanitizeEmailHtml } from '../src/mail/body.ts';
import { config } from '../src/config.ts';
import { run } from '../src/db.ts';
import { getEmails, queryEmails } from '../src/mail/store.ts';

const TOKEN = 'a'.repeat(32);

describe('tracking pixel', () => {
  it('inserts pixel before </body> or appends', () => {
    const withBody = insertTrackingPixel('<html><body><p>hi</p></body></html>', TOKEN);
    expect(withBody).toContain(`${config.publicUrl}/t/${TOKEN}.gif`);
    expect(withBody.indexOf('img')).toBeLessThan(withBody.indexOf('</body>'));
    const noBody = insertTrackingPixel('<p>hi</p>', TOKEN);
    expect(noBody.endsWith('>')).toBe(true);
    expect(noBody).toContain(`/t/${TOKEN}.gif`);
  });

  it('extractTrackingToken finds our pixel in raw mail', () => {
    const html = insertTrackingPixel('<p>hello</p>', TOKEN);
    expect(extractTrackingToken(html)).toBe(TOKEN);
    expect(extractTrackingToken('<p>no pixel</p>')).toBe(null);
  });

  it('finds the token even when quoted-printable soft-wraps the pixel URL', () => {
    const url = `${config.publicUrl}/t/${TOKEN}.gif`;
    const split = url.indexOf('/t/') + 8;
    const wrapped = `<img src="${url.slice(0, split)}=\r\n${url.slice(split)}" width="1">`;
    expect(extractTrackingToken(wrapped)).toBe(TOKEN);
  });

  it('sent copy ingest picks up the token and counts opens', async () => {
    await resetDb();
    const userId = TEST_USER;
    const acct = await makeAccount('alice@demo.test');
    const sent = await makeMailbox(acct, 'Sent', 'sent');
    const html = insertTrackingPixel('<p>tracked</p>', TOKEN);
    await ingest(acct, sent, rawEmail({
      from: 'alice@demo.test', to: 'bob@x.test', subject: 'Tracked', html, messageId: '<tr1@demo>',
    }));
    const res = await queryEmails(userId, { filter: { inMailbox: 'u:sent' }, position: 0, limit: 10 });
    let email = (await getEmails(userId, [res.ids[0]]))[0];
    expect(email.openCount).toBe(0); // tracked, zero opens

    await run('INSERT INTO tracking_opens(token, ts, ip, ua) VALUES (?,?,?,?)', [TOKEN, Date.now(), '1.2.3.4', 'TestUA']);
    await run('INSERT INTO tracking_opens(token, ts, ip, ua) VALUES (?,?,?,?)', [TOKEN, Date.now() + 1000, '1.2.3.4', 'TestUA']);
    email = (await getEmails(userId, [res.ids[0]]))[0];
    expect(email.openCount).toBe(2);
    expect(email.lastOpenAt).toBeTruthy();
  });
});

describe('html sanitization', () => {
  it('strips scripts and our own pixel, blocks remote images', () => {
    const html = `<p onclick="x()">hi</p><script>evil()</script>` +
      `<img src="${config.publicUrl}/t/${TOKEN}.gif" width="1">` +
      `<img src="https://remote.test/banner.jpg">`;
    const out = sanitizeEmailHtml(html, { rowId: 1, cids: new Map(), allowRemote: false, trackingToken: TOKEN });
    expect(out.html).not.toContain('script');
    expect(out.html).not.toContain('onclick');
    expect(out.html).not.toContain(`/t/${TOKEN}.gif`);
    expect(out.html).toContain('data-md-src="https://remote.test/banner.jpg"');
    expect(out.hasBlockedRemote).toBe(true);
  });

  it('allows remote images when requested and rewrites cid refs', () => {
    const html = `<img src="https://remote.test/a.png"><img src="cid:part1@x">`;
    const out = sanitizeEmailHtml(html, {
      rowId: 42, cids: new Map([['part1@x', '0']]), allowRemote: true, trackingToken: null,
    });
    expect(out.html).toContain('src="https://remote.test/a.png"');
    expect(out.html).toContain('src="/api/blob/m42/0"');
    expect(out.hasBlockedRemote).toBe(false);
  });

  it('forces safe link targets', () => {
    const out = sanitizeEmailHtml('<a href="https://x.test">x</a>', { rowId: 1, cids: new Map(), allowRemote: true, trackingToken: null });
    expect(out.html).toContain('rel="noopener noreferrer"');
    expect(out.html).toContain('target="_blank"');
  });
});

describe('htmlToPlain', () => {
  it('converts basic html to readable text', () => {
    expect(htmlToPlain('<p>Hello <b>world</b></p><p>Second&nbsp;line</p>')).toBe('Hello world\nSecond line');
  });
});
