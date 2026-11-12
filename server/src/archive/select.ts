/** Archive old mail (T8.4): which messages an archive rule picks. One place, used by preview, dry run and the real plan. */
import { q, one } from '../db.ts';
import { VIP_SQL } from '../mail/vip.ts';

export interface ArchiveOptions {
  /** Starred mail is kept in the app unless this is on. */
  includeStarred?: boolean;
  /** Mail from VIP senders is kept in the app unless this is on. */
  includeVip?: boolean;
  /** Spam and Bin are left alone unless this is on. */
  includeSpamBin?: boolean;
  /** Move mode only: also move the message to the Bin on the mail server (default off: the provider keeps its copy). */
  alsoDeleteFromServer?: boolean;
}

export class ArchiveError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export const DAY_MS = 86_400_000;

/** `older than` as whole days. Years are 365 days, months 30. */
export function parseOlderThan(src: Record<string, unknown>): number {
  const n = (v: unknown) => Number(v);
  let days = NaN;
  if (src.olderThanDays != null) days = n(src.olderThanDays);
  else if (src.olderThanMonths != null) days = n(src.olderThanMonths) * 30;
  else if (src.olderThanYears != null) days = n(src.olderThanYears) * 365;
  else if (typeof src.olderThan === 'string') {
    const m = src.olderThan.trim().match(/^(\d+)\s*(d|m|y)?$/i);
    if (m) days = Number(m[1]) * ({ d: 1, m: 30, y: 365 } as Record<string, number>)[(m[2] ?? 'd').toLowerCase()];
  }
  if (!Number.isFinite(days) || days < 1 || days > 365 * 100) throw new ArchiveError(400, 'olderThan must be at least 1 day');
  return Math.round(days);
}

/** 'all' = every mailbox the user owns; 'account:<id>' = one of them. Shared mail belongs to its owner, so it is never included here. */
export async function scopeAccounts(userId: number, scope: string): Promise<number[]> {
  const mine = (await q<{ id: number }>('SELECT id FROM accounts WHERE user_id = ? ORDER BY id', [userId])).map((r) => r.id);
  if (scope === 'all' || !scope) return mine;
  const m = scope.match(/^account:(\d+)$/);
  if (!m) throw new ArchiveError(400, 'scope must be all or account:<id>');
  const id = Number(m[1]);
  if (!mine.includes(id)) throw new ArchiveError(404, 'mailbox not found');
  return [id];
}

export function selectionFrom(userId: number, accountIds: number[], cutoff: number, o: ArchiveOptions): { sql: string; params: unknown[] } {
  const where = [
    'm.user_id = ?', 'm.account_id = ANY(?)', 'm.date < ?', 'm.s3_key IS NOT NULL',
    'm.draft = false', "COALESCE(mb.role, '') NOT IN ('drafts','scheduled')", 'm.snoozed_until IS NULL',
    "NOT EXISTS (SELECT 1 FROM followups f WHERE f.message_id = m.id AND f.status IN ('waiting','due'))",
  ];
  const params: unknown[] = [userId, accountIds, cutoff];
  if (!o.includeStarred) where.push('m.flagged = false');
  if (!o.includeVip) { where.push(`NOT ${VIP_SQL}`); params.push(userId); }
  if (!o.includeSpamBin) where.push("COALESCE(mb.role, '') NOT IN ('trash','junk')");
  return { sql: `FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE ${where.join(' AND ')}`, params };
}

export interface ArchivePreview { count: number; bytes: number; oldest: number | null; newest: number | null; cutoff: number }

export async function previewArchive(userId: number, scope: string, olderThanDays: number, o: ArchiveOptions, now = Date.now()): Promise<ArchivePreview> {
  const cutoff = now - olderThanDays * DAY_MS;
  const ids = await scopeAccounts(userId, scope);
  if (!ids.length) return { count: 0, bytes: 0, oldest: null, newest: null, cutoff };
  const { sql, params } = selectionFrom(userId, ids, cutoff, o);
  const r = await one<any>(`SELECT COUNT(*)::int c, COALESCE(SUM(m.size),0)::bigint b, MIN(m.date) lo, MAX(m.date) hi ${sql}`, params);
  return { count: r.c, bytes: Number(r.b), oldest: r.lo == null ? null : Number(r.lo), newest: r.hi == null ? null : Number(r.hi), cutoff };
}

export async function sampleArchive(userId: number, scope: string, olderThanDays: number, o: ArchiveOptions, limit = 20, now = Date.now()) {
  const ids = await scopeAccounts(userId, scope);
  if (!ids.length) return [];
  const { sql, params } = selectionFrom(userId, ids, now - olderThanDays * DAY_MS, o);
  return q<any>(`SELECT m.id, m.subject, m.from_addr AS "from", m.date ${sql} ORDER BY m.date LIMIT ${Math.min(100, Math.max(1, limit))}`, params);
}
