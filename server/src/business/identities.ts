/** Identities (F-30): one per account address and alias, kept in sync with accounts. */
import { q, one, run } from '../db.ts';
import { cleanSigHtml } from './businesses.ts';

export interface IdentityRow {
  id: number; user_id: number; account_id: number; business_id: number | null; email: string; display_name: string;
  signature_html: string | null; reply_to: string | null; bcc_self: boolean; transport_id: number | null; is_default: boolean;
}

/** Create missing identities for the account address + aliases, drop identities whose alias is gone. */
export async function syncAccountIdentities(accountId: number): Promise<void> {
  const a = await one<{ user_id: number; name: string; email: string; aliases: string; signature: string }>(
    'SELECT user_id, name, email, aliases, signature FROM accounts WHERE id = ?', [accountId]);
  if (!a) return;
  const aliases = (JSON.parse(a.aliases || '[]') as string[]).map((x) => x.trim()).filter(Boolean);
  const name = a.name || a.email;
  const existing = await q<{ id: number; email: string }>('SELECT id, email FROM identities WHERE account_id = ?', [accountId]);
  const has = new Set(existing.map((e) => e.email.toLowerCase()));
  if (!has.has(a.email.toLowerCase())) {
    await run('INSERT INTO identities(user_id, account_id, email, display_name, signature_html, is_default) VALUES (?,?,?,?,?,true) ON CONFLICT DO NOTHING',
      [a.user_id, accountId, a.email, name, a.signature || null]);
  }
  for (const al of aliases) {
    if (has.has(al.toLowerCase())) continue;
    await run('INSERT INTO identities(user_id, account_id, email, display_name, is_default) VALUES (?,?,?,?,false) ON CONFLICT DO NOTHING',
      [a.user_id, accountId, al, name]);
  }
  const keep = new Set([a.email.toLowerCase(), ...aliases.map((x) => x.toLowerCase())]);
  for (const e of existing) if (!keep.has(e.email.toLowerCase())) await run('DELETE FROM identities WHERE id = ?', [e.id]);
}

export const listIdentityRows = (userId: number) =>
  q<IdentityRow>('SELECT * FROM identities WHERE user_id = ? ORDER BY account_id, is_default DESC, id', [userId]);

export interface IdentityInput {
  displayName?: string; signatureHtml?: string | null; replyTo?: string | null; bccSelf?: boolean;
  transportId?: number | null; businessId?: number | null; isDefault?: boolean;
}

/** Returns an error string, or null on success. Foreign ids must belong to the same user. */
export async function updateIdentity(userId: number, id: number, b: IdentityInput): Promise<string | null> {
  const e = await one<IdentityRow>('SELECT * FROM identities WHERE id = ? AND user_id = ?', [id, userId]);
  if (!e) return 'not found';
  if (b.businessId != null && !(await one('SELECT id FROM businesses WHERE id = ? AND user_id = ?', [b.businessId, userId]))) return 'unknown business';
  if (b.transportId != null && !(await one('SELECT id FROM transports WHERE id = ? AND user_id = ?', [b.transportId, userId]))) return 'unknown transport';
  if (b.replyTo && !/^[^@\s]+@[^@\s]+$/.test(b.replyTo)) return 'reply-to must be an email address';
  const pick = <T>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
  await run(`UPDATE identities SET display_name=?, signature_html=?, reply_to=?, bcc_self=?, transport_id=?, business_id=? WHERE id=?`, [
    String(pick(b.displayName, e.display_name)).trim() || e.email,
    (typeof b.signatureHtml === 'string' ? cleanSigHtml(b.signatureHtml) : pick(b.signatureHtml, e.signature_html)) || null, pick(b.replyTo, e.reply_to) || null,
    pick(b.bccSelf, e.bcc_self), pick(b.transportId, e.transport_id), pick(b.businessId, e.business_id), id]);
  if (b.isDefault) {
    await run('UPDATE identities SET is_default = (id = ?) WHERE account_id = ?', [id, e.account_id]);
  }
  return null;
}
