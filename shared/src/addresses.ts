/** Pure address-list helpers shared by the compose field and the server (T8.11). */

export interface ParsedAddress { name: string; email: string }

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const isEmail = (s: string): boolean => EMAIL_RE.test(s.trim());

/** Split on commas/semicolons/newlines that are not inside "quotes" or <angle brackets>. */
export function splitAddressList(text: string): string[] {
  const out: string[] = [];
  let cur = ''; let quote = false; let angle = false;
  for (const ch of text) {
    if (ch === '"') quote = !quote;
    else if (!quote && ch === '<') angle = true;
    else if (!quote && ch === '>') angle = false;
    if (!quote && !angle && (ch === ',' || ch === ';' || ch === '\n' || ch === '\r')) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** "Name <a@b>, c@d, "Doe, Jane" <j@x.test>" → [{name,email}]. Entries without an address are kept with email '' + name. */
export function parseAddressList(text: string): ParsedAddress[] {
  return splitAddressList(text).map((p) => {
    const m = p.match(/^(.*?)<([^>]*)>\s*$/);
    if (m) return { name: m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"').trim(), email: m[2].trim() };
    if (p.includes('@')) return { name: '', email: p.replace(/^mailto:/i, '') };
    return { name: p, email: '' };
  });
}

/** Levenshtein distance, capped (used for the "did you mean" typo guard). */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// ---- contacts API shapes ----
export interface ApiContactEmail { email: string; label: string; primary: boolean }
export interface ApiContactPhone { label: string; value: string }
export interface ApiContact {
  id: number; displayName: string; org: string; notes: string;
  emails: string[]; emailsDetail: ApiContactEmail[]; phones: ApiContactPhone[]; groupIds: number[];
  sentCount: number; receivedCount: number; lastInteractionAt: string | null;
  autoCreated: boolean; hidden: boolean; noBusinessGuard: boolean;
}
export interface ApiContactGroup { id: number; name: string; memberCount: number }
export interface ApiContactSuggestion {
  type: 'contact' | 'group'; name: string; email: string; org?: string; other?: boolean;
  members?: ParsedAddress[];
}
