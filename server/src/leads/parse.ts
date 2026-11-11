/**
 * Lead parser (T5.4 F-38). Form-plugin notification emails → {name, email, phone, suburb, service, message, …}.
 * Deterministic first ("Label: value" lines, label-then-value lines, 2-column HTML tables); the AI fallback is only
 * called by the caller when this finds neither an email nor a phone.
 */

export interface LeadFields {
  name: string | null;
  email: string | null;
  phone: string | null;
  suburb: string | null;
  service: string | null;
  message: string | null;
  preferredDate: string | null;
  budget: string | null;
  sourcePage: string | null;
  utm: Record<string, string>;
  /** every other "label → value" pair that was found (labels as written) */
  extra: Record<string, string>;
}

export const EMPTY_LEAD: LeadFields = {
  name: null, email: null, phone: null, suburb: null, service: null, message: null, preferredDate: null, budget: null, sourcePage: null, utm: {}, extra: {},
};

type Canon = 'name' | 'first' | 'last' | 'email' | 'phone' | 'suburb' | 'postcode' | 'service' | 'message' | 'date' | 'budget' | 'page' | 'from';

const ALIASES: Record<Canon, string[]> = {
  name: ['name', 'your name', 'full name', 'fullname', 'contact name', 'customer name', 'client name', 'sender name', 'sender', 'user name'],
  first: ['first name', 'firstname', 'first', 'given name'],
  last: ['last name', 'lastname', 'last', 'surname', 'family name'],
  email: ['email', 'e mail', 'email address', 'your email', 'your e mail', 'e mail address', 'user email', 'contact email', 'customer email', 'from email'],
  phone: ['phone', 'mobile', 'tel', 'telephone', 'phone number', 'mobile number', 'contact number', 'your phone', 'your mobile', 'cell', 'user phone', 'contact phone', 'mobile phone'],
  suburb: ['suburb', 'location', 'city', 'town', 'your suburb', 'service location', 'service area'],
  postcode: ['postcode', 'post code', 'postal code', 'zip', 'zip code'],
  service: ['service', 'enquiry type', 'inquiry type', 'service required', 'service type', 'type of service', 'services', 'service needed', 'what do you need', 'which service do you need', 'request type', 'subject'],
  message: ['message', 'your message', 'comments', 'comment', 'details', 'enquiry', 'inquiry', 'additional information', 'additional details', 'notes', 'description', 'message body', 'how can we help', 'how can we help you', 'comment or message', 'comments or message', 'your enquiry'],
  date: ['date', 'preferred date', 'preferred start date', 'preferred time', 'when', 'start date', 'date required', 'booking date'],
  budget: ['budget', 'your budget', 'estimated budget'],
  page: ['page', 'source url', 'page url', 'source', 'form url', 'url', 'source page', 'referrer', 'landing page'],
  from: ['from'],
};

const LOOKUP = new Map<string, Canon>();
for (const [canon, list] of Object.entries(ALIASES) as [Canon, string[]][]) for (const a of list) if (!LOOKUP.has(a)) LOOKUP.set(a, canon);

/** "Full_Name *" / "E-mail:" → "full name" / "e mail" */
const normLabel = (s: string) => s.toLowerCase().replace(/[*_\-/.()]+/g, ' ').replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
const canonical = (label: string): Canon | null => LOOKUP.get(normLabel(label)) ?? null;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/[ \t\u00a0]+/g, ' ').trim();

/** HTML → lines. 2-column table rows become "Label: value"; block tags become newlines. */
export function htmlToLines(html: string): string {
  let h = html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row: string) => {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => decodeEntities(stripTags(c[1].replace(/<br\s*\/?>/gi, ' '))));
    if (cells.length >= 2 && cells[0]) {
      const label = cells[0].replace(/:\s*$/, '');
      return `\n${label}: ${cells.slice(1).join(' ').trim()}\n`;
    }
    return `\n${cells.join(' ')}\n`;
  });
  h = h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|table|tr|ul|ol|blockquote)>/gi, '\n').replace(/<(p|div|li|h[1-6])[^>]*>/gi, '\n');
  return decodeEntities(h.replace(/<[^>]+>/g, '')).replace(/\u00a0/g, ' ');
}

const COLON = /^\s*([A-Za-z][A-Za-z0-9 _\-/.()*]{0,40}?)\s*[:：]\s*(.*)$/;
const FOOTER = /^(--+\s*|_{3,}|this e-?mail was sent|sent from|you are receiving|powered by|to view this|view in browser)/i;

/** Single-line values: first plausible email / phone inside the text. */
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function normaliseAuPhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (/^\+/.test(digits)) return '+' + digits.slice(1).replace(/\+/g, '');
  const d = digits.replace(/\+/g, '');
  if (/^0[2-478]\d{8}$/.test(d)) return `+61${d.slice(1)}`;       // 04xx xxx xxx, (08) 9xxx xxxx, 02/03/07
  if (/^0011\d{8,13}$/.test(d)) return `+${d.slice(4)}`;          // 0011 international prefix
  if (/^61[2-478]\d{8}$/.test(d)) return `+${d}`;
  return trimmed;                                                 // 13 xx xx, 1300…, 8-digit local numbers: leave alone
}

function pickPhone(v: string): string | null {
  const cleaned = v.replace(/^\s*p:\s*/i, '');   // Facebook lead ads prefix numbers with "p:"
  const m = cleaned.match(/\+?[\d(][\d\s().-]{6,}\d/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return normaliseAuPhone(m[0]);
}

function pickEmail(v: string): string | null {
  const m = v.match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

interface Collected { [k: string]: string }

/** Core line parser → canonical values + extras + utm. */
function collect(text: string): { canon: Collected; extra: Record<string, string>; utm: Record<string, string> } {
  const canon: Collected = {};
  const extra: Record<string, string> = {};
  const utm: Record<string, string> = {};
  let open: { key: Canon | string; awaiting: boolean; isCanon: boolean } | null = null;

  const put = (label: string, c: Canon | null, value: string) => {
    const v = value.trim();
    if (/^utm_/i.test(label.trim())) { if (v) utm[label.trim().toLowerCase()] = v; return; }
    if (c) { if (v && !canon[c]) canon[c] = v; else if (v && c === 'message') canon[c] += '\n' + v; return; }
    if (v && !(label in extra)) extra[label.trim()] = v;
  };
  const appendMessage = (v: string) => { canon.message = canon.message ? `${canon.message}\n${v}` : v; };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (FOOTER.test(line)) { open = null; continue; }
    const m = COLON.exec(line);
    if (m) {
      const c = canonical(m[1]);
      const isUtm = /^utm[_ ]/i.test(m[1].trim());
      const messageOpen = open?.isCanon && open.key === 'message';
      if (c || isUtm || (!messageOpen && m[1].trim().split(/\s+/).length <= 5)) {
        // Google Ads / CF7 "From: Name <email>"
        if (c === 'from') {
          const em = pickEmail(m[2]);
          if (em) { canon.email ||= em; const nm = m[2].replace(/<[^>]*>/g, '').replace(EMAIL_RE, '').replace(/["']/g, '').trim(); if (nm) canon.name ||= nm; }
          open = null;
          continue;
        }
        if (c === 'message' && open?.key === 'message') { appendMessage(m[2].trim()); continue; }
        put(m[1], c, m[2]);
        open = c === 'message' ? { key: 'message', awaiting: m[2].trim() === '', isCanon: true }
          : m[2].trim() === '' ? { key: c ?? m[1].trim(), awaiting: true, isCanon: !!c } : null;
        continue;
      }
    }
    // a bare known label ("Name" newline "Jane") — Gravity Forms / WPForms
    const bare = line.length < 45 ? canonical(line) : null;
    if (bare && bare !== 'from') { open = { key: bare, awaiting: true, isCanon: true }; continue; }
    if (open) {
      if (open.isCanon) {
        if (open.key === 'message') { appendMessage(line); open.awaiting = false; }
        else if (open.awaiting) { put(open.key, open.key as Canon, line); open = null; }
      } else if (open.awaiting) { put(String(open.key), null, line); open = null; }
    }
  }
  return { canon, extra, utm };
}

function toFields(text: string, fallbackEmail?: string | null): LeadFields {
  const { canon, extra, utm } = collect(text);
  const out: LeadFields = { ...EMPTY_LEAD, utm, extra };
  out.email = (canon.email && pickEmail(canon.email)) || null;
  out.phone = (canon.phone && pickPhone(canon.phone)) || null;
  let name = canon.name?.replace(EMAIL_RE, '').replace(/[<>]/g, '').trim() || '';
  if (!name && (canon.first || canon.last)) name = `${canon.first ?? ''} ${canon.last ?? ''}`.trim();
  out.name = name || null;
  out.suburb = canon.suburb ? (canon.postcode && !canon.suburb.includes(canon.postcode) ? `${canon.suburb} ${canon.postcode}` : canon.suburb) : canon.postcode ?? null;
  out.service = canon.service ?? null;
  out.message = canon.message ? canon.message.replace(/\n{3,}/g, '\n\n').trim().slice(0, 5000) : null;
  out.preferredDate = canon.date ?? null;
  out.budget = canon.budget ?? null;
  out.sourcePage = canon.page ?? null;
  // phone/email hiding in extra fields ("Contact": "0412…") when no alias matched
  if (!out.phone) for (const v of Object.values(extra)) { const p = /^\s*(p:\s*)?\+?[\d(][\d\s().-]{7,}\d\s*$/.test(v) ? pickPhone(v) : null; if (p) { out.phone = p; break; } }
  if (!out.email) for (const v of Object.values(extra)) { const e = pickEmail(v); if (e && v.trim().length < 80) { out.email = e; break; } }
  if (!out.email && fallbackEmail) out.email = fallbackEmail.toLowerCase();
  return out;
}

const score = (f: LeadFields) => [f.name, f.email, f.phone, f.suburb, f.service, f.message].filter(Boolean).length + (f.email ? 1 : 0) + (f.phone ? 1 : 0);

/** Deterministic parse of a message. `replyTo` is only a fallback for the lead's email (form plugins set it to the submitter). */
export function parseLead(input: { text?: string | null; html?: string | null; replyTo?: string | null }): LeadFields {
  const candidates: LeadFields[] = [];
  if (input.text?.trim()) candidates.push(toFields(input.text, input.replyTo));
  if (input.html?.trim()) candidates.push(toFields(htmlToLines(input.html), input.replyTo));
  if (candidates.length === 0) return { ...EMPTY_LEAD, email: input.replyTo ? input.replyTo.toLowerCase() : null };
  return candidates.reduce((best, c) => (score(c) > score(best) ? c : best));
}

/** True when the deterministic parse found a way to contact the lead (so no AI is needed). */
export const hasContact = (f: LeadFields) => !!(f.email || f.phone);
