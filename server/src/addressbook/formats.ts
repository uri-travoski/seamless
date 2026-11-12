/**
 * Contact import/export formats (T8.11 7b). Pure functions: parse/serialize vCard 2.1/3.0/4.0, Google Contacts CSV,
 * Outlook CSV, Apple/Thunderbird CSV and a generic CSV with a column mapping. No database access here.
 */
import { isEmail } from '@seamless/shared';

export interface PhoneEntry { label: string; value: string }
export interface EmailEntry { email: string; label: string }
export interface ParsedContact {
  displayName: string; org: string; notes: string;
  emails: EmailEntry[]; phones: PhoneEntry[]; groups: string[];
}
export interface ExportContact extends ParsedContact { id?: number; updatedAt?: number }
export type ExportFormat = 'vcf' | 'google' | 'outlook' | 'csv' | 'json';

export const emailLabels = ['work', 'home', 'other'] as const;
export const phoneLabels = ['mobile', 'home', 'work', 'other'] as const;
const normEmailLabel = (s: string): string => { const l = s.toLowerCase(); return l.includes('work') || l.includes('business') ? 'work' : l.includes('home') || l.includes('personal') ? 'home' : l ? 'other' : ''; };
const normPhoneLabel = (s: string): string => { const l = s.toLowerCase(); return l.includes('mobile') || l.includes('cell') ? 'mobile' : l.includes('home') ? 'home' : l.includes('work') || l.includes('business') ? 'work' : 'other'; };

// ---------- text decoding + CSV ----------

/** UTF-8 (with/without BOM) and UTF-16 LE/BE (with BOM, or detected by NUL bytes) to a string. */
export function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.from(buf.subarray(2)); sw.swap16(); return sw.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length >= 4 && buf.subarray(0, 200).includes(0)) {
    if (buf[1] === 0 && buf[0] !== 0) return buf.toString('utf16le');
    if (buf[0] === 0 && buf[1] !== 0) { const sw = Buffer.from(buf); sw.swap16(); return sw.toString('utf16le'); }
  }
  return buf.toString('utf8');
}

export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const ch of firstLine) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0) ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ',';
}

/** RFC 4180 parser; returns rows of cells. Blank lines dropped. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let q = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (rows: string[][]): string => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

// ---------- CSV → contacts ----------

export type Role = 'name' | 'first' | 'middle' | 'last' | 'email' | 'phone' | 'org' | 'notes' | 'groups';
export type Mapping = Partial<Record<Role, string[]>>;
export const ROLES: Role[] = ['name', 'first', 'middle', 'last', 'email', 'phone', 'org', 'notes', 'groups'];

function roleOf(header: string): Role | null {
  const h = header.trim().toLowerCase();
  if (/^(display name|name|full name|file as)$/.test(h)) return 'name';
  if (/^(first name|given name)$/.test(h)) return 'first';
  if (/^(middle name|additional name)$/.test(h)) return 'middle';
  if (/^(last name|family name|surname)$/.test(h)) return 'last';
  if (/(type|label|display name|country|extension)$/.test(h) && /e-?mail|phone/.test(h)) return null;
  if (/^e-?mail( \d+)?( address| - value| value)?$/.test(h) || /^(primary|secondary|work|home|other) e-?mail$/.test(h) || /^e-?mail addresses$|^emails$/.test(h)) return 'email';
  if (/(phone|mobile|\btel\b|cell|fax|pager)/.test(h) && !/(type|label|country|extension)$/.test(h) && !/fax|pager/.test(h)) return 'phone';
  if (/^(company|organi[sz]ation( 1)?( - name| name)?|org)$/.test(h)) return 'org';
  if (/^(notes?|comments?)$/.test(h)) return 'notes';
  if (/^(group membership|categories|groups?|labels?)$/.test(h)) return 'groups';
  return null;
}

/** Guess the column roles from the header row. */
export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  for (const h of headers) {
    const r = roleOf(h);
    if (r) (m[r] ||= []).push(h);
  }
  // a plain "Name" column wins over first/last when both exist
  return m;
}

export type CsvFlavor = 'google' | 'outlook' | 'apple' | 'generic';
export function detectFlavor(headers: string[]): CsvFlavor {
  const h = headers.map((x) => x.toLowerCase());
  if (h.some((x) => /^e-?mail \d+ - value$/.test(x)) || h.includes('given name')) return 'google';
  if (h.includes('e-mail address') || h.includes('e-mail 2 address') || h.includes('business phone')) return 'outlook';
  if (h.includes('primary email') || h.includes('display name')) return 'apple';
  return 'generic';
}

const splitMulti = (s: string): string[] => s.split(/\s*(?::::|[;|\n])\s*/).map((x) => x.trim()).filter(Boolean);

function labelFromHeader(header: string, headers: string[], row: string[]): string {
  // Google: "E-mail 2 - Value" has a sibling "E-mail 2 - Type"
  const m = header.match(/^(.*) - value$/i);
  if (m) {
    const idx = headers.findIndex((x) => x.toLowerCase() === `${m[1].toLowerCase()} - type`);
    if (idx >= 0) return (row[idx] ?? '').replace(/^\*\s*/, '').trim();
  }
  return header;
}

export function csvToContacts(rows: string[][], mapping?: Mapping): { contacts: (ParsedContact | null)[]; headers: string[] } {
  if (rows.length === 0) return { contacts: [], headers: [] };
  const headers = rows[0].map((h) => h.replace(/^\uFEFF/, '').trim());
  const map = mapping && Object.keys(mapping).length ? mapping : guessMapping(headers);
  const col = (name: string) => headers.indexOf(name);
  const out: (ParsedContact | null)[] = [];
  for (const row of rows.slice(1)) {
    const cell = (names?: string[]) => (names ?? []).map((n) => (row[col(n)] ?? '').trim()).filter(Boolean);
    const first = cell(map.first)[0] ?? ''; const middle = cell(map.middle)[0] ?? ''; const last = cell(map.last)[0] ?? '';
    const name = cell(map.name)[0] || [first, middle, last].filter(Boolean).join(' ');
    const emails: EmailEntry[] = [];
    for (const n of map.email ?? []) {
      const raw = (row[col(n)] ?? '').trim();
      if (!raw) continue;
      const label = normEmailLabel(labelFromHeader(n, headers, row).replace(/e-?mail( \d+)?( address| - value| value)?|primary|secondary/gi, ''));
      for (const e of splitMulti(raw)) emails.push({ email: e.toLowerCase(), label });
    }
    const phones: PhoneEntry[] = [];
    for (const n of map.phone ?? []) {
      const raw = (row[col(n)] ?? '').trim();
      if (!raw) continue;
      const lab = normPhoneLabel(labelFromHeader(n, headers, row).replace(/phone( \d+)?( - value| value)?/i, '').replace(/primary/i, ''));
      for (const p of splitMulti(raw)) phones.push({ label: lab, value: p });
    }
    const groups: string[] = [];
    for (const g of cell(map.groups)) for (const x of g.split(/\s*(?::::|;)\s*/)) {
      const name2 = x.replace(/^\*\s*/, '').trim();
      if (name2 && name2.toLowerCase() !== 'mycontacts' && !groups.includes(name2)) groups.push(name2);
    }
    const c: ParsedContact = { displayName: name, org: cell(map.org)[0] ?? '', notes: cell(map.notes)[0] ?? '', emails, phones, groups };
    out.push(row.every((x) => !x.trim()) ? null : c);
  }
  return { contacts: out, headers };
}

// ---------- vCard ----------

const vesc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const vunesc = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

export function splitName(full: string): { given: string; family: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return { given: full.trim(), family: '' };
  return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1] };
}

function foldLine(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) { parts.push((i === 0 ? '' : ' ') + line.slice(i, i + (i === 0 ? 74 : 73))); i += i === 0 ? 74 : 73; }
  return parts.join('\r\n');
}

export function contactToVcard(c: ExportContact, uid?: string): string {
  const { given, family } = splitName(c.displayName);
  const lines = [
    'BEGIN:VCARD', 'VERSION:3.0',
    `UID:${uid ?? `seamless-contact-${c.id ?? Math.random().toString(36).slice(2)}`}`,
    `FN:${vesc(c.displayName || c.emails[0]?.email || 'Unknown')}`,
    `N:${vesc(family)};${vesc(given)};;;`,
    ...(c.org ? [`ORG:${vesc(c.org)}`] : []),
    ...(c.notes ? [`NOTE:${vesc(c.notes)}`] : []),
    ...c.emails.map((e, i) => `EMAIL;TYPE=INTERNET${e.label ? `;TYPE=${e.label.toUpperCase()}` : ''}${i === 0 ? ';TYPE=PREF' : ''}:${e.email}`),
    ...c.phones.map((p) => `TEL;TYPE=${p.label === 'mobile' ? 'CELL' : p.label.toUpperCase()}:${vesc(p.value)}`),
    ...(c.groups.length ? [`CATEGORIES:${c.groups.map(vesc).join(',')}`] : []),
    ...(c.updatedAt ? [`REV:${new Date(c.updatedAt).toISOString()}`] : []),
    'END:VCARD',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** vCard 2.1 / 3.0 / 4.0. Photos and unknown properties are ignored. */
export function parseVcards(text: string): ParsedContact[] {
  const out: ParsedContact[] = [];
  // quoted-printable soft breaks (2.1) then RFC folding
  const unfolded = text.replace(/=\r?\n/g, '').replace(/\r?\n[ \t]/g, '');
  for (const block of unfolded.split(/^BEGIN:VCARD\s*$/im).slice(1)) {
    const c: ParsedContact = { displayName: '', org: '', notes: '', emails: [], phones: [], groups: [] };
    let n = '';
    for (const line of block.split(/\r?\n/)) {
      if (/^END:VCARD/i.test(line)) break;
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const head = line.slice(0, idx).replace(/^[a-z0-9-]+\./i, '');
      const [prop, ...params] = head.split(';');
      const p = prop.toUpperCase();
      let value = line.slice(idx + 1);
      if (params.some((x) => /ENCODING=QUOTED-PRINTABLE/i.test(x) || /^QUOTED-PRINTABLE$/i.test(x))) {
        value = value.replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
        try { value = Buffer.from(value, 'latin1').toString('utf8'); } catch { /* keep */ }
      }
      const types = params.map((x) => x.replace(/"/g, '')).flatMap((x) => (x.includes('=') ? (/^TYPE=/i.test(x) ? x.split('=')[1].split(',') : []) : [x])).map((x) => x.toLowerCase());
      if (p === 'FN') c.displayName = vunesc(value).trim();
      else if (p === 'N') n = value;
      else if (p === 'ORG') c.org = value.split(/(?<!\\);/)[0] ? vunesc(value.split(/(?<!\\);/)[0]).trim() : '';
      else if (p === 'NOTE') c.notes = vunesc(value).trim();
      else if (p === 'EMAIL') {
        const email = value.trim().replace(/^mailto:/i, '').toLowerCase();
        if (email.includes('@')) c.emails.push({ email, label: types.includes('work') ? 'work' : types.includes('home') ? 'home' : types.includes('other') ? 'other' : '' });
      } else if (p === 'TEL') {
        const v = vunesc(value).replace(/^tel:/i, '').trim();
        if (v) c.phones.push({ label: types.includes('cell') || types.includes('mobile') ? 'mobile' : types.includes('home') ? 'home' : types.includes('work') ? 'work' : 'other', value: v });
      } else if (p === 'CATEGORIES') {
        for (const g of value.split(/(?<!\\),/)) { const name = vunesc(g).trim(); if (name && !c.groups.includes(name)) c.groups.push(name); }
      }
    }
    if (!c.displayName && n) {
      const [fam = '', giv = '', mid = ''] = n.split(/(?<!\\);/).map((x) => vunesc(x).trim());
      c.displayName = [giv, mid, fam].filter(Boolean).join(' ');
    }
    if (c.emails.length || c.displayName || c.phones.length) out.push(c);
  }
  return out;
}

// ---------- CSV writers ----------

const maxLen = (cs: ExportContact[], f: (c: ExportContact) => unknown[]) => cs.reduce((m, c) => Math.max(m, f(c).length), 0);
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : '');

export function toGoogleCsv(cs: ExportContact[]): string {
  const ne = Math.max(1, maxLen(cs, (c) => c.emails)); const np = Math.max(1, maxLen(cs, (c) => c.phones));
  const head = ['Name', 'Given Name', 'Family Name', 'Notes', 'Group Membership',
    ...Array.from({ length: ne }, (_, i) => [`E-mail ${i + 1} - Type`, `E-mail ${i + 1} - Value`]).flat(),
    ...Array.from({ length: np }, (_, i) => [`Phone ${i + 1} - Type`, `Phone ${i + 1} - Value`]).flat(),
    'Organization 1 - Name'];
  const rows = cs.map((c) => {
    const { given, family } = splitName(c.displayName);
    return [c.displayName, given, family, c.notes, ['* myContacts', ...c.groups].join(' ::: '),
      ...Array.from({ length: ne }, (_, i) => [cap(c.emails[i]?.label ?? ''), c.emails[i]?.email ?? '']).flat(),
      ...Array.from({ length: np }, (_, i) => [cap(c.phones[i]?.label ?? ''), c.phones[i]?.value ?? '']).flat(),
      c.org];
  });
  return toCsv([head, ...rows]);
}

export function toOutlookCsv(cs: ExportContact[]): string {
  const head = ['First Name', 'Middle Name', 'Last Name', 'Company', 'E-mail Address', 'E-mail 2 Address', 'E-mail 3 Address',
    'Primary Phone', 'Home Phone', 'Mobile Phone', 'Business Phone', 'Notes', 'Categories'];
  const rows = cs.map((c) => {
    const { given, family } = splitName(c.displayName);
    const ph = (l: string) => c.phones.filter((p) => p.label === l).map((p) => p.value).join('; ');
    return [given, '', family, c.org, c.emails[0]?.email ?? '', c.emails[1]?.email ?? '', c.emails.slice(2).map((e) => e.email).join('; '),
      ph('other'), ph('home'), ph('mobile'), ph('work'), c.notes, c.groups.join(';')];
  });
  return toCsv([head, ...rows]);
}

export function toGenericCsv(cs: ExportContact[]): string {
  const head = ['Name', 'Emails', 'Phones', 'Organization', 'Notes', 'Groups'];
  const rows = cs.map((c) => [c.displayName, c.emails.map((e) => e.email).join('; '), c.phones.map((p) => p.value).join('; '), c.org, c.notes, c.groups.join('; ')]);
  return toCsv([head, ...rows]);
}

export function serializeContacts(cs: ExportContact[], format: ExportFormat): { body: string; mime: string; ext: string } {
  switch (format) {
    case 'vcf': return { body: cs.map((c) => contactToVcard(c)).join(''), mime: 'text/vcard; charset=utf-8', ext: 'vcf' };
    case 'google': return { body: toGoogleCsv(cs), mime: 'text/csv; charset=utf-8', ext: 'csv' };
    case 'outlook': return { body: toOutlookCsv(cs), mime: 'text/csv; charset=utf-8', ext: 'csv' };
    case 'csv': return { body: toGenericCsv(cs), mime: 'text/csv; charset=utf-8', ext: 'csv' };
    case 'json': return { body: JSON.stringify({ version: 1, contacts: cs.map(({ displayName, org, notes, emails, phones, groups }) => ({ displayName, org, notes, emails, phones, groups })) }, null, 2), mime: 'application/json', ext: 'json' };
  }
}

/** Parse an uploaded file (vCard / CSV / JSON) into contacts. `rows` are null for empty lines; `invalid` is decided by the importer. */
export interface ParsedFile {
  kind: 'vcf' | 'csv' | 'json'; contacts: (ParsedContact | null)[];
  headers?: string[]; flavor?: CsvFlavor; mapping?: Mapping; delimiter?: string;
}
export function parseContactFile(buf: Buffer, mapping?: Mapping): ParsedFile {
  const text = decodeText(buf);
  const trimmed = text.trimStart();
  if (/^BEGIN:VCARD/i.test(trimmed)) return { kind: 'vcf', contacts: parseVcards(text) };
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      const list = Array.isArray(j) ? j : j.contacts ?? [];
      return { kind: 'json', contacts: list.map((x: any): ParsedContact => ({
        displayName: String(x.displayName ?? x.name ?? ''), org: String(x.org ?? ''), notes: String(x.notes ?? ''),
        emails: (x.emails ?? []).map((e: any) => (typeof e === 'string' ? { email: e.toLowerCase(), label: '' } : { email: String(e.email ?? '').toLowerCase(), label: String(e.label ?? '') })),
        phones: (x.phones ?? []).map((p: any) => (typeof p === 'string' ? { label: 'other', value: p } : { label: String(p.label ?? 'other'), value: String(p.value ?? '') })),
        groups: (x.groups ?? []).map(String),
      })) };
    } catch { return { kind: 'json', contacts: [] }; }
  }
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  const { contacts, headers } = csvToContacts(rows, mapping);
  return { kind: 'csv', contacts, headers, flavor: detectFlavor(headers), mapping: mapping && Object.keys(mapping).length ? mapping : guessMapping(headers), delimiter };
}

/** A contact is importable when it has at least one valid email address. */
export function validEmails(c: ParsedContact): EmailEntry[] {
  const seen = new Set<string>();
  return c.emails.filter((e) => isEmail(e.email) && !seen.has(e.email) && !!seen.add(e.email));
}
