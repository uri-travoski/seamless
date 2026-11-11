/**
 * Phishing and lookalike warnings (T2 F-20).
 * `assessRisk` is pure (no DB) so every rule can be unit-tested; `assessAndStore` gathers the inputs
 * from the database at ingest time. It must never break ingest — callers wrap it in try/catch.
 */
import { domainToUnicode } from 'node:url';
import type { ParsedMail } from 'mailparser';
import { q, one, run } from '../db.ts';
import { parseAuth } from './auth.ts';   // not original.ts: that imports the store and would make an import cycle

export interface RiskInput {
  fromAddr: string; fromName: string; replyTo: string[];
  auth: { spf?: string; dkim?: string; dmarc?: string };
  subject: string; text: string; html: string | null;
  attachments: { filename: string; contentType: string }[];
  ownDomains: string[];
  contactDomains: string[];
  knownContactNames: Map<string, string[]>;
  firstTimeSender: boolean;
  knownContact: boolean;          // the exact address is someone you have written to / heard from
  trusted: boolean;               // address or domain in trusted_senders → skip everything
  arcPass?: boolean;              // a known forwarder's ARC chain vouches for the original (F-29)
}
export interface RiskReason { code: string; severity: 'medium' | 'high'; text: string }
export type RiskLevel = 'none' | 'medium' | 'high';

// ---------- ARC (F-29) ----------

export const ARC_FORWARDERS = ['google.com', 'cloudflare.net', 'outlook.com', 'icloud.com', 'fastmail.com'];

/**
 * True when the message carries an ARC chain sealed by a known forwarder (or one of the user's own
 * push domains) whose ARC-Authentication-Results show dmarc=pass or spf=pass.
 * `headers` are raw header lines ("Name: value"), as in mailparser's `headerLines[].line`.
 */
export function arcVouches(headers: string[], extraDomains: string[] = []): boolean {
  const trusted = [...ARC_FORWARDERS, ...extraDomains.map((d) => d.toLowerCase())];
  const unfold = (l: string) => l.replace(/\r?\n[ \t]+/g, ' ');
  const seals = new Map<number, string>();   // instance -> d=
  const results = new Map<number, string>(); // instance -> ARC-Authentication-Results value
  for (const raw of headers) {
    const line = unfold(raw);
    const name = line.slice(0, line.indexOf(':')).trim().toLowerCase();
    const value = line.slice(line.indexOf(':') + 1);
    const inst = Number(value.match(/\bi\s*=\s*(\d+)/)?.[1]);
    if (!inst) continue;
    if (name === 'arc-seal') { const d = value.match(/\bd\s*=\s*([^\s;]+)/)?.[1]; if (d) seals.set(inst, d.toLowerCase()); }
    else if (name === 'arc-authentication-results') results.set(inst, value);
  }
  for (const [inst, d] of seals) {
    const ok = trusted.some((t) => d === t || d.endsWith('.' + t));
    const res = results.get(inst);
    if (ok && res && /\b(dmarc|spf)\s*=\s*pass\b/i.test(res)) return true;
  }
  return false;
}

// ---------- domain helpers ----------

const SECOND_LEVEL = new Set(['com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.uk', 'org.uk', 'ac.uk', 'co.nz', 'org.nz', 'co.jp', 'com.br', 'co.za']);
const ESP = /(mailchimp|sendgrid|mcsv|hubspot|amazonses|mailgun|sparkpost|brevo|sendinblue|zendesk|freshdesk|intercom)\./i;

export const domainOf = (addr: string): string => (addr.split('@')[1] ?? '').trim().toLowerCase();

/** example.com.au for mail.example.com.au */
export function registrable(domain: string): string {
  const parts = domain.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return SECOND_LEVEL.has(last2) ? parts.slice(-3).join('.') : last2;
}

const CONFUSABLE: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's',
  '0': 'o', '1': 'l', '3': 'e', '5': 's',
};

/** What a domain "looks like": punycode decoded, confusable letters/digits folded, hyphens dropped. */
export function skeleton(domain: string): string {
  const uni = (domainToUnicode(domain.toLowerCase()) || domain).normalize('NFKC').toLowerCase();
  return [...uni].map((ch) => CONFUSABLE[ch] ?? ch).join('').replace(/-/g, '');
}

/** Damerau–Levenshtein (optimal string alignment) distance. */
export function damerau(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// ---------- rules ----------

type Rule = (i: RiskInput) => RiskReason | null;

const MONEY = /\b(invoice|payment|bank|urgent|wire|transfer|overdue)\b/i;
const BANK_CHANGE = /\b(BSB|account number|new bank (details|account)|change(d)? (of )?bank)\b/i;
const BAD_EXT = /\.(exe|js|vbs|scr|iso|html|htm|bat|cmd|jar|lnk)$/i;
const MACRO_EXT = /\.(docm|xlsm|pptm)$/i;
const ARCHIVE_EXT = /\.(zip|7z|rar)$/i;

const authFail: Rule = (i) => {
  const { spf, dkim, dmarc } = i.auth;
  if (i.arcPass) return null;
  if (dmarc === 'fail' || (spf === 'fail' && dkim === 'fail')) {
    return { code: 'auth_fail', severity: 'high', text: 'This message failed the sender checks (SPF/DKIM/DMARC), so it may not really come from who it says.' };
  }
  return null;
};

const displaySpoof: Rule = (i) => {
  const fromReg = registrable(domainOf(i.fromAddr));
  const named = i.fromName.match(/[\w.-]+\.[a-z]{2,}/i);
  if (named && registrable(named[0].toLowerCase()) !== fromReg) {
    return { code: 'display_spoof', severity: 'high', text: `The sender’s display name mentions ${named[0]}, but the message actually comes from ${domainOf(i.fromAddr)}.` };
  }
  const known = i.knownContactNames.get(i.fromName.trim().toLowerCase());
  if (known && known.length && !known.includes(i.fromAddr.toLowerCase())) {
    return { code: 'display_spoof', severity: 'high', text: `The name “${i.fromName.trim()}” matches one of your contacts, but this is a different address (${i.fromAddr}).` };
  }
  return null;
};

const lookalike: Rule = (i) => {
  const from = registrable(domainOf(i.fromAddr));
  if (from.length < 5) return null;
  const known = new Set([...i.ownDomains, ...i.contactDomains].map(registrable));
  if (known.has(from)) return null;                     // you already deal with this exact domain
  for (const x of known) {
    if (x.length < 5) continue;
    if (damerau(from, x) <= 2 || skeleton(from) === skeleton(x)) {
      return { code: 'lookalike', severity: 'high', text: `The sender’s domain ${from} looks very like ${x}, which you know — it may be an imitation.` };
    }
  }
  return null;
};

const firstTimeMoney: Rule = (i) =>
  i.firstTimeSender && MONEY.test(`${i.subject}\n${i.text}`)
    ? { code: 'first_time_money', severity: 'medium', text: 'This is the first message from this sender and it talks about money or payment.' } : null;

const replyToMismatch: Rule = (i) => {
  const fromDomain = domainOf(i.fromAddr);
  for (const r of i.replyTo) {
    const rd = domainOf(r);
    if (!rd || registrable(rd) === registrable(fromDomain)) continue;
    if (ESP.test(rd + '.') || ESP.test(fromDomain + '.')) continue;
    return { code: 'reply_to_mismatch', severity: 'medium', text: `Replies would go to ${rd}, not to ${fromDomain}.` };
  }
  return null;
};

const bankChange: Rule = (i) =>
  !i.knownContact && BANK_CHANGE.test(`${i.subject}\n${i.text}`)
    ? { code: 'bank_change', severity: 'high', text: 'This asks about bank or account details and is not from someone you know. This is a common scam.' } : null;

const badAttachment: Rule = (i) => {
  for (const a of i.attachments) {
    const name = a.filename ?? '';
    if (BAD_EXT.test(name)) return { code: 'bad_attachment', severity: 'medium', text: `The attachment “${name}” is a file type that can run programs.` };
    if (MACRO_EXT.test(name)) return { code: 'bad_attachment', severity: 'medium', text: `The attachment “${name}” can contain macros.` };
    if (ARCHIVE_EXT.test(name) && /password/i.test(i.text)) return { code: 'bad_attachment', severity: 'medium', text: `“${name}” is an archive and the message mentions a password — a way to hide a virus from scanners.` };
  }
  return null;
};

const linkMismatch: Rule = (i) => {
  if (!i.html) return null;
  const fromReg = registrable(domainOf(i.fromAddr));
  const re = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(i.html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (!/^(https?:\/\/)?[\w-]+(\.[\w-]+)*\.[a-z]{2,}(\/\S*)?$/i.test(text)) continue;
    let hrefHost = '';
    try { hrefHost = new URL(m[1]).hostname.toLowerCase(); } catch { continue; }
    const textHost = text.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    const a = registrable(textHost), b = registrable(hrefHost);
    if (a === b || b === fromReg || ESP.test(hrefHost + '.')) continue;
    return { code: 'link_mismatch', severity: 'medium', text: `A link reads “${text}” but goes to ${hrefHost}.` };
  }
  return null;
};

const RULES: Rule[] = [authFail, displaySpoof, lookalike, firstTimeMoney, replyToMismatch, bankChange, badAttachment, linkMismatch];

export function assessRisk(i: RiskInput): { score: number; level: RiskLevel; reasons: RiskReason[] } {
  if (i.trusted) return { score: 0, level: 'none', reasons: [] };
  const reasons = RULES.map((r) => r(i)).filter((r): r is RiskReason => !!r);
  const score = Math.min(100, reasons.reduce((n, r) => n + (r.severity === 'high' ? 60 : 25), 0));
  const level: RiskLevel = reasons.some((r) => r.severity === 'high') ? 'high' : score >= 25 ? 'medium' : 'none';
  return { score, level, reasons };
}

// ---------- storage ----------

export async function isTrusted(userId: number, addr: string): Promise<boolean> {
  const a = addr.toLowerCase();
  return !!(await one(`SELECT 1 FROM trusted_senders WHERE user_id = ? AND ((kind = 'address' AND value = ?) OR (kind = 'domain' AND value = ?))`, [userId, a, domainOf(a)]));
}

export async function assessAndStore(userId: number, rowId: number, parsed: ParsedMail, mailboxRole: string | null): Promise<void> {
  if (mailboxRole && ['sent', 'drafts', 'scheduled'].includes(mailboxRole)) return;
  const fromObj = (Array.isArray(parsed.from) ? parsed.from[0] : parsed.from)?.value?.[0];
  const fromAddr = (fromObj?.address ?? '').toLowerCase();
  if (!fromAddr) return;

  const accounts = await q<{ email: string; aliases: string }>('SELECT email, aliases FROM accounts WHERE user_id = ?', [userId]);
  const own = new Set<string>();
  for (const a of accounts) { own.add(domainOf(a.email)); for (const al of JSON.parse(a.aliases || '[]') as string[]) own.add(domainOf(al)); }

  const contacts = await q<{ display_name: string; email: string; sent_count: number }>(
    `SELECT c.display_name, ce.email, c.sent_count FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id WHERE c.user_id = ? AND NOT c.hidden`, [userId]);
  const contactDomains = [...new Set(contacts.filter((c) => c.sent_count > 0).map((c) => domainOf(c.email)))];
  const names = new Map<string, string[]>();
  for (const c of contacts) {
    if (!c.display_name || c.sent_count <= 0) continue;
    const k = c.display_name.trim().toLowerCase();
    names.set(k, [...(names.get(k) ?? []), c.email.toLowerCase()]);
  }
  const knownContact = contacts.some((c) => c.email.toLowerCase() === fromAddr);
  const earlier = await one(`SELECT 1 FROM messages WHERE user_id = ? AND lower(from_addr) = ? AND id <> ? LIMIT 1`, [userId, fromAddr, rowId]);

  const auth = parseAuth(parsed);
  const replyTo = (Array.isArray(parsed.replyTo) ? parsed.replyTo[0] : parsed.replyTo)?.value?.map((v: { address?: string }) => (v.address ?? '').toLowerCase()).filter(Boolean) ?? [];
  const pushDomains = (await q<{ d: string }>(
    `SELECT unnest(p.domains) AS d FROM push_inboxes p JOIN accounts a ON a.id = p.account_id WHERE a.user_id = ?`, [userId])).map((r) => r.d);
  const arcPass = arcVouches((parsed.headerLines ?? []).filter((h) => h.key.startsWith('arc-')).map((h) => h.line), pushDomains);
  const result = assessRisk({
    arcPass,
    fromAddr, fromName: fromObj?.name ?? '', replyTo,
    auth: { spf: auth.spf?.result.toLowerCase(), dkim: auth.dkim?.result.toLowerCase(), dmarc: auth.dmarc?.result.toLowerCase() },
    subject: parsed.subject ?? '', text: parsed.text ?? '', html: typeof parsed.html === 'string' ? parsed.html : null,
    attachments: (parsed.attachments ?? []).map((a) => ({ filename: a.filename ?? '', contentType: a.contentType ?? '' })),
    ownDomains: [...own], contactDomains, knownContactNames: names,
    firstTimeSender: !earlier && !knownContact, knownContact,
    trusted: await isTrusted(userId, fromAddr),
  });
  await run(`INSERT INTO message_risk(message_id, score, level, reasons, created_at) VALUES (?,?,?,?::jsonb,?)
             ON CONFLICT (message_id) DO UPDATE SET score = excluded.score, level = excluded.level, reasons = excluded.reasons`,
    [rowId, result.score, result.level, JSON.stringify(result.reasons), Date.now()]);
}
