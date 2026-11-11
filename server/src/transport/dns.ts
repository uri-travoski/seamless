/** DNS record checker for the sending domain (T3 F-22). The resolver is injectable for tests. */
import { promises as nodeDns } from 'node:dns';

export interface DnsResolver {
  resolveTxt(name: string): Promise<string[][]>;
  resolveCname(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
}

export interface DnsRecordResult {
  id: 'spf' | 'dkim' | 'dmarc' | 'mx' | 'mta-sts' | 'tls-rpt';
  name: string;          // the record name that was looked up
  type: 'TXT' | 'CNAME' | 'MX';
  expected: string;      // what a good record looks like
  found: string[];
  ok: boolean;
  informational: boolean; // true = shown for info, never counts as a problem
  hint?: string;
}

export const SPF_INCLUDE: Record<string, string> = {
  sendgrid: 'sendgrid.net', brevo: 'spf.brevo.com', ses: 'amazonses.com', mailgun: 'mailgun.org', postmark: 'spf.mtasv.net',
};

let defaultResolver: DnsResolver = nodeDns as unknown as DnsResolver;
/** Tests swap the resolver so no real DNS is queried. */
export function setDnsResolver(r: DnsResolver | null): void { defaultResolver = r ?? (nodeDns as unknown as DnsResolver); }

/** Common DKIM selectors per provider, tried when the caller gives none. */
export const DEFAULT_SELECTORS: Record<string, string[]> = {
  sendgrid: ['s1', 's2'], brevo: ['brevo1', 'brevo2'], mailgun: ['smtp', 'k1', 'mx'], postmark: ['20240101pm'], ses: [],
};

async function txt(r: DnsResolver, name: string): Promise<string[]> {
  try { return (await r.resolveTxt(name)).map((chunks) => chunks.join('')); } catch { return []; }
}
async function cname(r: DnsResolver, name: string): Promise<string[]> {
  try { return await r.resolveCname(name); } catch { return []; }
}

export async function checkDomain(
  domain: string,
  opts: { transportKind?: string | null; dkimSelectors?: string[] } = {},
  resolver: DnsResolver = defaultResolver,
): Promise<DnsRecordResult[]> {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  const out: DnsRecordResult[] = [];

  // SPF
  const include = opts.transportKind ? SPF_INCLUDE[opts.transportKind] : undefined;
  const spf = (await txt(resolver, d)).filter((t) => /^v=spf1\b/i.test(t));
  out.push({
    id: 'spf', name: d, type: 'TXT', informational: false, found: spf,
    expected: include ? `v=spf1 include:${include} ~all` : 'v=spf1 … ~all',
    ok: spf.length === 1 && (!include || spf[0].toLowerCase().includes(include)),
    hint: spf.length > 1 ? 'A domain may only have one SPF record — merge them.' : spf.length === 0 ? 'No SPF record found.' : include && !spf[0].toLowerCase().includes(include) ? `Add include:${include}.` : undefined,
  });

  // DKIM (one per selector; providers use CNAME or TXT)
  for (const sel of opts.dkimSelectors ?? []) {
    const name = `${sel}._domainkey.${d}`;
    const c = await cname(resolver, name);
    const t = c.length ? [] : (await txt(resolver, name)).filter((x) => /v=DKIM1|p=/i.test(x));
    out.push({
      id: 'dkim', name, type: c.length || !t.length ? 'CNAME' : 'TXT', informational: false,
      expected: 'CNAME to your provider, or a TXT starting v=DKIM1', found: [...c, ...t], ok: c.length > 0 || t.length > 0,
      hint: c.length || t.length ? undefined : `No DKIM record at ${name}. Copy it from your provider's domain setup page.`,
    });
  }

  // DMARC
  const dmarc = (await txt(resolver, `_dmarc.${d}`)).filter((t) => /^v=DMARC1/i.test(t));
  out.push({
    id: 'dmarc', name: `_dmarc.${d}`, type: 'TXT', informational: false, found: dmarc,
    expected: 'v=DMARC1; p=none; rua=mailto:you@' + d, ok: dmarc.length > 0,
    hint: dmarc.length ? undefined : 'No DMARC record. Start with p=none to watch reports.',
  });

  // informational
  let mx: { exchange: string; priority: number }[] = [];
  try { mx = await resolver.resolveMx(d); } catch { /* none */ }
  out.push({ id: 'mx', name: d, type: 'MX', informational: true, expected: 'Where mail for the domain is delivered', found: mx.sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`), ok: mx.length > 0 });
  const sts = (await txt(resolver, `_mta-sts.${d}`)).filter((t) => /^v=STSv1/i.test(t));
  out.push({ id: 'mta-sts', name: `_mta-sts.${d}`, type: 'TXT', informational: true, expected: 'v=STSv1; id=…', found: sts, ok: sts.length > 0 });
  const tls = (await txt(resolver, `_smtp._tls.${d}`)).filter((t) => /^v=TLSRPTv1/i.test(t));
  out.push({ id: 'tls-rpt', name: `_smtp._tls.${d}`, type: 'TXT', informational: true, expected: 'v=TLSRPTv1; rua=mailto:…', found: tls, ok: tls.length > 0 });
  return out;
}
