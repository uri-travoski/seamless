/**
 * Team settings of a shared mailbox (T8.3): shared snooze and round-robin assignment, both opt-in per mailbox.
 * Rotation: `rr_cursor` is the user id that was assigned last; the next pick is the first eligible member with a
 * larger id (wrapping), so removed / away members are skipped without starving anyone and it survives restarts.
 */
import { q, one, run, withTransaction, clientQuery, bumpState } from '../db.ts';
import { roleFor, canManageRole, canSendRole, accessibleAccountIds, Forbidden } from '../auth/access.ts';
import { accountUserIds } from './assignments.ts';
import { emitEvent } from '../events/emit.ts';
import { broadcast } from '../ws.ts';

export class TeamNotFound extends Error { statusCode = 404; }
export class TeamBadRequest extends Error { statusCode = 400; }

export interface TeamSettings {
  accountId: number; allowSnooze: boolean; autoAssign: 'off' | 'round_robin';
  members: { userId: number; name: string; email: string; role: string; inPool: boolean; away: boolean }[];
}

export async function getTeamRow(accountId: number): Promise<{ allow_snooze: boolean; auto_assign: 'off' | 'round_robin'; rr_cursor: number | null }> {
  return (await one<any>('SELECT allow_snooze, auto_assign, rr_cursor FROM mailbox_team_settings WHERE account_id = ?', [accountId]))
    ?? { allow_snooze: false, auto_assign: 'off', rr_cursor: null };
}

/** May this user snooze mail of the account for everyone? (owner: always their own; shared: role + mailbox opt-in) */
export async function snoozeAllowedFor(userId: number, accountId: number): Promise<boolean> {
  const role = await roleFor(userId, accountId);
  if (role === 'owner') return true;
  if (!canSendRole(role)) return false;
  return (await getTeamRow(accountId)).allow_snooze;
}

/** Only an owner or manager sees / changes the team settings. */
async function managerOf(userId: number, accountId: number): Promise<void> {
  const role = await roleFor(userId, accountId);
  if (!role) throw new TeamNotFound('not found');
  if (!canManageRole(role)) throw new Forbidden('only the owner or a manager can change team settings');
}

/** Everyone who could be in the pool: owner, responders, managers. */
async function eligible(accountId: number) {
  const out: { id: number; name: string; email: string; role: string }[] = [];
  for (const id of await accountUserIds(accountId)) {
    const role = await roleFor(id, accountId);
    if (!role || !canSendRole(role)) continue;
    const u = await one<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', [id]);
    if (u) out.push({ id, name: u.name || u.email, email: u.email, role });
  }
  return out.sort((a, b) => a.id - b.id);
}

export async function getTeamSettings(userId: number, accountId: number): Promise<TeamSettings> {
  const role = await roleFor(userId, accountId);
  if (!role) throw new TeamNotFound('not found');
  const row = await getTeamRow(accountId);
  const pool = await q<{ user_id: number; active: boolean }>('SELECT user_id, active FROM mailbox_rr_members WHERE account_id = ?', [accountId]);
  return {
    accountId, allowSnooze: row.allow_snooze, autoAssign: row.auto_assign,
    members: (await eligible(accountId)).map((m) => {
      const p = pool.find((x) => x.user_id === m.id);
      return { userId: m.id, name: m.name, email: m.email, role: m.role, inPool: !!p, away: !!p && !p.active };
    }),
  };
}

export async function setTeamSettings(userId: number, accountId: number,
  input: { allowSnooze?: boolean; autoAssign?: string; pool?: number[] }): Promise<{ before: TeamSettings; after: TeamSettings }> {
  await managerOf(userId, accountId);
  const before = await getTeamSettings(userId, accountId);
  if (input.autoAssign !== undefined && input.autoAssign !== 'off' && input.autoAssign !== 'round_robin') throw new TeamBadRequest('autoAssign must be off or round_robin');
  await run(`INSERT INTO mailbox_team_settings(account_id, allow_snooze, auto_assign) VALUES (?,?,?)
    ON CONFLICT (account_id) DO UPDATE SET allow_snooze = excluded.allow_snooze, auto_assign = excluded.auto_assign`,
    [accountId, input.allowSnooze ?? before.allowSnooze, input.autoAssign ?? before.autoAssign]);
  if (Array.isArray(input.pool)) {
    const ok = new Set((await eligible(accountId)).map((m) => m.id));
    const want = [...new Set(input.pool.map(Number))].filter((id) => ok.has(id));
    await run('DELETE FROM mailbox_rr_members WHERE account_id = ? AND NOT (user_id = ANY(?::int[]))', [accountId, want]);
    for (const id of want) await run('INSERT INTO mailbox_rr_members(account_id, user_id, active) VALUES (?,?,true) ON CONFLICT DO NOTHING', [accountId, id]);
  }
  await bumpState();
  for (const id of await accountUserIds(accountId)) broadcast({ type: 'stateChange' }, id);
  return { before, after: await getTeamSettings(userId, accountId) };
}

/** A pool member switches themselves away / back. Everyone with a pool row may do this for themselves only. */
export async function setAway(userId: number, accountId: number, away: boolean): Promise<void> {
  const n = await run('UPDATE mailbox_rr_members SET active = ? WHERE account_id = ? AND user_id = ?', [!away, accountId, userId]);
  if (!n) throw new TeamNotFound('you are not in the round-robin pool of this mailbox');
  await bumpState();
  for (const id of await accountUserIds(accountId)) broadcast({ type: 'stateChange' }, id);
}

/** Mailboxes where the user is in the round-robin pool (for the "I'm away" switch). */
export async function myPools(userId: number): Promise<{ accountId: number; email: string; away: boolean }[]> {
  return (await q<any>(`SELECT m.account_id, a.email, m.active FROM mailbox_rr_members m JOIN accounts a ON a.id = m.account_id
    JOIN mailbox_team_settings t ON t.account_id = m.account_id AND t.auto_assign = 'round_robin' WHERE m.user_id = ? ORDER BY m.account_id`, [userId]))
    .map((r) => ({ accountId: r.account_id, email: r.email, away: !r.active }));
}

/** Next assignee for `accountId` (and advance the cursor) or null when nobody is active. Runs under a row lock. */
export async function assignOnArrival(accountId: number, threadId: string, subject: string, messageId: number): Promise<number | null> {
  const t = await getTeamRow(accountId);
  if (t.auto_assign !== 'round_robin') return null;
  const picked = await withTransaction(async (c) => {
    await clientQuery(c, 'INSERT INTO mailbox_team_settings(account_id) VALUES (?) ON CONFLICT DO NOTHING', [accountId]);
    const cur = (await clientQuery<any>(c, 'SELECT rr_cursor, auto_assign FROM mailbox_team_settings WHERE account_id = ? FOR UPDATE', [accountId]))[0];
    if (cur.auto_assign !== 'round_robin') return null;
    if ((await clientQuery(c, 'SELECT 1 FROM assignments WHERE account_id = ? AND message_thread_id = ?', [accountId, threadId])).length) return null;
    const okIds = new Set((await eligible(accountId)).map((m) => m.id));
    const active = (await clientQuery<{ user_id: number }>(c, 'SELECT user_id FROM mailbox_rr_members WHERE account_id = ? AND active ORDER BY user_id', [accountId]))
      .map((r) => r.user_id).filter((id) => okIds.has(id));
    if (!active.length) return null;
    const next = active.find((id) => id > (cur.rr_cursor ?? 0)) ?? active[0];
    await clientQuery(c, 'UPDATE mailbox_team_settings SET rr_cursor = ? WHERE account_id = ?', [next, accountId]);
    await clientQuery(c, `INSERT INTO assignments(message_thread_id, account_id, assignee_id, status, updated_by, updated_at) VALUES (?,?,?,'open',NULL,?)
      ON CONFLICT (account_id, message_thread_id) DO NOTHING`, [threadId, accountId, next, Date.now()]);
    const u = (await clientQuery<any>(c, 'SELECT name, email FROM users WHERE id = ?', [next]))[0];
    await emitEvent(next, 'assignment.changed', { type: 'thread', id: threadId },
      { accountId, threadId, subject, auto: true, assignee: u?.name || u?.email, messageId }, c);
    return next;
  });
  if (picked !== null) {
    await bumpState();
    for (const id of await accountUserIds(accountId)) broadcast({ type: 'stateChange' }, id);
  }
  return picked;
}

/** True when `accountId` has a message in this thread other than `exceptRowId` (i.e. the new mail is a reply, not a new thread). */
export async function threadHasOthers(accountId: number, threadId: string, exceptRowId: number): Promise<boolean> {
  return !!(await one('SELECT 1 FROM messages WHERE account_id = ? AND thread_id = ? AND id <> ? LIMIT 1', [accountId, threadId, exceptRowId]));
}

export { accessibleAccountIds };
