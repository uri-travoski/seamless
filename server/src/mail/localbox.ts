/**
 * Local mailboxes for accounts with no IMAP server (POP3, push inbound). The mailbox rows
 * live only in our DB (`path` prefixed `local:`); messages get a synthetic uid per mailbox.
 */
import { q, one, run } from '../db.ts';
import { ingestMessage, type IngestResult } from './ingest.ts';

export const LOCAL_ROLES: { role: string; name: string; path: string }[] = [
  { role: 'inbox', name: 'Inbox', path: 'local:INBOX' },
  { role: 'sent', name: 'Sent', path: 'local:Sent' },
  { role: 'drafts', name: 'Drafts', path: 'local:Drafts' },
  { role: 'trash', name: 'Trash', path: 'local:Trash' },
  { role: 'junk', name: 'Junk', path: 'local:Junk' },
  { role: 'archive', name: 'Archive', path: 'local:Archive' },
];

export async function isLocalAccount(accountId: number): Promise<boolean> {
  const r = await one<{ inbound_kind: string }>('SELECT inbound_kind FROM accounts WHERE id = ?', [accountId]);
  return !!r && r.inbound_kind !== 'imap';
}

/** Create the standard folders for a local account (idempotent). */
export async function ensureLocalMailboxes(accountId: number): Promise<void> {
  for (const m of LOCAL_ROLES) {
    await run(
      `INSERT INTO mailboxes(account_id, path, delimiter, role, name) VALUES (?,?,'/',?,?) ON CONFLICT (account_id, path) DO NOTHING`,
      [accountId, m.path, m.role, m.name]);
  }
}

/** Atomically reserve the next uid of a mailbox. */
export async function nextLocalUid(mailboxId: number): Promise<number> {
  const r = await one<{ uid: number }>('UPDATE mailboxes SET next_uid = next_uid + 1 WHERE id = ? RETURNING next_uid - 1 AS uid', [mailboxId]);
  if (!r) throw new Error(`no such mailbox ${mailboxId}`);
  return Number(r.uid);
}

export async function localMailboxId(accountId: number, role: string): Promise<number | null> {
  await ensureLocalMailboxes(accountId);
  const r = await one<{ id: number }>('SELECT id FROM mailboxes WHERE account_id = ? AND role = ? ORDER BY id LIMIT 1', [accountId, role]);
  return r?.id ?? null;
}

/** Store a raw message in a local mailbox (by role). Live inbox mail runs filters, risk, etc. like IMAP mail. */
export async function ingestLocal(
  accountId: number, role: string, raw: Buffer,
  opts: { isLive?: boolean; flags?: string[]; internalDate?: Date } = {},
): Promise<IngestResult | null> {
  const mailboxId = await localMailboxId(accountId, role);
  if (!mailboxId) return null;
  const flags = new Set(opts.flags ?? (role === 'sent' || role === 'drafts' ? ['\\Seen'] : []));
  if (role === 'drafts') flags.add('\\Draft');
  const result = await ingestMessage({
    accountId, mailboxId, uid: await nextLocalUid(mailboxId), raw, flags,
    internalDate: opts.internalDate ?? new Date(), isLive: !!opts.isLive,
  });
  if (result?.isInboxLive) {
    // filter move/delete actions apply locally (IMAP accounts queue a server-side move instead)
    const move = result.filterActions.find((a) => a.type === 'move' || a.type === 'delete');
    if (move) {
      const target = await localMailboxId(accountId, move.type === 'delete' ? 'trash' : String(move.value));
      if (target) {
        await run('UPDATE messages SET mailbox_id = ?, uid = ? WHERE id = ?', [target, await nextLocalUid(target), result.rowId]);
        if (move.type === 'delete') await run('UPDATE messages SET trashed_at = ? WHERE id = ?', [Date.now(), result.rowId]);
      }
    }
  }
  return result;
}

export async function localAccountIds(): Promise<number[]> {
  return (await q<{ id: number }>("SELECT id FROM accounts WHERE inbound_kind <> 'imap'")).map((r) => r.id);
}
