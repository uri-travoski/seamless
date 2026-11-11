/** Wrong-business guard (F-30): warn when a client is usually written to from another business. */
import { q, one } from '../db.ts';

export const FREE_MAIL_DOMAINS = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'bigpond.com', 'live.com', 'me.com']);
const MIN_SENDS = 3;
const MIN_SHARE = 0.7;
const WINDOW_MS = 365 * 86_400_000;

export interface BusinessWarning {
  domain: string;
  recipients: string[];
  usualBusinessId: number;
  usualBusiness: string;
  currentBusiness: string;
  sends: number;
  share: number;
  /** identity to switch to (the usual business's default identity, preferring the same mailbox) */
  switchIdentityId: number | null;
  message: string;
}

export async function checkWrongBusiness(userId: number, identityId: number | null | undefined, recipients: string[]): Promise<BusinessWarning[]> {
  if (identityId == null) return [];
  const cur = await one<{ business_id: number | null; account_id: number; bname: string | null }>(
    `SELECT i.business_id, i.account_id, b.name AS bname FROM identities i LEFT JOIN businesses b ON b.id = i.business_id
     WHERE i.id = ? AND i.user_id = ?`, [identityId, userId]);
  if (!cur || cur.business_id == null) return [];

  const emails = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter((r) => r.includes('@')))];
  const muted = new Set((await q<{ email: string }>(
    `SELECT ce.email FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id
     WHERE c.user_id = ? AND c.no_business_guard = true AND lower(ce.email) = ANY(?::text[])`, [userId, emails])).map((r) => r.email.toLowerCase()));

  const byDomain = new Map<string, string[]>();
  for (const e of emails) {
    const d = e.split('@')[1];
    if (!d || FREE_MAIL_DOMAINS.has(d) || muted.has(e)) continue;
    byDomain.set(d, [...(byDomain.get(d) ?? []), e]);
  }

  const out: BusinessWarning[] = [];
  for (const [domain, rcpts] of byDomain) {
    const like = `%@${domain.replace(/[\\%_]/g, '\\$&')}"%`;
    const rows = await q<{ business_id: number; n: number }>(
      `SELECT i.business_id, COUNT(*)::int AS n
       FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id AND mb.role = 'sent'
       JOIN identities i ON i.user_id = m.user_id AND lower(i.email) = lower(m.from_addr)
       WHERE m.user_id = ? AND m.date >= ? AND i.business_id IS NOT NULL AND m.to_json ILIKE ?
       GROUP BY i.business_id`, [userId, Date.now() - WINDOW_MS, like]);
    const total = rows.reduce((s, r) => s + r.n, 0);
    const others = rows.filter((r) => r.business_id !== cur.business_id).sort((a, b) => b.n - a.n);
    const otherSum = others.reduce((s, r) => s + r.n, 0);
    if (total < MIN_SENDS || otherSum / total < MIN_SHARE) continue;
    const top = others[0];
    const ub = (await one<{ name: string }>('SELECT name FROM businesses WHERE id = ? AND user_id = ?', [top.business_id, userId]))!;
    const sw = await one<{ id: number }>(
      `SELECT id FROM identities WHERE user_id = ? AND business_id = ? ORDER BY (account_id = ?) DESC, is_default DESC, id LIMIT 1`,
      [userId, top.business_id, cur.account_id]);
    out.push({
      domain, recipients: rcpts, usualBusinessId: top.business_id, usualBusiness: ub.name, currentBusiness: cur.bname ?? '',
      sends: total, share: otherSum / total, switchIdentityId: sw?.id ?? null,
      message: `You usually email @${domain} from ${ub.name}. Send from ${cur.bname} anyway?`,
    });
  }
  return out;
}
