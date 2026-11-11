import type { ParsedMail } from 'mailparser';

export interface AuthResult { result: string; detail: string }
export interface AuthInfo { spf: AuthResult | null; dkim: AuthResult | null; dmarc: AuthResult | null }

/** Pull SPF/DKIM/DMARC verdicts from Authentication-Results + Received-SPF headers. */
export function parseAuth(parsed: ParsedMail): AuthInfo {
  const lines = (parsed.headerLines ?? []).filter(
    (h) => h.key === 'authentication-results' || h.key === 'received-spf',
  );
  const info: AuthInfo = { spf: null, dkim: null, dmarc: null };

  for (const h of lines) {
    const line = h.line.replace(/^[^:]+:\s*/, '');
    if (h.key === 'received-spf' && !info.spf) {
      const m = line.match(/^\s*(pass|fail|softfail|neutral|none|permerror|temperror)/i);
      const ip = line.match(/client-ip=([0-9a-fA-F.:]+)/)?.[1] ?? line.match(/designates\s+([0-9a-fA-F.:]+)/)?.[1];
      if (m) info.spf = { result: m[1].toUpperCase(), detail: ip ? `with IP ${ip}` : '' };
      continue;
    }
    // authentication-results
    const spf = line.match(/spf=(\w+)/i);
    if (spf && !info.spf) {
      const mailfrom = line.match(/smtp\.mailfrom=([^\s;]+)/)?.[1];
      info.spf = { result: spf[1].toUpperCase(), detail: mailfrom ? `with ${mailfrom}` : '' };
    }
    const dkim = line.match(/dkim=(\w+)/i);
    if (dkim && !info.dkim) {
      const domain = line.match(/header\.d=([^\s;]+)/)?.[1] ?? line.match(/header\.i=@?([^\s;>]+)/)?.[1];
      info.dkim = { result: dkim[1].toUpperCase(), detail: domain ? `with domain ${domain}` : '' };
    }
    const dmarc = line.match(/dmarc=(\w+)/i);
    if (dmarc && !info.dmarc) {
      const from = line.match(/header\.from=([^\s;]+)/)?.[1];
      info.dmarc = { result: dmarc[1].toUpperCase(), detail: from ? `(from ${from})` : '' };
    }
  }

  // DKIM fallback: signature present but no verdict header
  if (!info.dkim) {
    const sig = (parsed.headerLines ?? []).find((h) => h.key === 'dkim-signature');
    if (sig) {
      const domain = sig.line.match(/[;\s]d=([^;\s]+)/)?.[1];
      info.dkim = { result: 'SIGNED', detail: domain ? `with domain ${domain}` : '(not verified)' };
    }
  }
  return info;
}

