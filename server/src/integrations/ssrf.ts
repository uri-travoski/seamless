/**
 * SSRF guard for outgoing webhooks (T5 F-36).
 *
 * Resolve the host ourselves, refuse loopback / private / link-local / ULA / CGNAT / unspecified / multicast
 * addresses unless the host or IP is on the admin allow-list, then connect to the *resolved IP* (Host header and TLS
 * server name stay the original hostname) so a second DNS answer can't swap the target. Redirects are never followed.
 */
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export class SsrfError extends Error { constructor(m?: string) { super(m); this.name = 'SsrfError'; } }

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupFn = (host) => dns.promises.lookup(host, { all: true });
let lookupImpl: LookupFn = defaultLookup;
/** Tests only: fake DNS. Call with no argument to restore. */
export function setLookupForTests(fn?: LookupFn): void { lookupImpl = fn ?? defaultLookup; }

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as [string, number][]) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as [string, number][]) blocked.addSubnet(a, p, 'ipv6');

/** "::ffff:10.0.0.1" → "10.0.0.1" */
function unmap(ip: string): string {
  const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return m ? m[1] : ip;
}

export function isBlockedIp(ip: string): boolean {
  const a = unmap(ip);
  const fam = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null;
  if (!fam) return true;
  return blocked.check(a, fam);
}

/** Does an allow-list entry (host name, IP or CIDR) cover this host / resolved IP? */
export function allowEntryMatches(entry: string, host: string, ip: string): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e === host.toLowerCase()) return true;
  const a = unmap(ip);
  const slash = e.indexOf('/');
  if (slash > 0) {
    const base = e.slice(0, slash), bits = Number(e.slice(slash + 1));
    const fam = net.isIPv4(base) ? 'ipv4' : net.isIPv6(base) ? 'ipv6' : null;
    if (!fam || !Number.isInteger(bits)) return false;
    const afam = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null;
    if (afam !== fam) return false;
    const bl = new net.BlockList();
    try { bl.addSubnet(base, bits, fam); } catch { return false; }
    return bl.check(a, fam);
  }
  return net.isIP(e) !== 0 && unmap(e) === a;
}

/** Valid allow-list entry? (host name, IP, or CIDR) */
export function validAllowEntry(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  if (!e || e.length > 253) return null;
  const slash = e.indexOf('/');
  if (slash > 0) {
    const base = e.slice(0, slash), bits = Number(e.slice(slash + 1));
    if (net.isIPv4(base) && Number.isInteger(bits) && bits >= 0 && bits <= 32) return e;
    if (net.isIPv6(base) && Number.isInteger(bits) && bits >= 0 && bits <= 128) return e;
    return null;
  }
  if (net.isIP(e)) return e;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(e) ? e : null;
}

export interface ResolvedTarget { url: URL; hostname: string; address: string; family: number }

/** Parse, resolve and vet a URL. Throws SsrfError. */
export async function resolveTarget(rawUrl: string, allow: string[] = [], lookup: LookupFn = lookupImpl): Promise<ResolvedTarget> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new SsrfError('invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('only http and https URLs are allowed');
  if (url.username || url.password) throw new SsrfError('credentials in the URL are not allowed');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addrs: { address: string; family: number }[];
  if (net.isIP(hostname)) addrs = [{ address: hostname, family: net.isIPv6(hostname) ? 6 : 4 }];
  else {
    try { addrs = await lookup(hostname); } catch (e: any) { throw new SsrfError(`could not resolve ${hostname}: ${e?.code ?? e?.message ?? e}`); }
  }
  if (!addrs.length) throw new SsrfError(`could not resolve ${hostname}`);
  // every answer must be acceptable, so a mixed public/private answer can't sneak through
  for (const a of addrs) {
    if (isBlockedIp(a.address) && !allow.some((e) => allowEntryMatches(e, hostname, a.address))) {
      throw new SsrfError(`${hostname} resolves to ${a.address}, which is a private or local address (an admin can allow-list it)`);
    }
  }
  const pick = addrs[0];
  return { url, hostname, address: pick.address, family: pick.family === 6 || net.isIPv6(pick.address) ? 6 : 4 };
}

export interface SafeResponse { status: number; text: string; body?: Buffer }

export interface SafeRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  allow?: string[];
  lookup?: LookupFn;
  maxResponseBytes?: number;
}

/** One HTTP(S) request pinned to the vetted IP. No redirects (a 3xx is just returned). */
export async function safeRequest(rawUrl: string, o: SafeRequest = {}): Promise<SafeResponse> {
  const t = await resolveTarget(rawUrl, o.allow ?? [], o.lookup);
  const isHttps = t.url.protocol === 'https:';
  const body = o.body === undefined ? undefined : Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body);
  const headers: Record<string, string | number> = { ...(o.headers ?? {}) };
  if (body) headers['Content-Length'] = body.length;
  const max = o.maxResponseBytes ?? 4096;
  return new Promise<SafeResponse>((resolve, reject) => {
    const mod = isHttps ? https : http;
    const req = mod.request({
      protocol: t.url.protocol, hostname: t.hostname, port: t.url.port || (isHttps ? 443 : 80),
      path: `${t.url.pathname}${t.url.search}`, method: o.method ?? 'POST', headers,
      // pin the connection to the address we vetted; Host header / SNI keep the original name
      lookup: (_h: string, _opts: any, cb: any) => {
        if (_opts && _opts.all) cb(null, [{ address: t.address, family: t.family }]);
        else cb(null, t.address, t.family);
      },
      ...(isHttps ? { servername: net.isIP(t.hostname) ? undefined : t.hostname } : {}),
    } as any, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => { if (n < max) { chunks.push(c); n += c.length; } });
      res.on('end', () => { const b = Buffer.concat(chunks).subarray(0, max); resolve({ status: res.statusCode ?? 0, text: b.toString('utf8'), body: b }); });
      res.on('error', reject);
    });
    req.setTimeout(o.timeoutMs ?? 10_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
