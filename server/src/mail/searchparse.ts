/**
 * Search query language:
 *   from:foo to:bar label:Work in:inbox is:unread is:starred has:attachment category:work assigned:me|none status:open|pending|done business:"Name"
 *   opened:yes|no replied:yes|no older_than:7d|2w|3m|1y newer_than:2d size>5mb size<100kb is:waiting is:snoozed
 *   before:2026-01-31 after:2026-01-01 "quoted phrase" free words
 * Everything unprefixed becomes a Postgres tsquery over subject/body/from/to.
 */
export interface ParsedSearch {
  fts: string | null;         // to_tsquery('simple', ...) expression
  from: string | null;
  to: string | null;
  label: string | null;
  category: string | null;    // mailbox category key or name (T1 F-07)
  inRole: string | null;
  unread: boolean | null;
  starred: boolean | null;
  hasAttachment: boolean | null;
  disposable: 'any' | number | null; // T3 F-25: is:disposable / disposable:<id>
  business: string | null;    // T4 F-30: business:"Name"
  assigned: 'me' | 'none' | null;            // T4 F-32: assigned:me / assigned:none
  status: 'open' | 'pending' | 'done' | null; // T4 F-32: status:open|pending|done
  risk: 'high' | 'medium' | null; // T2 F-20: risk:high / risk:medium
  opened: boolean | null;     // T4 F-34: opened:yes|no (tracked sent mail with / without opens)
  replied: boolean | null;    // T4 F-34: replied:yes|no
  olderThanMs: number | null; // older_than:7d|2w|3m|1y
  newerThanMs: number | null; // newer_than:...
  sizeMin: number | null;     // size>5mb (bytes, exclusive)
  sizeMax: number | null;     // size<100kb (bytes, exclusive)
  waiting: boolean | null;    // is:waiting
  snoozed: boolean | null;    // is:snoozed
  before: number | null;      // epoch ms
  after: number | null;
}

/**
 * One search term -> tsquery fragment with prefix matching ("pass" finds
 * "password"). Multi-word phrases become adjacency chains (a <-> b).
 */
function ftsEscape(term: string): string {
  const words = term
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_@.-]+/gu, '').replace(/^[.-]+|[.-]+$/g, ''))
    .filter(Boolean)
    // lexize each word the way to_tsvector('simple') does: lowercase; dots/@ split handled by :* prefix on the first token
    .map((w) => `'${w.toLowerCase().replace(/'/g, "''")}':*`);
  if (words.length === 0) return '';
  return words.length === 1 ? words[0] : `(${words.join(' <-> ')})`;
}

const DAY = 86_400_000;
/** "7d" "2w" "3m" "1y" (and "12h") -> milliseconds; a month is 30 days, a year 365. */
export function parseDuration(v: string): number | null {
  const m = /^(\d+)([hdwmy])$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { h: DAY / 24, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY }[m[2].toLowerCase() as 'h' | 'd' | 'w' | 'm' | 'y'];
  return n * unit;
}

/** "5mb" "100kb" "2gb" "300" -> bytes. */
export function parseSize(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i.exec(v.trim());
  if (!m) return null;
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] ?? 'b').toLowerCase() as 'b' | 'kb' | 'mb' | 'gb'];
  return Math.round(Number(m[1]) * mult);
}

const yesNo = (v: string): boolean | null => (/^(yes|true|y)$/i.test(v) ? true : /^(no|false|n)$/i.test(v) ? false : null);

export function parseSearch(query: string): ParsedSearch {
  const out: ParsedSearch = {
    fts: null, from: null, to: null, label: null, category: null, inRole: null,
    unread: null, starred: null, hasAttachment: null, disposable: null, business: null, assigned: null, status: null, risk: null,
    opened: null, replied: null, olderThanMs: null, newerThanMs: null, sizeMin: null, sizeMax: null, waiting: null, snoozed: null, before: null, after: null,
  };
  const ftsTerms: string[] = [];
  // tokens: key:"quoted value" | key:value | "quoted phrase" | word
  const tokenRe = /(\w+):"([^"]*)"|(\w+):(\S+)|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(query)) !== null) {
    const key = (m[1] ?? m[3])?.toLowerCase();
    const val = m[2] ?? m[4];
    if (key && val !== undefined) {
      switch (key) {
        case 'from': out.from = val; continue;
        case 'to': out.to = val; continue;
        case 'label': out.label = val; continue;
        case 'category': out.category = val; continue;
        case 'business': out.business = val; continue;
        case 'in': {
          // UI names: Spam = junk, Bin = trash
          const r = val.toLowerCase();
          out.inRole = r === 'spam' ? 'junk' : r === 'bin' ? 'trash' : r;
          continue;
        }
        case 'is':
          if (val === 'unread') out.unread = true;
          else if (val === 'read') out.unread = false;
          else if (val === 'disposable') out.disposable = 'any';
          else if (val === 'waiting') out.waiting = true;
          else if (val === 'snoozed') out.snoozed = true;
          else if (val === 'starred' || val === 'flagged') out.starred = true;
          continue;
        case 'has':
          if (val === 'attachment') out.hasAttachment = true;
          continue;
        case 'disposable': if (/^\d+$/.test(val)) out.disposable = Number(val); continue;
        case 'assigned': { const v = val.toLowerCase(); if (v === 'me' || v === 'none') out.assigned = v; continue; }
        case 'status': { const v = val.toLowerCase(); if (v === 'open' || v === 'pending' || v === 'done') out.status = v; continue; }
        case 'risk': if (val === 'high' || val === 'medium') out.risk = val; continue;
        case 'opened': { const v = yesNo(val); if (v !== null) out.opened = v; continue; }
        case 'replied': { const v = yesNo(val); if (v !== null) out.replied = v; continue; }
        case 'older_than': { const v = parseDuration(val); if (v !== null) out.olderThanMs = v; continue; }
        case 'newer_than': { const v = parseDuration(val); if (v !== null) out.newerThanMs = v; continue; }
        case 'before': { const t = Date.parse(val); if (!isNaN(t)) out.before = t; continue; }
        case 'after': { const t = Date.parse(val); if (!isNaN(t)) out.after = t; continue; }
        default: {
          const esc = ftsEscape(`${key} ${val}`);
          if (esc) ftsTerms.push(esc);
          continue;
        }
      }
    }
    const sz = m[6] ? /^size([<>])(.+)$/i.exec(m[6]) : null;
    if (sz) {
      const bytes = parseSize(sz[2]);
      if (bytes !== null) { if (sz[1] === '>') out.sizeMin = bytes; else out.sizeMax = bytes; continue; }
    }
    const phrase = m[5] ?? m[6];
    if (phrase) {
      const esc = ftsEscape(phrase);
      if (esc) ftsTerms.push(esc);
    }
  }
  if (ftsTerms.length > 0) out.fts = ftsTerms.join(' & ');
  return out;
}
