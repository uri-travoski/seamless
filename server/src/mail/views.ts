/**
 * Saved searches / smart views (T4 F-34). A view is a stored query in the search language
 * plus a scope; its sidebar count and its list both come from queryEmails, so they agree.
 */
import type { ApiSavedView, ApiViewSuggestion } from '@seamless/shared';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { queryEmails } from './store.ts';
import { emitEvent } from '../events/emit.ts';
import { getUserSetting, setUserSetting } from '../classify/settings.ts';
import { broadcast } from '../ws.ts';

interface ViewRow {
  id: number; user_id: number; name: string; icon: string; color: string | null; query: string; scope: string; sort: string;
  pinned: boolean; show_count: boolean; sort_order: number; notify: boolean; last_notified_message_id: number | null;
}

const toApi = (r: ViewRow): ApiSavedView => ({
  id: r.id, name: r.name, icon: r.icon, color: r.color, query: r.query, scope: r.scope, sort: r.sort,
  pinned: r.pinned, showCount: r.show_count, sortOrder: r.sort_order, notify: r.notify,
});

export class ViewError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

export async function listViews(userId: number): Promise<ApiSavedView[]> {
  return (await q<ViewRow>('SELECT * FROM saved_views WHERE user_id = ? ORDER BY sort_order, id', [userId])).map(toApi);
}

export interface ViewInput {
  name?: string; icon?: string; color?: string | null; query?: string; scope?: string;
  sort?: string; pinned?: boolean; showCount?: boolean; notify?: boolean;
}

export async function createView(userId: number, b: ViewInput): Promise<ApiSavedView> {
  const name = String(b.name ?? '').trim().slice(0, 80);
  const query = String(b.query ?? '').trim();
  if (!name) throw new ViewError('name required');
  if (!query) throw new ViewError('query required');
  const next = await one<{ n: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM saved_views WHERE user_id = ?', [userId]);
  const id = await insertId(
    `INSERT INTO saved_views(user_id, name, icon, color, query, scope, sort, pinned, show_count, sort_order, notify, last_notified_message_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE user_id = ?))`,
    [userId, name, b.icon || 'magnifying-glass', b.color ?? null, query, b.scope || 'unified', b.sort || 'date_desc',
      b.pinned ?? true, b.showCount ?? true, next?.n ?? 0, b.notify ?? false, userId]);
  countCache.delete(userId);
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
  return toApi((await one<ViewRow>('SELECT * FROM saved_views WHERE id = ?', [id]))!);
}

export async function updateView(userId: number, id: number, b: ViewInput): Promise<ApiSavedView> {
  const cur = await one<ViewRow>('SELECT * FROM saved_views WHERE id = ? AND user_id = ?', [id, userId]);
  if (!cur) throw new ViewError('not found', 404);
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 80) : cur.name;
  const query = b.query !== undefined ? String(b.query).trim() : cur.query;
  if (!name || !query) throw new ViewError('name and query are required');
  await run(
    `UPDATE saved_views SET name=?, icon=?, color=?, query=?, scope=?, sort=?, pinned=?, show_count=?, notify=? WHERE id=? AND user_id=?`,
    [name, b.icon ?? cur.icon, b.color !== undefined ? b.color : cur.color, query, b.scope ?? cur.scope, b.sort ?? cur.sort,
      b.pinned ?? cur.pinned, b.showCount ?? cur.show_count, b.notify ?? cur.notify, id, userId]);
  if (b.notify === true && !cur.notify) {
    // turning notifications on: only mail from now on counts
    await run('UPDATE saved_views SET last_notified_message_id = (SELECT COALESCE(MAX(id), 0) FROM messages WHERE user_id = ?) WHERE id = ?', [userId, id]);
  }
  countCache.delete(userId);
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
  return toApi((await one<ViewRow>('SELECT * FROM saved_views WHERE id = ?', [id]))!);
}

export async function deleteView(userId: number, id: number): Promise<void> {
  const n = await run('DELETE FROM saved_views WHERE id = ? AND user_id = ?', [id, userId]);
  if (n === 0) throw new ViewError('not found', 404);
  countCache.delete(userId);
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
}

/** Order = the given ids (only the user's own; others are ignored). */
export async function reorderViews(userId: number, ids: number[]): Promise<void> {
  let i = 0;
  for (const id of ids) await run('UPDATE saved_views SET sort_order = ? WHERE id = ? AND user_id = ?', [i++, Number(id), userId]);
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
}

// ---- counts (one query per pinned view with show_count, cached 30 s per user) ----
const COUNT_TTL = 30_000;
const countCache = new Map<number, { at: number; counts: Record<string, number> }>();

export function clearViewCounts(userId?: number): void {
  if (userId === undefined) countCache.clear(); else countCache.delete(userId);
}

export async function viewCount(userId: number, v: { query: string; scope: string }): Promise<number> {
  const r = await queryEmails(userId, { filter: { text: v.query, scope: v.scope }, position: 0, limit: 1 });
  return r.total;
}

export async function viewCounts(userId: number, now = Date.now()): Promise<Record<string, number>> {
  const hit = countCache.get(userId);
  if (hit && now - hit.at < COUNT_TTL) return hit.counts;
  const views = await q<ViewRow>('SELECT * FROM saved_views WHERE user_id = ? AND pinned = true AND show_count = true ORDER BY sort_order, id', [userId]);
  const counts: Record<string, number> = {};
  for (const v of views) counts[String(v.id)] = await viewCount(userId, v);
  countCache.set(userId, { at: now, counts });
  return counts;
}

// ---- suggestions (offered once; dismissible) ----
const SUGGESTIONS: ApiViewSuggestion[] = [
  { key: 'waiting', name: 'Waiting for reply', icon: 'hourglass', query: 'is:waiting' },
  { key: 'invoices', name: 'Unpaid invoices', icon: 'receipt', query: 'label:Invoices is:unread' },
  { key: 'risk', name: 'High risk', icon: 'warning', query: 'risk:high' },
  { key: 'big', name: 'Attachments over 5 MB', icon: 'paperclip', query: 'has:attachment size>5mb' },
  { key: 'leaks', name: 'Disposable address mail', icon: 'envelope-simple', query: 'is:disposable' },
];

export async function viewSuggestions(userId: number): Promise<ApiViewSuggestion[]> {
  if ((await getUserSetting(userId, 'view_suggestions_dismissed')) === '1') return [];
  const have = new Set((await q<{ query: string }>('SELECT query FROM saved_views WHERE user_id = ?', [userId])).map((r) => r.query.toLowerCase()));
  return SUGGESTIONS.filter((s) => !have.has(s.query.toLowerCase()));
}

export async function dismissSuggestions(userId: number): Promise<void> {
  await setUserSetting(userId, 'view_suggestions_dismissed', '1');
}

// ---- notify on match ----
/**
 * For each view with `notify`, test the new message against the view's query (queryEmails with an
 * extra id filter) and emit `view.match`. last_notified_message_id is advanced atomically, so a
 * message notifies at most once per view even if this runs twice.
 */
export async function notifyViewMatches(userId: number, messageId: number): Promise<number> {
  const views = await q<ViewRow>('SELECT * FROM saved_views WHERE user_id = ? AND notify = true', [userId]);
  let fired = 0;
  for (const v of views) {
    if (v.last_notified_message_id !== null && messageId <= v.last_notified_message_id) continue;
    const r = await queryEmails(userId, { filter: { text: v.query, scope: v.scope, messageId }, position: 0, limit: 1 }).catch(() => null);
    if (!r || r.total === 0) continue;
    const claimed = await run(
      'UPDATE saved_views SET last_notified_message_id = ? WHERE id = ? AND (last_notified_message_id IS NULL OR last_notified_message_id < ?)',
      [messageId, v.id, messageId]);
    if (claimed === 0) continue;
    const m = await one<{ from_name: string; from_addr: string; subject: string; account_id: number }>(
      'SELECT from_name, from_addr, subject, account_id FROM messages WHERE id = ?', [messageId]);
    await emitEvent(userId, 'view.match', { type: 'message', id: messageId },
      { viewId: v.id, viewName: v.name, messageId, accountId: m?.account_id, from: m ? `${m.from_name} <${m.from_addr}>` : '', subject: m?.subject ?? '' });
    fired++;
  }
  if (fired) countCache.delete(userId);
  return fired;
}
