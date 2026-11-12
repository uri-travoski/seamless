/**
 * Shared labels (T8.2). The owner of a shared mailbox may offer their labels to a person they share it with;
 * the person accepts / rejects / decides later. Accepted labels are the OWNER's label rows (read-only for the
 * invitee) and can be put on / taken off messages of that shared mailbox by responders and managers.
 */
import { q, one } from '../db.ts';

/** SQL: label `l` (alias) is visible to user `?` on a message `m` (alias): own mail, or an accepted share that offers it. */
export const SHARED_LABEL_VISIBLE_SQL = `(m.user_id = ? OR EXISTS (
  SELECT 1 FROM mailbox_shares s WHERE s.account_id = m.account_id AND s.user_id = ? AND s.labels_shared AND s.labels_status = 'accepted'
    AND l.user_id = m.user_id
    AND (NOT EXISTS (SELECT 1 FROM shared_label_offers o WHERE o.account_id = s.account_id AND o.user_id = s.user_id)
         OR EXISTS (SELECT 1 FROM shared_label_offers o WHERE o.account_id = s.account_id AND o.user_id = s.user_id AND o.label_id = l.id))))`;

/** Ids of the owner's labels `userId` may see/apply on shared account `accountId` (empty unless the offer was accepted). */
export async function acceptedLabelIds(userId: number, accountId: number): Promise<number[]> {
  const rows = await q<{ id: number }>(`
    SELECT l.id FROM mailbox_shares s JOIN accounts a ON a.id = s.account_id JOIN labels l ON l.user_id = a.user_id
    WHERE s.account_id = ? AND s.user_id = ? AND s.labels_shared AND s.labels_status = 'accepted'
      AND (NOT EXISTS (SELECT 1 FROM shared_label_offers o WHERE o.account_id = s.account_id AND o.user_id = s.user_id)
           OR EXISTS (SELECT 1 FROM shared_label_offers o WHERE o.account_id = s.account_id AND o.user_id = s.user_id AND o.label_id = l.id))`,
    [accountId, userId]);
  return rows.map((r) => r.id);
}

export interface SharedLabelOffer {
  accountId: number; email: string; mailbox: string; ownerId: number; owner: string; ownerName: string;
  status: 'pending' | 'accepted' | 'rejected'; role: string; count: number;
  labels: { id: number; name: string; color: string }[];
  /** "Decide later" hides the banner until this time (a week), the offer itself stays pending. */
  hideBannerUntil: number | null;
}

export const LATER_MS = 7 * 24 * 3600 * 1000;

/** Everything offered to `userId` (any answer), with the labels it covers. */
export async function offersFor(userId: number): Promise<SharedLabelOffer[]> {
  const rows = await q<any>(`
    SELECT s.account_id, s.role, s.labels_status, s.labels_later_at, a.email, a.name, a.user_id AS owner_id, o.email AS owner_email, o.name AS owner_name
    FROM mailbox_shares s JOIN accounts a ON a.id = s.account_id JOIN users o ON o.id = a.user_id
    WHERE s.user_id = ? AND s.labels_shared AND s.labels_status <> 'none' ORDER BY s.account_id`, [userId]);
  const out: SharedLabelOffer[] = [];
  for (const r of rows) {
    const labels = await q<{ id: number; name: string; color: string }>(`
      SELECT l.id, l.name, l.color FROM labels l
      WHERE l.user_id = ? AND (NOT EXISTS (SELECT 1 FROM shared_label_offers x WHERE x.account_id = ? AND x.user_id = ?)
        OR l.id IN (SELECT label_id FROM shared_label_offers WHERE account_id = ? AND user_id = ?))
      ORDER BY lower(l.name)`, [r.owner_id, r.account_id, userId, r.account_id, userId]);
    out.push({
      accountId: r.account_id, email: r.email, mailbox: r.name || r.email, ownerId: r.owner_id, owner: r.owner_email, ownerName: r.owner_name || r.owner_email,
      status: r.labels_status, role: r.role, count: labels.length, labels,
      hideBannerUntil: r.labels_later_at && Number(r.labels_later_at) + LATER_MS > Date.now() ? Number(r.labels_later_at) + LATER_MS : null,
    });
  }
  return out;
}

/** Labels shared with `userId` (accepted offers only), keyed by label id → the accounts they apply to. */
export async function acceptedSharedLabels(userId: number): Promise<Map<number, { name: string; color: string; description: string; ownerName: string; accountIds: number[] }>> {
  const rows = await q<any>(`
    SELECT l.id, l.name, l.color, l.description, s.account_id, COALESCE(NULLIF(o.name, ''), o.email) AS owner_name
    FROM mailbox_shares s JOIN accounts a ON a.id = s.account_id JOIN users o ON o.id = a.user_id JOIN labels l ON l.user_id = a.user_id
    WHERE s.user_id = ? AND s.labels_shared AND s.labels_status = 'accepted'
      AND (NOT EXISTS (SELECT 1 FROM shared_label_offers x WHERE x.account_id = s.account_id AND x.user_id = s.user_id)
           OR EXISTS (SELECT 1 FROM shared_label_offers x WHERE x.account_id = s.account_id AND x.user_id = s.user_id AND x.label_id = l.id))
    ORDER BY lower(l.name)`, [userId]);
  const out = new Map<number, { name: string; color: string; description: string; ownerName: string; accountIds: number[] }>();
  for (const r of rows) {
    const e = out.get(r.id);
    if (e) e.accountIds.push(r.account_id);
    else out.set(r.id, { name: r.name, color: r.color, description: r.description ?? '', ownerName: r.owner_name, accountIds: [r.account_id] });
  }
  return out;
}

export const hasOffer = async (userId: number, accountId: number) =>
  !!(await one("SELECT 1 FROM mailbox_shares WHERE account_id = ? AND user_id = ? AND labels_shared AND labels_status <> 'none'", [accountId, userId]));
