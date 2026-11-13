/**
 * Original-recipient detection for a catch-all mailbox (T10.1). A provider's catch-all delivers every
 * address of a domain into one mailbox, so the address the sender wrote to is found in the headers.
 * Order: Delivered-To, X-Original-To, Envelope-To, X-Envelope-To, then the To / Cc entries. The first
 * candidate that is a known disposable address or lives on a catch-all domain wins.
 */
export type RecipientSource = 'delivered-to' | 'x-original-to' | 'envelope-to' | 'x-envelope-to' | 'to' | 'cc';

export interface Recipient { address: string; domain: string; source: RecipientSource; known: boolean }

const PRIORITY: { header: string; source: RecipientSource }[] = [
  { header: 'delivered-to', source: 'delivered-to' },
  { header: 'x-original-to', source: 'x-original-to' },
  { header: 'envelope-to', source: 'envelope-to' },
  { header: 'x-envelope-to', source: 'x-envelope-to' },
  { header: 'to', source: 'to' },
  { header: 'cc', source: 'cc' },
];

const EMAIL_RE = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/gi;

/** All values of each header, in order (repeated Delivered-To lines each count), unfolded. Only the header block is read. */
export function headerValues(raw: Buffer | string): Map<string, string[]> {
  const text = typeof raw === 'string' ? raw : raw.subarray(0, 65536).toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  const block = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  const out = new Map<string, string[]>();
  for (const line of block.split(/\r?\n/)) {
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    (out.get(k) ?? out.set(k, []).get(k)!).push(m[2]);
  }
  return out;
}

export function addressesIn(value: string): string[] {
  // drop quoted display names and comments first so "a@b" inside a name is not read as an address
  const v = value.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/\([^)]*\)/g, '');
  return (v.match(EMAIL_RE) ?? []).map((a) => a.toLowerCase());
}

export function detectRecipient(raw: Buffer | string, known: Iterable<string>, domains: Iterable<string>): Recipient | null {
  const knownSet = new Set([...known].map((a) => a.toLowerCase()));
  const domainSet = new Set([...domains].map((d) => d.toLowerCase()));
  const headers = headerValues(raw);
  for (const { header, source } of PRIORITY) {
    for (const value of headers.get(header) ?? []) {
      for (const address of addressesIn(value)) {
        const domain = address.slice(address.lastIndexOf('@') + 1);
        if (knownSet.has(address)) return { address, domain, source, known: true };
        if (domainSet.has(domain)) return { address, domain, source, known: false };
      }
    }
  }
  return null;
}
