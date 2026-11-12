import { q, one, run, insertId } from './db.ts';
import { sha256 } from './crypto.ts';
import { getUserSetting } from './classify/settings.ts';
import { isViewing } from './mode.ts';
import { contactToVcard, parseVcards, type ParsedContact, type PhoneEntry, type EmailEntry } from './addressbook/formats.ts';

/**
 * Auto-built addressbook (DESIGN.md §10): everyone the user wrote to, and every sender
 * the user replied to. Never auto-created from unsolicited mail. Manageable in Settings,
 * exposed to phones via CardDAV.
 */

const MACHINE_LOCAL = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce[s]?|notifications?)([._+-]|$)/;
/** Addresses nobody writes to by hand (T8.11: never auto-saved). */
export function isMachineAddress(email: string): boolean {
  const lc = email.trim().toLowerCase();
  const local = lc.split('@')[0] ?? '';
  return !lc.includes('@') || MACHINE_LOCAL.test(local) || lc.includes('no-reply') || lc.includes('noreply');
}

/** The user's own addresses: accounts (with aliases) and identities. */
export async function ownAddresses(userId: number): Promise<Set<string>> {
  const out = new Set<string>();
  for (const a of await q<{ email: string; aliases: string }>('SELECT email, aliases FROM accounts WHERE user_id = ?', [userId])) {
    out.add(a.email.toLowerCase());
    try { for (const al of JSON.parse(a.aliases || '[]')) out.add(String(al).toLowerCase()); } catch { /* bad json */ }
  }
  for (const i of await q<{ email: string }>('SELECT email FROM identities WHERE user_id = ?', [userId])) out.add(i.email.toLowerCase());
  return out;
}

export async function autoSaveEnabled(userId: number): Promise<boolean> {
  return (await getUserSetting(userId, 'contacts_auto_save')) !== 'false';
}
export async function autoSaveRepliers(userId: number): Promise<boolean> {
  return (await getUserSetting(userId, 'contacts_save_repliers')) !== 'false';
}

export interface UpsertResult { id: number; created: boolean }

/**
 * Add one interaction to the addressbook, creating an auto-saved contact when needed.
 * `existing: 'touch'` (batch safety net) never bumps counts of a contact that already exists.
 */
export async function upsertContact(userId: number, email: string, name: string, kind: 'sent' | 'received', when: number,
  opts: { existing?: 'count' | 'touch'; own?: Set<string> } = {}): Promise<UpsertResult | null> {
  const lc = email.trim().toLowerCase();
  if (isMachineAddress(lc)) return null;
  if ((opts.own ?? await ownAddresses(userId)).has(lc)) return null;
  const existing = await one<{ id: number; display_name: string }>(`
    SELECT c.id, c.display_name FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
    WHERE c.user_id = ? AND ce.email = ?
  `, [userId, lc]);
  if (existing) {
    const bump = opts.existing === 'touch' ? '' : `${kind === 'sent' ? 'sent_count = sent_count + 1' : 'received_count = received_count + 1'},`;
    await run(`
      UPDATE contacts SET ${bump}
        last_interaction_at = GREATEST(COALESCE(last_interaction_at, 0), ?),
        display_name = CASE WHEN display_name = '' THEN ? ELSE display_name END,
        updated_at = ?
      WHERE id = ?
    `, [when, name, Date.now(), existing.id]);
    return { id: existing.id, created: false };
  }
  if (await one('SELECT 1 FROM contact_suppressed WHERE user_id = ? AND email = ?', [userId, lc])) return null;
  const id = await insertId(`
    INSERT INTO contacts(user_id, display_name, sent_count, received_count, last_interaction_at, auto_created, created_at, updated_at)
    VALUES (?,?,?,?,?,true,?,?)
  `, [userId, name, kind === 'sent' ? 1 : 0, kind === 'received' ? 1 : 0, when, Date.now(), Date.now()]);
  await run('INSERT INTO contact_emails(contact_id, email, is_primary) VALUES (?,?,true) ON CONFLICT DO NOTHING', [id, lc]);
  return { id, created: true };
}

export interface SavedContact { id: number; name: string; email: string }

/**
 * Instant auto-save after a message was accepted for sending (T8.11): every To/Cc/Bcc recipient, and the sender of the
 * message being replied to. Returns only the contacts this call created (for the "Saved to contacts · Undo" toast).
 */
export async function autoSaveAfterSend(userId: number, recipients: { name?: string; email: string }[], when: number,
  reply?: { fromEmail: string; fromName: string; listMail: boolean } | null): Promise<SavedContact[]> {
  if (isViewing() || !(await autoSaveEnabled(userId))) return [];
  const repliers = await autoSaveRepliers(userId);
  const own = await ownAddresses(userId);
  const replyFrom = reply?.fromEmail.trim().toLowerCase() ?? '';
  const created: SavedContact[] = [];
  const seen = new Set<string>();
  for (const r of recipients) {
    const lc = r.email.trim().toLowerCase();
    if (!lc || seen.has(lc)) continue;
    seen.add(lc);
    // replying to a mailing list or "also save senders I reply to" switched off: the original sender is not saved
    if (reply && lc === replyFrom && (!repliers || reply.listMail)) continue;
    const res = await upsertContact(userId, lc, r.name ?? '', 'sent', when, { own });
    if (res?.created) created.push({ id: res.id, name: r.name ?? '', email: lc });
  }
  if (reply && repliers && !reply.listMail && replyFrom && !seen.has(replyFrom)) {
    const res = await upsertContact(userId, replyFrom, reply.fromName, 'received', when, { own });
    if (res?.created) created.push({ id: res.id, name: reply.fromName, email: replyFrom });
  }
  return created;
}

/** Undo an auto-save: removes only a contact that is still auto-created, and remembers the address so it is not re-added. */
export async function undoAutoSave(userId: number, contactId: number): Promise<boolean> {
  const c = await one<{ id: number; auto_created: boolean }>('SELECT id, auto_created FROM contacts WHERE id = ? AND user_id = ?', [contactId, userId]);
  if (!c || !c.auto_created) return false;
  const emails = await q<{ email: string }>('SELECT email FROM contact_emails WHERE contact_id = ?', [contactId]);
  for (const e of emails) await run('INSERT INTO contact_suppressed(user_id, email, created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING', [userId, e.email, Date.now()]);
  await run('DELETE FROM contacts WHERE id = ? AND user_id = ?', [contactId, userId]);
  return true;
}

/**
 * Safety net: recipients of mail sent from other clients, and senders the user replied to. Creates missing contacts only
 * (the instant path already counted mail sent from Seamless). `userId` + `full` is the manual "Rebuild from mail".
 */
export async function harvestContacts(opts: { userId?: number; full?: boolean } = {}): Promise<number> {
  if (isViewing()) return 0;
  const lastRow = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'contacts_harvested_to'");
  const since = opts.full ? 0 : Number(lastRow?.value ?? 0);
  const now = Date.now();
  let n = 0;
  const enabled = new Map<number, boolean>();
  const owns = new Map<number, Set<string>>();
  const mine = new Set<number>();
  const ok = async (userId: number) => {
    if (!enabled.has(userId)) {
      // the manual rebuild is an explicit request, so it ignores the auto-save switch
      enabled.set(userId, opts.full ? true : await autoSaveEnabled(userId));
      owns.set(userId, await ownAddresses(userId));
    }
    return enabled.get(userId)!;
  };
  const touch = async (userId: number, email: string, name: string, kind: 'sent' | 'received', date: number) => {
    const r = await upsertContact(userId, email, name, kind, date, { existing: 'touch', own: owns.get(userId) });
    if (!r) return;
    if (r.created) mine.add(r.id);
    else if (mine.has(r.id)) await run(`UPDATE contacts SET ${kind === 'sent' ? 'sent_count = sent_count + 1' : 'received_count = received_count + 1'} WHERE id = ?`, [r.id]);
    n++;
  };

  const sent = await q<any>(`
    SELECT m.user_id, m.to_json, m.cc_json, m.date FROM messages m
    JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE mb.role = 'sent' AND m.created_at > ? ${opts.userId ? 'AND m.user_id = ?' : ''} ORDER BY m.date LIMIT 2000
  `, opts.userId ? [since, opts.userId] : [since]);
  for (const s of sent) {
    if (!(await ok(s.user_id))) continue;
    for (const a of [...JSON.parse(s.to_json), ...JSON.parse(s.cc_json)] as { name: string; email: string }[]) {
      await touch(s.user_id, a.email, a.name ?? '', 'sent', s.date);
    }
  }

  // senders the user replied to (never mailing-list / bulk mail)
  const answered = await q<any>(`
    SELECT m.user_id, m.from_addr, m.from_name, m.date FROM messages m
    JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.answered = true AND (mb.role IS NULL OR mb.role NOT IN ('sent','drafts','junk','trash'))
      AND m.is_newsletter = false AND m.list_unsubscribe IS NULL
      AND m.created_at > ? ${opts.userId ? 'AND m.user_id = ?' : ''} ORDER BY m.date LIMIT 2000
  `, opts.userId ? [since, opts.userId] : [since]);
  for (const a of answered) {
    if (!(await ok(a.user_id)) || !(await autoSaveRepliers(a.user_id))) continue;
    await touch(a.user_id, a.from_addr, a.from_name ?? '', 'received', a.date);
  }

  if (!opts.full) await run(`INSERT INTO settings(key, value) VALUES('contacts_harvested_to', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(now)]);
  return n;
}

export function startContactHarvest(): void {
  setInterval(() => { void harvestContacts().catch((e) => console.error('[contacts]', e?.message ?? e)); }, 10 * 60_000);
  setTimeout(() => { void harvestContacts().catch(() => {}); }, 20_000);
}

// ---------- list + vCard ----------

export interface ContactRow {
  id: number; display_name: string; org: string; notes: string;
  sent_count: number; received_count: number; last_interaction_at: number | null;
  auto_created: boolean; hidden: boolean; updated_at: number; no_business_guard: boolean;
  phones_json?: string;
  emails?: string[];
  emailsDetail?: { email: string; label: string; primary: boolean }[];
  phones?: PhoneEntry[];
  groupIds?: number[];
  groups?: string[];
}

export async function listContacts(userId: number, includeHidden = false): Promise<ContactRow[]> {
  const rows = await q<ContactRow>(`
    SELECT * FROM contacts WHERE user_id = ? ${includeHidden ? '' : 'AND hidden = false'}
    ORDER BY GREATEST(sent_count, received_count) DESC, display_name
  `, [userId]);
  const emails = await q<{ contact_id: number; email: string; label: string; is_primary: boolean }>(`
    SELECT ce.contact_id, ce.email, ce.label, ce.is_primary FROM contact_emails ce
    JOIN contacts c ON c.id = ce.contact_id WHERE c.user_id = ? ORDER BY ce.is_primary DESC, ce.email
  `, [userId]);
  const byId = new Map<number, { email: string; label: string; primary: boolean }[]>();
  for (const e of emails) {
    if (!byId.has(e.contact_id)) byId.set(e.contact_id, []);
    byId.get(e.contact_id)!.push({ email: e.email, label: e.label, primary: e.is_primary });
  }
  const gm = await q<{ contact_id: number; group_id: number; name: string }>(`
    SELECT m.contact_id, g.id AS group_id, g.name FROM contact_group_members m JOIN contact_groups g ON g.id = m.group_id WHERE g.user_id = ? ORDER BY g.name
  `, [userId]);
  const gById = new Map<number, { id: number; name: string }[]>();
  for (const g of gm) { if (!gById.has(g.contact_id)) gById.set(g.contact_id, []); gById.get(g.contact_id)!.push({ id: g.group_id, name: g.name }); }
  return rows.map((r) => {
    let phones: PhoneEntry[] = [];
    try { phones = JSON.parse(r.phones_json || '[]'); } catch { /* bad json */ }
    const det = byId.get(r.id) ?? [];
    return { ...r, emails: det.map((e) => e.email), emailsDetail: det, phones,
      groupIds: (gById.get(r.id) ?? []).map((g) => g.id), groups: (gById.get(r.id) ?? []).map((g) => g.name) };
  });
}

export function contactEtag(c: ContactRow): string {
  return sha256(`${c.id}:${c.updated_at}`).slice(0, 16);
}

export function rowToExport(c: ContactRow): ParsedContact & { id: number; updatedAt: number } {
  return {
    id: c.id, updatedAt: c.updated_at, displayName: c.display_name, org: c.org, notes: c.notes,
    emails: (c.emailsDetail ?? (c.emails ?? []).map((email) => ({ email, label: '', primary: false }))).map((e) => ({ email: e.email, label: e.label })),
    phones: c.phones ?? [], groups: c.groups ?? [],
  };
}

/** vCard 3.0 (groups as CATEGORIES, phones as TEL) — also what CardDAV serves. */
export function contactToVcf(c: ContactRow): string {
  return contactToVcard(rowToExport(c), `seamless-contact-${c.id}`);
}

/** vCard 2.1/3.0/4.0 parse. `emails` are plain strings for older callers; see parseVcards for the rich form. */
export function parseVcf(text: string): { displayName: string; org: string; notes: string; emails: string[]; phones: PhoneEntry[]; groups: string[]; emailEntries: EmailEntry[] }[] {
  return parseVcards(text).map((c) => ({ displayName: c.displayName, org: c.org, notes: c.notes, emails: c.emails.map((e) => e.email), phones: c.phones, groups: c.groups, emailEntries: c.emails }));
}
