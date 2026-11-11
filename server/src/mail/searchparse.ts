/**
 * Search query language:
 *   from:foo to:bar label:Work in:inbox is:unread is:starred has:attachment category:work
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
  risk: 'high' | 'medium' | null; // T2 F-20: risk:high / risk:medium
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

export function parseSearch(query: string): ParsedSearch {
  const out: ParsedSearch = {
    fts: null, from: null, to: null, label: null, category: null, inRole: null,
    unread: null, starred: null, hasAttachment: null, disposable: null, risk: null, before: null, after: null,
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
          else if (val === 'starred' || val === 'flagged') out.starred = true;
          continue;
        case 'has':
          if (val === 'attachment') out.hasAttachment = true;
          continue;
        case 'disposable': if (/^\d+$/.test(val)) out.disposable = Number(val); continue;
        case 'risk': if (val === 'high' || val === 'medium') out.risk = val; continue;
        case 'before': { const t = Date.parse(val); if (!isNaN(t)) out.before = t; continue; }
        case 'after': { const t = Date.parse(val); if (!isNaN(t)) out.after = t; continue; }
        default: {
          const esc = ftsEscape(`${key} ${val}`);
          if (esc) ftsTerms.push(esc);
          continue;
        }
      }
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
