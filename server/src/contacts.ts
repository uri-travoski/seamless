import { q, one, run, insertId } from './db.ts';
import { sha256 } from './crypto.ts';

/**
 * Auto-built addressbook (DESIGN.md §10): everyone the user wrote to, and every sender
 * the user replied to. Never auto-created from unsolicited mail. Manageable in Settings,
 * exposed to phones via CardDAV.
 */

async function upsertContact(userId: number, email: string, name: string, kind: 'sent' | 'received', when: number): Promise<void> {
  const lc = email.trim().toLowerCase();
  if (!lc.includes('@') || lc.includes('no-reply') || lc.includes('noreply')) return;
  const existing = await one<{ id: number; display_name: string }>(`
    SELECT c.id, c.display_name FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
    WHERE c.user_id = ? AND ce.email = ?
  `, [userId, lc]);
  if (existing) {
    await run(`
      UPDATE contacts SET ${kind === 'sent' ? 'sent_count = sent_count + 1' : 'received_count = received_count + 1'},
        last_interaction_at = GREATEST(COALESCE(last_interaction_at, 0), ?),
        display_name = CASE WHEN display_name = '' THEN ? ELSE display_name END,
        updated_at = ?
      WHERE id = ?
    `, [when, name, Date.now(), existing.id]);
    return;
  }
  const id = await insertId(`
    INSERT INTO contacts(user_id, display_name, sent_count, received_count, last_interaction_at, auto_created, created_at, updated_at)
    VALUES (?,?,?,?,?,true,?,?)
  `, [userId, name, kind === 'sent' ? 1 : 0, kind === 'received' ? 1 : 0, when, Date.now(), Date.now()]);
  await run('INSERT INTO contact_emails(contact_id, email, is_primary) VALUES (?,?,true) ON CONFLICT DO NOTHING', [id, lc]);
}

/** Incremental harvest since the last run (tracked in settings). */
export async function harvestContacts(): Promise<number> {
  const lastRow = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'contacts_harvested_to'");
  const since = Number(lastRow?.value ?? 0);
  const now = Date.now();
  let n = 0;

  // recipients of sent mail
  const sent = await q<any>(`
    SELECT m.user_id, m.to_json, m.cc_json, m.date FROM messages m
    JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE mb.role = 'sent' AND m.created_at > ? LIMIT 2000
  `, [since]);
  for (const s of sent) {
    for (const a of [...JSON.parse(s.to_json), ...JSON.parse(s.cc_json)] as { name: string; email: string }[]) {
      await upsertContact(s.user_id, a.email, a.name ?? '', 'sent', s.date);
      n++;
    }
  }

  // senders the user replied to
  const answered = await q<any>(`
    SELECT m.user_id, m.from_addr, m.from_name, m.date FROM messages m
    JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.answered = true AND (mb.role IS NULL OR mb.role NOT IN ('sent','drafts','junk','trash'))
      AND m.created_at > ? LIMIT 2000
  `, [since]);
  for (const a of answered) {
    await upsertContact(a.user_id, a.from_addr, a.from_name ?? '', 'received', a.date);
    n++;
  }

  await run(`INSERT INTO settings(key, value) VALUES('contacts_harvested_to', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(now)]);
  return n;
}

export function startContactHarvest(): void {
  setInterval(() => { void harvestContacts().catch((e) => console.error('[contacts]', e?.message ?? e)); }, 10 * 60_000);
  setTimeout(() => { void harvestContacts().catch(() => {}); }, 20_000);
}

// ---------- vCard ----------

export interface ContactRow {
  id: number; display_name: string; org: string; notes: string;
  sent_count: number; received_count: number; last_interaction_at: number | null;
  auto_created: boolean; hidden: boolean; updated_at: number;
  emails?: string[];
}

export async function listContacts(userId: number, includeHidden = false): Promise<ContactRow[]> {
  const rows = await q<ContactRow>(`
    SELECT * FROM contacts WHERE user_id = ? ${includeHidden ? '' : 'AND hidden = false'}
    ORDER BY GREATEST(sent_count, received_count) DESC, display_name
  `, [userId]);
  const emails = await q<{ contact_id: number; email: string }>(`
    SELECT ce.contact_id, ce.email FROM contact_emails ce
    JOIN contacts c ON c.id = ce.contact_id WHERE c.user_id = ?
  `, [userId]);
  const byId = new Map<number, string[]>();
  for (const e of emails) {
    if (!byId.has(e.contact_id)) byId.set(e.contact_id, []);
    byId.get(e.contact_id)!.push(e.email);
  }
  return rows.map((r) => ({ ...r, emails: byId.get(r.id) ?? [] }));
}

export function contactEtag(c: ContactRow): string {
  return sha256(`${c.id}:${c.updated_at}`).slice(0, 16);
}

const vesc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

export function contactToVcf(c: ContactRow): string {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `UID:seamless-contact-${c.id}`,
    `FN:${vesc(c.display_name || c.emails?.[0] || 'Unknown')}`,
    `N:${vesc(c.display_name)};;;;`,
    ...(c.org ? [`ORG:${vesc(c.org)}`] : []),
    ...(c.notes ? [`NOTE:${vesc(c.notes)}`] : []),
    ...(c.emails ?? []).map((e, i) => `EMAIL;TYPE=INTERNET${i === 0 ? ';TYPE=PREF' : ''}:${e}`),
    `REV:${new Date(c.updated_at).toISOString()}`,
    'END:VCARD',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Minimal vCard 3.0/4.0 parse: FN, ORG, NOTE, EMAIL lines. */
export function parseVcf(text: string): { displayName: string; org: string; notes: string; emails: string[] }[] {
  const out: { displayName: string; org: string; notes: string; emails: string[] }[] = [];
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  for (const block of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    const get = (name: string) => block.match(new RegExp(`^${name}[^:]*:(.*)$`, 'im'))?.[1]?.trim() ?? '';
    const emails = [...block.matchAll(/^EMAIL[^:]*:(.+)$/gim)].map((m) => m[1].trim().toLowerCase()).filter((e) => e.includes('@'));
    out.push({
      displayName: get('FN').replace(/\\,/g, ',').replace(/\\;/g, ';'),
      org: get('ORG').replace(/;+$/, ''),
      notes: get('NOTE'),
      emails,
    });
  }
  return out.filter((c) => c.emails.length > 0 || c.displayName);
}

export async function importVcf(userId: number, text: string): Promise<number> {
  const cards = parseVcf(text);
  let created = 0;
  for (const card of cards) {
    const primary = card.emails[0];
    const existing = primary ? await one<{ id: number }>(`
      SELECT c.id FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
      WHERE c.user_id = ? AND ce.email = ?
    `, [userId, primary]) : null;
    if (existing) {
      await run('UPDATE contacts SET display_name = ?, org = ?, notes = ?, auto_created = false, updated_at = ? WHERE id = ?',
        [card.displayName, card.org, card.notes, Date.now(), existing.id]);
      for (const e of card.emails) {
        await run('INSERT INTO contact_emails(contact_id, email, is_primary) VALUES (?,?,false) ON CONFLICT DO NOTHING', [existing.id, e]);
      }
    } else {
      const id = await insertId('INSERT INTO contacts(user_id, display_name, org, notes, auto_created, created_at, updated_at) VALUES (?,?,?,?,false,?,?)',
        [userId, card.displayName, card.org, card.notes, Date.now(), Date.now()]);
      for (let i = 0; i < card.emails.length; i++) {
        await run('INSERT INTO contact_emails(contact_id, email, is_primary) VALUES (?,?,?) ON CONFLICT DO NOTHING', [id, card.emails[i], i === 0]);
      }
      created++;
    }
  }
  return created;
}
