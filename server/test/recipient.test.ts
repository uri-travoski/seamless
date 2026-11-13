import { describe, it, expect } from 'vitest';
import { detectRecipient, headerValues, addressesIn } from '../src/mail/recipient.ts';

const known = ['shop.k7f2q9@bin.test'];
const domains = ['bin.test', 'burn.test'];
const msg = (headers: string[]) => Buffer.from(headers.join('\r\n') + '\r\n\r\nbody Delivered-To: nope@bin.test\r\n');

describe('detectRecipient', () => {
  it('prefers Delivered-To over To', () => {
    const r = detectRecipient(msg(['Delivered-To: shop.k7f2q9@bin.test', 'To: other@bin.test', 'Subject: x']), known, domains);
    expect(r).toMatchObject({ address: 'shop.k7f2q9@bin.test', source: 'delivered-to', known: true });
  });
  it('header priority: Delivered-To, X-Original-To, Envelope-To, X-Envelope-To, To, Cc', () => {
    const order = ['Cc: c@bin.test', 'To: t@bin.test', 'X-Envelope-To: xe@bin.test', 'Envelope-To: e@bin.test', 'X-Original-To: xo@bin.test', 'Delivered-To: d@bin.test'];
    const sources: string[] = [];
    let h = [...order];
    while (h.length) { sources.push(detectRecipient(msg(h), [], domains)!.source); h = h.slice(0, -1); }
    expect(sources).toEqual(['delivered-to', 'x-original-to', 'envelope-to', 'x-envelope-to', 'to', 'cc']);
  });
  it('skips Delivered-To on a domain that is not a catch-all domain (forwarded mail)', () => {
    const r = detectRecipient(msg(['Delivered-To: me@gmail.test', 'X-Original-To: forwarded.abc@burn.test', 'To: me@gmail.test']), [], domains);
    expect(r).toMatchObject({ address: 'forwarded.abc@burn.test', source: 'x-original-to', known: false });
  });
  it('Bcc: no To match, the envelope header still names the address', () => {
    const r = detectRecipient(msg(['To: undisclosed-recipients:;', 'X-Envelope-To: secret@bin.test', 'Subject: s']), [], domains);
    expect(r).toMatchObject({ address: 'secret@bin.test', source: 'x-envelope-to' });
  });
  it('mailing-list mail: To is the list, Delivered-To is ours', () => {
    const r = detectRecipient(msg(['To: list@lists.example.org', 'List-Id: <list.example.org>', 'Delivered-To: sub.q1@burn.test']), [], domains);
    expect(r).toMatchObject({ address: 'sub.q1@burn.test', source: 'delivered-to' });
  });
  it('multiple recipients: the first one on a catch-all domain wins, a known address is found anywhere', () => {
    const r = detectRecipient(msg(['To: a@elsewhere.test, "Me" <b@bin.test>, shop.k7f2q9@bin.test']), known, domains);
    expect(r).toMatchObject({ address: 'b@bin.test' });
    expect(detectRecipient(msg(['To: a@elsewhere.test, shop.k7f2q9@bin.test']), known, domains)?.known).toBe(true);
  });
  it('repeated Delivered-To lines are all considered', () => {
    const r = detectRecipient(msg(['Delivered-To: me@gmail.test', 'Delivered-To: x@bin.test']), [], domains);
    expect(r?.address).toBe('x@bin.test');
  });
  it('missing headers / no match → null; the body is never read; case and folding are handled', () => {
    expect(detectRecipient(msg(['Subject: hello']), known, domains)).toBeNull();
    expect(detectRecipient(msg(['To: someone@else.test']), known, domains)).toBeNull();
    expect(detectRecipient(msg(['To: "Fold" <Mixed.Case@BIN.test>,', '   other@else.test']), [], domains)?.address).toBe('mixed.case@bin.test');
  });
  it('helpers: display names and comments are not addresses', () => {
    expect(addressesIn('"a@b.test" <real@bin.test> (c@d.test)')).toEqual(['real@bin.test']);
    expect(headerValues('A: 1\r\n  two\r\nB: 3\r\n\r\nC: no').get('a')).toEqual(['1 two']);
  });
});
