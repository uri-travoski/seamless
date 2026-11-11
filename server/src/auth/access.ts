/**
 * Shared-mailbox access model (T4 F-32). The ONE place that decides who may touch which account.
 * Mail rows keep messages.user_id = the account owner; everyone else gets access through mailbox_shares.
 * Not cached on purpose: revoking a share must take effect on the very next request.
 */
import { q, one } from '../db.ts';

export type AccessRole = 'owner' | 'viewer' | 'responder' | 'manager';
export interface AccountAccess { id: number; role: AccessRole }

/** Thrown when the user can see the mail but their role does not allow the action (→ HTTP 403). */
export class Forbidden extends Error {
  statusCode = 403;
  constructor(message = 'your role on this shared mailbox does not allow that') { super(message); }
}

export async function accessibleAccountIds(userId: number): Promise<AccountAccess[]> {
  const own = await q<{ id: number }>('SELECT id FROM accounts WHERE user_id = ?', [userId]);
  const shared = await q<{ account_id: number; role: AccessRole }>(
    'SELECT account_id, role FROM mailbox_shares WHERE user_id = ?', [userId]);
  const out: AccountAccess[] = own.map((a) => ({ id: a.id, role: 'owner' }));
  for (const s of shared) if (!out.some((o) => o.id === s.account_id)) out.push({ id: s.account_id, role: s.role });
  return out;
}

export async function sharedAccountIds(userId: number): Promise<number[]> {
  return (await q<{ account_id: number }>('SELECT account_id FROM mailbox_shares WHERE user_id = ?', [userId])).map((r) => r.account_id);
}

export async function roleFor(userId: number, accountId: number): Promise<AccessRole | null> {
  if (await one('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?', [accountId, userId])) return 'owner';
  const s = await one<{ role: AccessRole }>('SELECT role FROM mailbox_shares WHERE account_id = ? AND user_id = ?', [accountId, userId]);
  return s?.role ?? null;
}

export const canReadRole = (r: AccessRole | null): boolean => r !== null;
export const canSendRole = (r: AccessRole | null): boolean => r === 'owner' || r === 'responder' || r === 'manager';
export const canManageRole = (r: AccessRole | null): boolean => r === 'owner' || r === 'manager';

export async function canRead(userId: number, accountId: number): Promise<boolean> { return canReadRole(await roleFor(userId, accountId)); }
export async function canSend(userId: number, accountId: number): Promise<boolean> { return canSendRole(await roleFor(userId, accountId)); }
export async function canManage(userId: number, accountId: number): Promise<boolean> { return canManageRole(await roleFor(userId, accountId)); }
