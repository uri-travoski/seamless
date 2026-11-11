/** VIP senders (T4 F-35, VIP half): never auto-removed from the Inbox, always notify. */
import { q, one, run, bumpState } from '../db.ts';
import { getUserSetting } from '../classify/settings.ts';

export interface Vip { id: number; kind: 'address' | 'domain'; value: string; createdAt: number }
export class VipError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** SQL predicate: message alias `m` is from one of user `?`'s VIPs. Takes one param (user id). */
export const VIP_SQL = `EXISTS (SELECT 1 FROM vip_senders v WHERE v.user_id = ? AND (
  (v.kind = 'address' AND lower(v.value) = lower(m.from_addr))
  OR (v.kind = 'domain' AND lower(split_part(m.from_addr, '@', 2)) = lower(v.value))))`;

export function normalise(kind: string, raw: string): { kind: 'address' | 'domain'; value: string } {
  let v = String(raw ?? '').trim().toLowerCase();
  const angle = v.match(/<([^>]+)>/);
  if (angle) v = angle[1].trim();
  if (kind === 'domain') {
    v = v.replace(/^@/, '');
    if (v.includes('@')) v = v.split('@')[1];
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) throw new VipError(400, 'enter a domain like example.com');
    return { kind: 'domain', value: v };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new VipError(400, 'enter an email address');
  return { kind: 'address', value: v };
}

export async function listVips(userId: number): Promise<Vip[]> {
  const rows = await q<any>('SELECT id, kind, value, created_at FROM vip_senders WHERE user_id = ? ORDER BY kind, value', [userId]);
  return rows.map((r) => ({ id: r.id, kind: r.kind, value: r.value, createdAt: Number(r.created_at) }));
}

export async function addVip(userId: number, kind: string, value: string): Promise<Vip> {
  const n = normalise(kind, value);
  await run('INSERT INTO vip_senders(user_id, kind, value, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', [userId, n.kind, n.value, Date.now()]);
  const r = await one<any>('SELECT id, kind, value, created_at FROM vip_senders WHERE user_id = ? AND kind = ? AND value = ?', [userId, n.kind, n.value]);
  // mail already waiting for removal from this sender is rescued
  await run(`UPDATE messages m SET disposition = 'keep', delete_at = NULL, keep_reason = 'VIP sender'
             WHERE m.user_id = ? AND m.disposition = 'delete' AND ${VIP_SQL}`, [userId, userId]);
  await bumpState();
  return { id: r.id, kind: r.kind, value: r.value, createdAt: Number(r.created_at) };
}

export async function removeVip(userId: number, id: number): Promise<void> {
  const r = await one('SELECT 1 FROM vip_senders WHERE id = ? AND user_id = ?', [id, userId]);
  if (!r) throw new VipError(404, 'not found');
  await run('DELETE FROM vip_senders WHERE id = ? AND user_id = ?', [id, userId]);
  await bumpState();
}

export async function isVipSender(userId: number, fromAddr: string): Promise<boolean> {
  const a = (fromAddr ?? '').trim().toLowerCase();
  if (!a) return false;
  const d = a.split('@')[1] ?? '';
  return !!(await one(
    `SELECT 1 FROM vip_senders WHERE user_id = ? AND ((kind = 'address' AND value = ?) OR (kind = 'domain' AND value = ?))`, [userId, a, d]));
}

export async function isVipMessage(rowId: number): Promise<boolean> {
  const m = await one<{ user_id: number; from_addr: string }>('SELECT user_id, from_addr FROM messages WHERE id = ?', [rowId]);
  return m ? isVipSender(m.user_id, m.from_addr) : false;
}

export async function bypassQuiet(userId: number): Promise<boolean> {
  return (await getUserSetting(userId, 'vip_bypass_quiet')) !== 'false';
}
