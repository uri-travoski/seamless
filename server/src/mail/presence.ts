/**
 * Presence on shared threads (T4 F-32): "Alex is replying…". Relayed over the WebSocket to the OTHER users with
 * access to the thread's mailbox — never to users without access. Entries expire 60 s after the last refresh.
 */
import { q, one } from '../db.ts';
import { accountUserIds } from './assignments.ts';
import { broadcast } from '../ws.ts';
import type { WsMessage } from '@seamless/shared';

export const PRESENCE_TTL_MS = 60_000;
export type PresenceAction = 'replying' | 'viewing' | 'left';
const state = new Map<string, { action: PresenceAction; ts: number }>(); // `${accountId}:${threadId}:${userId}`

/** Who should hear about `fromUser`'s presence on a mailbox: everyone with access except themselves. */
export function presenceRecipients(accessUserIds: number[], fromUser: number): number[] {
  return accessUserIds.filter((id) => id !== fromUser);
}

export function activePresence(accountId: number, threadId: string, now = Date.now()): { userId: number; action: PresenceAction }[] {
  const out: { userId: number; action: PresenceAction }[] = [];
  for (const [k, v] of state) {
    if (now - v.ts > PRESENCE_TTL_MS) { state.delete(k); continue; }
    const [a, rest] = [k.split(':')[0], k.slice(k.indexOf(':') + 1)];
    const uidStr = rest.slice(rest.lastIndexOf(':') + 1);
    if (Number(a) === accountId && rest.slice(0, rest.lastIndexOf(':')) === threadId) out.push({ userId: Number(uidStr), action: v.action });
  }
  return out;
}

export interface PresenceIn { type: string; threadId?: string; accountId?: number; action?: string }

export async function handlePresence(userId: number, msg: PresenceIn, send: (m: WsMessage, to: number) => void = (m, to) => broadcast(m, to)): Promise<number[]> {
  if (msg?.type !== 'presence' || typeof msg.threadId !== 'string') return [];
  if (!['replying', 'viewing', 'left'].includes(String(msg.action))) return [];
  const action = msg.action as PresenceAction;
  // which mailbox is this thread in, among those the sender may access?
  const rows = await q<{ account_id: number }>(`SELECT DISTINCT m.account_id FROM messages m WHERE m.thread_id = ?
    AND (m.account_id IN (SELECT id FROM accounts WHERE user_id = ?) OR m.account_id IN (SELECT account_id FROM mailbox_shares WHERE user_id = ?))`,
    [msg.threadId, userId, userId]);
  const wanted = msg.accountId ? rows.filter((r) => r.account_id === msg.accountId) : rows;
  if (!wanted.length) return [];
  const accountId = wanted[0].account_id;
  const key = `${accountId}:${msg.threadId}:${userId}`;
  if (action === 'left') state.delete(key); else state.set(key, { action, ts: Date.now() });
  const u = await one<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', [userId]);
  const to = presenceRecipients(await accountUserIds(accountId), userId);
  for (const r of to) send({ type: 'presence', threadId: msg.threadId, accountId, action, userId, userName: u?.name || u?.email } as WsMessage, r);
  return to;
}
