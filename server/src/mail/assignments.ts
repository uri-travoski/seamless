/** Shared-inbox workflow (T4 F-32 part 2): assignment, status, internal comments. */
import type { ApiAssignment, ApiThreadComment } from '@seamless/shared';
import { q, one, run, withTransaction, clientQuery, bumpState } from '../db.ts';
import { roleFor, canSendRole, Forbidden } from '../auth/access.ts';
import { emitEvent } from '../events/emit.ts';
import { broadcast } from '../ws.ts';

export const STATUSES = ['open', 'pending', 'done'] as const;
export type AssignStatus = typeof STATUSES[number];
export class BadRequest extends Error { statusCode = 400; }
export class NotFound extends Error { statusCode = 404; }

/** Role of `userId` on the account, after checking the thread really lives in that account. */
async function threadAccess(userId: number, accountId: number, threadId: string) {
  const role = await roleFor(userId, accountId);
  if (!role) throw new NotFound('not found');
  const t = await one<{ subject: string }>('SELECT subject FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY date ASC LIMIT 1', [accountId, threadId]);
  if (!t) throw new NotFound('not found');
  return { role, subject: t.subject };
}

const toApi = (r: any): ApiAssignment => ({
  accountId: r.account_id, threadId: r.message_thread_id, assigneeId: r.assignee_id, assigneeName: r.assignee_name ?? null,
  status: r.status, dueAt: r.due_at == null ? null : Number(r.due_at), updatedAt: Number(r.updated_at),
});

export async function getAssignment(userId: number, accountId: number, threadId: string): Promise<ApiAssignment | null> {
  await threadAccess(userId, accountId, threadId);
  const r = await one<any>(`SELECT a.*, u.name AS assignee_name FROM assignments a LEFT JOIN users u ON u.id = a.assignee_id
    WHERE a.account_id = ? AND a.message_thread_id = ?`, [accountId, threadId]);
  return r ? toApi(r) : null;
}

/** Assignments for several threads at once (list rows). Only for accounts the user can read. */
export async function assignmentsForThreads(userId: number, pairs: { accountId: number; threadId: string }[]): Promise<Map<string, ApiAssignment>> {
  const out = new Map<string, ApiAssignment>();
  if (!pairs.length) return out;
  const rows = await q<any>(`SELECT a.*, u.name AS assignee_name FROM assignments a LEFT JOIN users u ON u.id = a.assignee_id
    WHERE a.account_id = ANY(?::int[]) AND a.message_thread_id = ANY(?::text[])
      AND (a.account_id IN (SELECT id FROM accounts WHERE user_id = ?) OR a.account_id IN (SELECT account_id FROM mailbox_shares WHERE user_id = ?))`,
    [[...new Set(pairs.map((p) => p.accountId))], [...new Set(pairs.map((p) => p.threadId))], userId, userId]);
  for (const r of rows) out.set(`${r.account_id}:${r.message_thread_id}`, toApi(r));
  return out;
}

export async function setAssignment(userId: number, accountId: number, threadId: string,
  input: { assigneeId?: number | null; status?: string; dueAt?: number | null }): Promise<ApiAssignment> {
  const { role, subject } = await threadAccess(userId, accountId, threadId);
  if (!canSendRole(role)) throw new Forbidden('viewers cannot assign or change status');
  const status = (input.status ?? 'open') as AssignStatus;
  if (!STATUSES.includes(status)) throw new BadRequest('status must be open, pending or done');
  const assigneeId = input.assigneeId ?? null;
  if (assigneeId !== null && !(await roleFor(Number(assigneeId), accountId))) throw new BadRequest('that person has no access to this mailbox');
  const dueAt = input.dueAt == null ? null : Number(input.dueAt);
  if (dueAt !== null && !Number.isFinite(dueAt)) throw new BadRequest('bad dueAt');
  const now = Date.now();
  await withTransaction(async (c) => {
    const prev = (await clientQuery<any>(c, 'SELECT assignee_id FROM assignments WHERE account_id = ? AND message_thread_id = ?', [accountId, threadId]))[0];
    await clientQuery(c, `INSERT INTO assignments(message_thread_id, account_id, assignee_id, status, due_at, updated_by, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (account_id, message_thread_id) DO UPDATE SET assignee_id = excluded.assignee_id, status = excluded.status,
        due_at = excluded.due_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [threadId, accountId, assigneeId, status, dueAt, userId, now]);
    if (assigneeId !== null && assigneeId !== userId && (prev?.assignee_id ?? null) !== assigneeId) {
      const who = await clientQuery<any>(c, 'SELECT name, email FROM users WHERE id = ?', [userId]);
      const firstMsg = (await clientQuery<any>(c, 'SELECT id FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY date DESC LIMIT 1', [accountId, threadId]))[0];
      await emitEvent(assigneeId, 'assignment.changed', { type: 'thread', id: threadId },
        { accountId, threadId, subject, by: who[0]?.name || who[0]?.email, messageId: firstMsg?.id }, c);
    }
  });
  await bumpState();
  await notifyAccountUsers(accountId);
  return (await getAssignment(userId, accountId, threadId))!;
}

/** Everyone with access to the account: owner + shares. */
export async function accountUserIds(accountId: number): Promise<number[]> {
  const rows = await q<{ id: number }>(`SELECT user_id AS id FROM accounts WHERE id = ? UNION SELECT user_id FROM mailbox_shares WHERE account_id = ?`, [accountId, accountId]);
  return rows.map((r) => r.id);
}
async function notifyAccountUsers(accountId: number) {
  for (const id of await accountUserIds(accountId)) broadcast({ type: 'stateChange' }, id);
}

const toComment = (r: any): ApiThreadComment => ({
  id: r.id, userId: r.user_id, userName: r.user_name || r.user_email, body: r.body, mentions: r.mentions ?? [], createdAt: Number(r.created_at),
});

export async function listComments(userId: number, accountId: number, threadId: string): Promise<ApiThreadComment[]> {
  await threadAccess(userId, accountId, threadId);
  return (await q<any>(`SELECT c.*, u.name AS user_name, u.email AS user_email FROM thread_comments c JOIN users u ON u.id = c.user_id
    WHERE c.account_id = ? AND c.message_thread_id = ? ORDER BY c.id`, [accountId, threadId])).map(toComment);
}

/** `@name` → user ids that have access to the account. Matches the start of the user's name or email local part. */
export async function resolveMentions(accountId: number, body: string): Promise<number[]> {
  const handles = [...body.matchAll(/(?:^|[\s(])@([\w.+-]+)/g)].map((m) => m[1].toLowerCase());
  if (!handles.length) return [];
  const ids = await accountUserIds(accountId);
  const users = await q<{ id: number; name: string; email: string }>('SELECT id, name, email FROM users WHERE id = ANY(?::int[])', [ids]);
  const found = new Set<number>();
  for (const h of handles) {
    for (const u of users) {
      const keys = [u.name?.toLowerCase().replace(/\s+/g, ''), u.name?.toLowerCase().split(/\s+/)[0], u.email.toLowerCase().split('@')[0]].filter(Boolean);
      if (keys.includes(h)) found.add(u.id);
    }
  }
  return [...found];
}

export async function addComment(userId: number, accountId: number, threadId: string, bodyIn: unknown): Promise<ApiThreadComment> {
  const { role, subject } = await threadAccess(userId, accountId, threadId);
  if (!canSendRole(role)) throw new Forbidden('viewers cannot comment');
  const body = String(bodyIn ?? '').trim();
  if (!body) throw new BadRequest('comment is empty');
  if (body.length > 5000) throw new BadRequest('comment is longer than 5000 characters');
  const mentions = (await resolveMentions(accountId, body)).filter((id) => id !== userId);
  const now = Date.now();
  const id = await withTransaction(async (c) => {
    const r = await clientQuery<{ id: number }>(c, `INSERT INTO thread_comments(account_id, message_thread_id, user_id, body, mentions, created_at)
      VALUES (?,?,?,?,?::int[],?) RETURNING id`, [accountId, threadId, userId, body, mentions, now]);
    const who = (await clientQuery<any>(c, 'SELECT name, email FROM users WHERE id = ?', [userId]))[0];
    const msg = (await clientQuery<any>(c, 'SELECT id FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY date DESC LIMIT 1', [accountId, threadId]))[0];
    for (const m of mentions) {
      await emitEvent(m, 'comment.mention', { type: 'thread', id: threadId },
        { accountId, threadId, subject, by: who?.name || who?.email, excerpt: body.slice(0, 140), messageId: msg?.id }, c);
    }
    return r[0].id;
  });
  await bumpState();
  await notifyAccountUsers(accountId);
  return (await listComments(userId, accountId, threadId)).find((c) => c.id === id)!;
}

/** Drop assignments pointing at a user who just lost access (called when a share is removed). */
export async function clearAssignmentsFor(accountId: number, userId: number) {
  await run('UPDATE assignments SET assignee_id = NULL WHERE account_id = ? AND assignee_id = ?', [accountId, userId]);
}

/** People who can be assigned / mentioned on this mailbox (everyone with access). */
export async function listPeople(userId: number, accountId: number): Promise<{ id: number; name: string; email: string; role: string }[]> {
  if (!(await roleFor(userId, accountId))) throw new NotFound('not found');
  const out = [];
  for (const id of await accountUserIds(accountId)) {
    const u = await one<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', [id]);
    if (u) out.push({ id, name: u.name || u.email, email: u.email, role: (await roleFor(id, accountId))! });
  }
  return out;
}
