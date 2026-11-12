/** Contact management (T8.11): create/edit, groups, merge, bulk actions, suggestions, import and export. All queries are per-user. */
import type { ApiContact, ApiContactGroup, ApiContactSuggestion } from '@seamless/shared';
import { editDistance, isEmail } from '@seamless/shared';
import { q, one, run, insertId } from '../db.ts';
import { autoSaveEnabled, listContacts, rowToExport, type ContactRow } from '../contacts.ts';
import {
  parseContactFile, parseVcards, serializeContacts, validEmails, type EmailEntry, type ExportFormat, type Mapping, type ParsedContact, type PhoneEntry,
} from './formats.ts';

export class ContactError extends Error {
  constructor(public statusCode: number, msg: string, public extra: Record<string, unknown> = {}) { super(msg); }
}

export function toApi(c: ContactRow): ApiContact {
  return {
    id: c.id, displayName: c.display_name, org: c.org, notes: c.notes, emails: c.emails ?? [],
    emailsDetail: c.emailsDetail ?? [], phones: c.phones ?? [], groupIds: c.groupIds ?? [],
    sentCount: c.sent_count, receivedCount: c.received_count,
    lastInteractionAt: c.last_interaction_at ? new Date(Number(c.last_interaction_at)).toISOString() : null,
    autoCreated: c.auto_created, hidden: c.hidden, noBusinessGuard: c.no_business_guard,
  };
}

const cleanPhones = (p: unknown): PhoneEntry[] => (Array.isArray(p) ? p : [])
  .map((x: any) => ({ label: ['mobile', 'home', 'work', 'other'].includes(x?.label) ? x.label : 'other', value: String(x?.value ?? '').trim() }))
  .filter((x) => x.value);
function cleanEmails(e: unknown): EmailEntry[] {
  const seen = new Set<string>();
  const out: EmailEntry[] = [];
  for (const x of Array.isArray(e) ? e : []) {
    const email = String(typeof x === 'string' ? x : x?.email ?? '').trim().toLowerCase();
    if (!email) continue;
    if (!isEmail(email)) throw new ContactError(400, `"${email}" is not a valid email address`);
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ email, label: ['work', 'home', 'other'].includes(x?.label) ? x.label : '' });
  }
  return out;
}

async function owner(userId: number, emails: string[], exceptId?: number): Promise<{ id: number; name: string; email: string } | null> {
  if (!emails.length) return null;
  const r = await one<{ id: number; display_name: string; email: string }>(`
    SELECT c.id, c.display_name, ce.email FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
    WHERE c.user_id = ? AND ce.email = ANY(?) ${exceptId ? 'AND c.id <> ?' : ''} LIMIT 1
  `, exceptId ? [userId, emails, exceptId] : [userId, emails]);
  return r ? { id: r.id, name: r.display_name, email: r.email } : null;
}

async function writeEmails(contactId: number, emails: EmailEntry[]): Promise<void> {
  await run('DELETE FROM contact_emails WHERE contact_id = ?', [contactId]);
  for (let i = 0; i < emails.length; i++) {
    await run('INSERT INTO contact_emails(contact_id, email, is_primary, label) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', [contactId, emails[i].email, i === 0, emails[i].label]);
  }
}

async function ownGroupIds(userId: number, ids: unknown): Promise<number[]> {
  const want = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
  if (!want.length) return [];
  return (await q<{ id: number }>('SELECT id FROM contact_groups WHERE user_id = ? AND id = ANY(?)', [userId, want])).map((r) => r.id);
}
async function writeGroups(userId: number, contactId: number, groupIds: unknown): Promise<void> {
  const ids = await ownGroupIds(userId, groupIds);
  await run('DELETE FROM contact_group_members WHERE contact_id = ?', [contactId]);
  for (const g of ids) await run('INSERT INTO contact_group_members(group_id, contact_id) VALUES (?,?) ON CONFLICT DO NOTHING', [g, contactId]);
}

export interface ContactInput {
  displayName?: string; org?: string; notes?: string; hidden?: boolean; noBusinessGuard?: boolean;
  emails?: unknown; phones?: unknown; groupIds?: unknown;
}

export async function createContact(userId: number, b: ContactInput): Promise<number> {
  const emails = cleanEmails(b.emails);
  const name = String(b.displayName ?? '').trim();
  if (!emails.length && !name) throw new ContactError(400, 'Add a name or an email address');
  const dup = await owner(userId, emails.map((e) => e.email));
  if (dup) throw new ContactError(409, `${dup.email} already belongs to ${dup.name || 'another contact'}`, { existingId: dup.id });
  const now = Date.now();
  const id = await insertId(`INSERT INTO contacts(user_id, display_name, org, notes, phones_json, hidden, auto_created, created_at, updated_at) VALUES (?,?,?,?,?,?,false,?,?)`,
    [userId, name, String(b.org ?? ''), String(b.notes ?? ''), JSON.stringify(cleanPhones(b.phones)), !!b.hidden, now, now]);
  await writeEmails(id, emails);
  await writeGroups(userId, id, b.groupIds);
  // adding by hand lifts a "removed by Undo" memory for these addresses
  if (emails.length) await run('DELETE FROM contact_suppressed WHERE user_id = ? AND email = ANY(?)', [userId, emails.map((e) => e.email)]);
  return id;
}

/** Partial update: only the fields present in `b` change. Saving by hand makes an auto-saved contact "mine". */
export async function updateContact(userId: number, id: number, b: ContactInput): Promise<void> {
  const cur = await one<{ id: number }>('SELECT id FROM contacts WHERE id = ? AND user_id = ?', [id, userId]);
  if (!cur) throw new ContactError(404, 'Contact not found');
  const sets: string[] = ['auto_created = false', 'updated_at = ?'];
  const vals: unknown[] = [Date.now()];
  const set = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  if (b.displayName !== undefined) set('display_name', String(b.displayName));
  if (b.org !== undefined) set('org', String(b.org));
  if (b.notes !== undefined) set('notes', String(b.notes));
  if (b.hidden !== undefined) set('hidden', !!b.hidden);
  if (b.noBusinessGuard !== undefined) set('no_business_guard', !!b.noBusinessGuard);
  if (b.phones !== undefined) set('phones_json', JSON.stringify(cleanPhones(b.phones)));
  if (b.emails !== undefined) {
    const emails = cleanEmails(b.emails);
    const dup = await owner(userId, emails.map((e) => e.email), id);
    if (dup) throw new ContactError(409, `${dup.email} already belongs to ${dup.name || 'another contact'}`, { existingId: dup.id });
    await writeEmails(id, emails);
  }
  if (b.groupIds !== undefined) await writeGroups(userId, id, b.groupIds);
  await run(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, [...vals, id, userId]);
}

export async function promoteContact(userId: number, id: number): Promise<boolean> {
  return (await run('UPDATE contacts SET auto_created = false, updated_at = ? WHERE id = ? AND user_id = ?', [Date.now(), id, userId])) > 0;
}

// ---------- listing ----------

export type ContactFilter = 'all' | 'mine' | 'auto' | 'hidden' | 'business';
export async function queryContacts(userId: number, o: { filter?: ContactFilter | ''; sort?: string; q?: string; groupId?: number; hiddenToo?: boolean } = {}): Promise<ContactRow[]> {
  let rows = await listContacts(userId, o.filter ? true : !!o.hiddenToo);
  const f = o.filter;
  if (f === 'mine') rows = rows.filter((c) => !c.auto_created && !c.hidden);
  else if (f === 'auto') rows = rows.filter((c) => c.auto_created && !c.hidden);
  else if (f === 'hidden') rows = rows.filter((c) => c.hidden);
  else if (f === 'business') rows = rows.filter((c) => c.org !== '');
  if (o.groupId) rows = rows.filter((c) => c.groupIds?.includes(o.groupId!));
  const term = (o.q ?? '').trim().toLowerCase();
  if (term) {
    const words = term.split(/\s+/);
    rows = rows.filter((c) => { const hay = `${c.display_name} ${c.org} ${(c.emails ?? []).join(' ')}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  }
  const used = (c: ContactRow) => c.sent_count + c.received_count;
  if (o.sort === 'name') rows.sort((a, b) => (a.display_name || a.emails?.[0] || '~').localeCompare(b.display_name || b.emails?.[0] || '~', undefined, { sensitivity: 'base' }));
  else if (o.sort === 'recent') rows.sort((a, b) => Number(b.last_interaction_at ?? 0) - Number(a.last_interaction_at ?? 0));
  else if (o.sort === 'used') rows.sort((a, b) => used(b) - used(a));
  return rows;
}

// ---------- groups ----------

export async function listGroups(userId: number): Promise<ApiContactGroup[]> {
  return (await q<any>(`
    SELECT g.id, g.name, COUNT(m.contact_id)::int AS n FROM contact_groups g LEFT JOIN contact_group_members m ON m.group_id = g.id
    WHERE g.user_id = ? GROUP BY g.id ORDER BY lower(g.name)
  `, [userId])).map((g) => ({ id: g.id, name: g.name, memberCount: g.n }));
}
export async function groupByName(userId: number, name: string, create: boolean): Promise<number | null> {
  const n = name.trim();
  if (!n) return null;
  const have = await one<{ id: number }>('SELECT id FROM contact_groups WHERE user_id = ? AND lower(name) = lower(?)', [userId, n]);
  if (have) return have.id;
  return create ? insertId('INSERT INTO contact_groups(user_id, name, created_at) VALUES (?,?,?)', [userId, n, Date.now()]) : null;
}
export async function createGroup(userId: number, name: string): Promise<number> {
  const n = name.trim();
  if (!n) throw new ContactError(400, 'Give the group a name');
  if (await groupByName(userId, n, false)) throw new ContactError(409, 'A group with that name already exists');
  return (await groupByName(userId, n, true))!;
}
export async function renameGroup(userId: number, id: number, name: string): Promise<void> {
  const n = name.trim();
  if (!n) throw new ContactError(400, 'Give the group a name');
  const clash = await groupByName(userId, n, false);
  if (clash && clash !== id) throw new ContactError(409, 'A group with that name already exists');
  await run('UPDATE contact_groups SET name = ? WHERE id = ? AND user_id = ?', [n, id, userId]);
}
export async function deleteGroup(userId: number, id: number): Promise<void> {
  await run('DELETE FROM contact_groups WHERE id = ? AND user_id = ?', [id, userId]);
}
export async function groupMembers(userId: number, groupId: number): Promise<{ name: string; email: string }[]> {
  return (await q<any>(`
    SELECT c.display_name AS name, (SELECT email FROM contact_emails WHERE contact_id = c.id ORDER BY is_primary DESC, email LIMIT 1) AS email
    FROM contact_group_members m JOIN contact_groups g ON g.id = m.group_id JOIN contacts c ON c.id = m.contact_id
    WHERE g.id = ? AND g.user_id = ? AND c.hidden = false ORDER BY c.display_name
  `, [groupId, userId])).filter((r) => r.email);
}

// ---------- duplicates + merge ----------

export interface DuplicatePair { a: number; b: number; reason: 'email' | 'name' }
export async function findDuplicates(userId: number): Promise<DuplicatePair[]> {
  const rows = await listContacts(userId, true);
  const pairs: DuplicatePair[] = [];
  const seen = new Set<string>();
  const add = (x: ContactRow, y: ContactRow, reason: DuplicatePair['reason']) => {
    const k = [x.id, y.id].sort().join('-');
    if (x.id === y.id || seen.has(k)) return;
    seen.add(k); pairs.push({ a: Math.min(x.id, y.id), b: Math.max(x.id, y.id), reason });
  };
  const byEmail = new Map<string, ContactRow>();
  const byName = new Map<string, ContactRow>();
  for (const c of rows) {
    for (const e of c.emails ?? []) { const o = byEmail.get(e); if (o) add(o, c, 'email'); else byEmail.set(e, c); }
    const n = c.display_name.trim().toLowerCase().replace(/\s+/g, ' ');
    if (n.includes(' ') || n.length > 5) { const o = byName.get(n); if (o) add(o, c, 'name'); else byName.set(n, c); }
  }
  return pairs;
}

/** Fold `mergeId` into `keepId`: every email, phone and group is kept, counts add up. */
export async function mergeContacts(userId: number, keepId: number, mergeId: number): Promise<void> {
  if (keepId === mergeId) throw new ContactError(400, 'Pick two different contacts');
  const rows = (await listContacts(userId, true)).filter((c) => c.id === keepId || c.id === mergeId);
  const keep = rows.find((c) => c.id === keepId); const gone = rows.find((c) => c.id === mergeId);
  if (!keep || !gone) throw new ContactError(404, 'Contact not found');
  const emails = [...(keep.emailsDetail ?? [])];
  for (const e of gone.emailsDetail ?? []) if (!emails.some((x) => x.email === e.email)) emails.push({ ...e, primary: false });
  const digits = (s: string) => s.replace(/\D/g, '');
  const phones = [...(keep.phones ?? [])];
  for (const p of gone.phones ?? []) if (!phones.some((x) => digits(x.value) === digits(p.value))) phones.push(p);
  const notes = keep.notes && gone.notes && keep.notes !== gone.notes ? `${keep.notes}\n${gone.notes}` : keep.notes || gone.notes;
  await writeEmails(keepId, emails.map((e) => ({ email: e.email, label: e.label })));
  for (const g of gone.groupIds ?? []) await run('INSERT INTO contact_group_members(group_id, contact_id) VALUES (?,?) ON CONFLICT DO NOTHING', [g, keepId]);
  await run(`UPDATE contacts SET display_name = ?, org = ?, notes = ?, phones_json = ?, sent_count = ?, received_count = ?,
      last_interaction_at = ?, auto_created = ?, hidden = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    [keep.display_name || gone.display_name, keep.org || gone.org, notes, JSON.stringify(phones),
      keep.sent_count + gone.sent_count, keep.received_count + gone.received_count,
      Math.max(Number(keep.last_interaction_at ?? 0), Number(gone.last_interaction_at ?? 0)) || null,
      keep.auto_created && gone.auto_created, keep.hidden && gone.hidden, Date.now(), keepId, userId]);
  await run('DELETE FROM contacts WHERE id = ? AND user_id = ?', [mergeId, userId]);
}

// ---------- bulk ----------

export async function bulkAction(userId: number, ids: number[], action: string, groupId?: number): Promise<number> {
  const mine = (await q<{ id: number }>('SELECT id FROM contacts WHERE user_id = ? AND id = ANY(?)', [userId, ids])).map((r) => r.id);
  if (!mine.length) return 0;
  const now = Date.now();
  switch (action) {
    case 'delete': await run('DELETE FROM contacts WHERE user_id = ? AND id = ANY(?)', [userId, mine]); break;
    case 'hide': await run('UPDATE contacts SET hidden = true, updated_at = ? WHERE user_id = ? AND id = ANY(?)', [now, userId, mine]); break;
    case 'unhide': await run('UPDATE contacts SET hidden = false, updated_at = ? WHERE user_id = ? AND id = ANY(?)', [now, userId, mine]); break;
    case 'promote': await run('UPDATE contacts SET auto_created = false, updated_at = ? WHERE user_id = ? AND id = ANY(?)', [now, userId, mine]); break;
    case 'addToGroup': case 'removeFromGroup': {
      const g = (await ownGroupIds(userId, [groupId]))[0];
      if (!g) throw new ContactError(404, 'Group not found');
      for (const id of mine) {
        if (action === 'addToGroup') await run('INSERT INTO contact_group_members(group_id, contact_id) VALUES (?,?) ON CONFLICT DO NOTHING', [g, id]);
        else await run('DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ?', [g, id]);
      }
      await run('UPDATE contacts SET updated_at = ? WHERE user_id = ? AND id = ANY(?)', [now, userId, mine]);
      break;
    }
    default: throw new ContactError(400, 'Unknown action');
  }
  return mine.length;
}

export async function deleteAutoSaved(userId: number): Promise<number> {
  return run('DELETE FROM contacts WHERE user_id = ? AND auto_created = true', [userId]);
}

// ---------- detail / lookup ----------

export async function recentConversations(userId: number, id: number) {
  const c = (await listContacts(userId, true)).find((x) => x.id === id);
  if (!c) throw new ContactError(404, 'Contact not found');
  const emails = c.emails ?? [];
  const rows = await q<any>(`
    SELECT id, subject, date, from_addr, from_name FROM messages
    WHERE user_id = ? AND (lower(from_addr) = ANY(?) OR EXISTS (SELECT 1 FROM unnest(?::text[]) e WHERE to_json ILIKE '%' || e || '%'))
    ORDER BY date DESC LIMIT 8
  `, [userId, emails, emails]);
  return { contact: toApi(c), conversations: rows.map((r) => ({ id: `m${r.id}`, subject: r.subject, date: Number(r.date), from: r.from_name || r.from_addr })) };
}

export async function lookupByEmail(userId: number, email: string): Promise<ApiContact | null> {
  const lc = email.trim().toLowerCase();
  const hit = await one<{ id: number }>('SELECT c.id FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id WHERE c.user_id = ? AND ce.email = ?', [userId, lc]);
  if (!hit) return null;
  const c = (await listContacts(userId, true)).find((x) => x.id === hit.id);
  return c ? toApi(c) : null;
}

/** "Add to contacts" in the reading pane: a saved (not auto-saved) contact in one click. */
export async function addSenderToContacts(userId: number, email: string, name: string): Promise<number> {
  const lc = email.trim().toLowerCase();
  if (!isEmail(lc)) throw new ContactError(400, 'Not an email address');
  const have = await one<{ id: number }>('SELECT c.id FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id WHERE c.user_id = ? AND ce.email = ?', [userId, lc]);
  if (have) { await promoteContact(userId, have.id); return have.id; }
  return createContact(userId, { displayName: name, emails: [{ email: lc }] });
}

// ---------- autocomplete ----------

export async function suggest(userId: number, term: string): Promise<ApiContactSuggestion[]> {
  const t = term.trim().toLowerCase();
  if (!t) return [];
  const words = t.split(/\s+/).filter(Boolean);
  const showOther = await autoSaveEnabled(userId);
  const conds = words.map(() => '(lower(c.display_name) LIKE ? OR ce.email LIKE ? OR lower(c.org) LIKE ?)').join(' AND ');
  const params: unknown[] = [userId];
  for (const w of words) params.push(`%${w}%`, `%${w}%`, `%${w}%`);
  const rows = await q<any>(`
    SELECT c.id, c.display_name, c.org, c.sent_count, c.received_count, c.last_interaction_at, c.auto_created, ce.email, ce.is_primary
    FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
    WHERE c.user_id = ? AND c.hidden = false ${showOther ? '' : 'AND c.auto_created = false'} AND ${conds} LIMIT 60
  `, params);
  const now = Date.now();
  const score = (r: any) => {
    const freq = Math.log(2 + r.sent_count * 2 + r.received_count);
    const days = r.last_interaction_at ? Math.max(0, (now - Number(r.last_interaction_at)) / 86_400_000) : 365;
    const recency = 0.4 + 0.6 * Math.exp(-days / 60);
    const name = String(r.display_name).toLowerCase();
    const prefix = name.startsWith(t) || r.email.startsWith(t) || name.split(/\s+/).some((w: string) => w.startsWith(words[0])) ? 0.8 : 0;
    return freq * recency + prefix + (r.is_primary ? 0.05 : 0) + (r.auto_created ? 0 : 0.3);
  };
  rows.sort((a, b) => score(b) - score(a));
  const out: ApiContactSuggestion[] = [];
  const seen = new Set<string>();
  const groups = await q<{ id: number; name: string }>('SELECT id, name FROM contact_groups WHERE user_id = ? AND lower(name) LIKE ? ORDER BY name LIMIT 3', [userId, `%${t}%`]);
  for (const g of groups) {
    const members = await groupMembers(userId, g.id);
    if (members.length) out.push({ type: 'group', name: g.name, email: '', members });
  }
  for (const r of rows) {
    if (seen.has(r.email)) continue;
    seen.add(r.email);
    out.push({ type: 'contact', name: r.display_name, email: r.email, org: r.org || undefined, other: r.auto_created });
    if (out.length >= 8) break;
  }
  return out;
}

/** Typo guard for a typed address that has never been used. */
export async function checkAddress(userId: number, email: string, name: string): Promise<{ known: boolean; warning?: { reason: 'name' | 'similar'; name: string; email: string } }> {
  const lc = email.trim().toLowerCase();
  if (!isEmail(lc)) return { known: false };
  if (await one('SELECT 1 FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id WHERE c.user_id = ? AND ce.email = ?', [userId, lc])) return { known: true };
  const nm = name.trim().toLowerCase();
  if (nm) {
    const hit = await one<{ display_name: string; email: string }>(`
      SELECT c.display_name, ce.email FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
      WHERE c.user_id = ? AND lower(c.display_name) = ? ORDER BY ce.is_primary DESC LIMIT 1`, [userId, nm]);
    if (hit) return { known: false, warning: { reason: 'name', name: hit.display_name, email: hit.email } };
  }
  const all = await q<{ display_name: string; email: string }>(`
    SELECT c.display_name, ce.email FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
    WHERE c.user_id = ? AND (c.sent_count > 0 OR c.auto_created = false)`, [userId]);
  let best: { display_name: string; email: string; d: number } | null = null;
  for (const c of all) {
    if (c.email.length < 8) continue;
    const d = editDistance(lc, c.email, 2);
    if (d > 0 && d <= 2 && (!best || d < best.d)) best = { ...c, d };
  }
  return best ? { known: false, warning: { reason: 'similar', name: best.display_name, email: best.email } } : { known: false };
}

// ---------- import ----------

export type ImportMode = 'skip' | 'merge' | 'fill' | 'replace';
export interface ImportReport {
  preview: boolean; kind: string; flavor?: string; headers?: string[]; mapping?: Mapping;
  total: number; created: number; merged: number; duplicates: number; invalid: number; skipped: number;
  groupsCreated: string[]; skippedRows: { row: number; reason: string; name: string; email: string }[];
  sample: { name: string; emails: string[]; phones: string[]; org: string; groups: string[]; status: 'new' | 'duplicate' | 'invalid' }[];
}

async function findByEmails(userId: number, emails: string[]): Promise<ContactRow | null> {
  const hit = await owner(userId, emails);
  return hit ? ((await listContacts(userId, true)).find((c) => c.id === hit.id) ?? null) : null;
}

export async function importContacts(userId: number, contacts: (ParsedContact | null)[], o: { mode: ImportMode; dryRun?: boolean; kind?: string }): Promise<ImportReport> {
  const rep: ImportReport = { preview: !!o.dryRun, kind: o.kind ?? 'vcf', total: 0, created: 0, merged: 0, duplicates: 0, invalid: 0, skipped: 0, groupsCreated: [], skippedRows: [], sample: [] };
  const seenInFile = new Set<string>();
  const newGroups = new Set<string>();
  const sample = (c: ParsedContact, status: 'new' | 'duplicate' | 'invalid') => {
    if (rep.sample.length < 8) rep.sample.push({ name: c.displayName, emails: c.emails.map((e) => e.email), phones: c.phones.map((p) => p.value), org: c.org, groups: c.groups, status });
  };
  const existingGroups = new Set((await listGroups(userId)).map((g) => g.name.toLowerCase()));
  let idx = 0;
  for (const c of contacts) {
    idx++;
    if (!c) continue;
    rep.total++;
    const emails = validEmails(c);
    const rowNo = idx + (o.kind === 'csv' ? 1 : 0);
    if (!emails.length) {
      rep.invalid++; rep.skipped++;
      rep.skippedRows.push({ row: rowNo, reason: c.emails.length ? 'invalid email address' : 'no email address', name: c.displayName, email: c.emails[0]?.email ?? '' });
      sample(c, 'invalid');
      continue;
    }
    const known = emails.map((e) => e.email);
    const inFile = known.some((e) => seenInFile.has(e));
    known.forEach((e) => seenInFile.add(e));
    const existing = await findByEmails(userId, known);
    for (const g of c.groups) if (!existingGroups.has(g.toLowerCase())) newGroups.add(g);

    if (existing || inFile) {
      rep.duplicates++;
      sample(c, 'duplicate');
      if (o.mode === 'skip' || !existing) {
        rep.skipped++; rep.skippedRows.push({ row: rowNo, reason: 'duplicate', name: c.displayName, email: emails[0].email });
        continue;
      }
      if (o.dryRun) { rep.merged++; continue; }
      const patch: ContactInput = {};
      const digits = (s: string) => s.replace(/\D/g, '');
      if (o.mode === 'replace') {
        patch.displayName = c.displayName; patch.org = c.org; patch.notes = c.notes;
      } else {
        if (!existing!.display_name && c.displayName) patch.displayName = c.displayName;
        if (!existing!.org && c.org) patch.org = c.org;
        if (!existing!.notes && c.notes) patch.notes = c.notes;
      }
      if (o.mode !== 'fill') {
        const have = existing!.emailsDetail ?? [];
        const allEmails = [...have.map((e) => ({ email: e.email, label: e.label })), ...emails.filter((e) => !have.some((h) => h.email === e.email))];
        if (allEmails.length !== have.length) patch.emails = allEmails;
        const ph = [...(existing!.phones ?? [])];
        for (const p of c.phones) if (!ph.some((x) => digits(x.value) === digits(p.value))) ph.push(p);
        if (ph.length !== (existing!.phones ?? []).length) patch.phones = ph;
        const gids = new Set(existing!.groupIds ?? []);
        for (const g of c.groups) gids.add((await groupByName(userId, g, true))!);
        if (gids.size !== (existing!.groupIds ?? []).length) patch.groupIds = [...gids];
      }
      await updateContact(userId, existing!.id, patch);
      rep.merged++;
      continue;
    }

    sample(c, 'new');
    rep.created++;
    if (o.dryRun) continue;
    const gids: number[] = [];
    for (const g of c.groups) gids.push((await groupByName(userId, g, true))!);
    await createContact(userId, { displayName: c.displayName, org: c.org, notes: c.notes, emails, phones: c.phones, groupIds: gids });
  }
  rep.groupsCreated = [...newGroups];
  return rep;
}

/** Parse an uploaded file and import (or preview) it. */
export async function importFile(userId: number, buf: Buffer, o: { mode: ImportMode; dryRun?: boolean; mapping?: Mapping }): Promise<ImportReport> {
  const parsed = parseContactFile(buf, o.mapping);
  const rep = await importContacts(userId, parsed.contacts, { mode: o.mode, dryRun: o.dryRun, kind: parsed.kind });
  rep.flavor = parsed.flavor; rep.headers = parsed.headers; rep.mapping = parsed.mapping;
  return rep;
}

/** CardDAV PUT and the old .vcf import: contacts from the phone replace name/org/notes and add emails/phones. */
export async function importVcf(userId: number, text: string): Promise<number> {
  const rep = await importContacts(userId, parseVcards(text), { mode: 'replace' });
  return rep.created;
}

// ---------- export ----------

export async function exportContacts(userId: number, o: { format: ExportFormat; ids?: number[]; groupId?: number; filter?: ContactFilter | '' }) {
  let rows = await queryContacts(userId, { filter: o.filter || 'all', groupId: o.groupId, sort: 'name' });
  if (o.ids?.length) rows = rows.filter((c) => o.ids!.includes(c.id));
  return serializeContacts(rows.map(rowToExport), o.format);
}
