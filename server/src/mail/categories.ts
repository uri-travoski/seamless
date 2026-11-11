/**
 * Mailbox categories + scope (T1 F-07).
 *
 * A *mailbox* is one connected account. A *category* groups mailboxes (many-to-many).
 * "Unified" is virtual: every mailbox. Every list/count/search takes a scope:
 *   unified | category:<id> | account:<id>
 * which resolves to the set of account ids it covers.
 */
import type { ApiCategory, ApiCategoryOverview } from '@seamless/shared';
import { q, one, run, insertId } from '../db.ts';
import { roleFor, sharedAccountIds, accessibleAccountIds } from '../auth/access.ts';

export const BUILTIN_CATEGORIES = [
  { key: 'work', name: 'Work', icon: 'briefcase', color: '#2f7ed8', ord: 1 },
  { key: 'personal', name: 'Personal', icon: 'house', color: '#3f9c56', ord: 2 },
  { key: 'disposable', name: 'Disposable', icon: 'timer', color: '#b26a00', ord: 3 },
];

/** Idempotent: the built-ins exist for every user (new users, restored DBs, tests). */
export async function ensureBuiltinCategories(userId: number): Promise<void> {
  const have = await one<{ c: number }>('SELECT COUNT(*) AS c FROM mailbox_categories WHERE user_id = ? AND builtin = true', [userId]);
  if ((have?.c ?? 0) >= BUILTIN_CATEGORIES.length) return;
  for (const b of BUILTIN_CATEGORIES) {
    await run(`INSERT INTO mailbox_categories(user_id, key, name, icon, color, sort_order, builtin, created_at)
               VALUES (?,?,?,?,?,?,true,?) ON CONFLICT (user_id, key) DO NOTHING`,
      [userId, b.key, b.name, b.icon, b.color, b.ord, Date.now()]);
  }
}

export type Scope = { kind: 'unified' } | { kind: 'category'; id: number } | { kind: 'account'; id: number } | { kind: 'shared'; id: number };

export function parseScope(raw: string | undefined | null): Scope {
  const s = String(raw ?? '').trim();
  const m = s.match(/^(category|account|shared):(\d+)$/);
  if (m) return { kind: m[1] as 'category' | 'account' | 'shared', id: Number(m[2]) };
  return { kind: 'unified' };
}

/** Account ids a scope covers, or null for "everything" (unified). Always user-scoped. */
export async function scopeAccountIds(userId: number, scope: Scope | string | undefined | null): Promise<number[] | null> {
  const s = typeof scope === 'object' && scope ? scope : parseScope(scope as string);
  if (s.kind === 'unified') return null;
  if (s.kind === 'account') {
    return (await roleFor(userId, s.id)) ? [s.id] : []; // own, or shared with you
  }
  if (s.kind === 'shared') {
    // only a mailbox someone else shared with you
    return (await sharedAccountIds(userId)).includes(s.id) ? [s.id] : [];
  }
  const rows = await q<{ account_id: number }>(`
    SELECT m.account_id FROM mailbox_category_members m
    JOIN mailbox_categories c ON c.id = m.category_id
    JOIN accounts a ON a.id = m.account_id AND a.user_id = c.user_id
    WHERE c.id = ? AND c.user_id = ?`, [s.id, userId]);
  return rows.map((r) => r.account_id);
}

/** Resolve `category:work` / `category:"Clients"` search terms (key or name, case-insensitive). */
export async function categoryIdByName(userId: number, name: string): Promise<number | null> {
  const row = await one<{ id: number }>('SELECT id FROM mailbox_categories WHERE user_id = ? AND (lower(key) = lower(?) OR lower(name) = lower(?))', [userId, name, name]);
  return row?.id ?? null;
}

function slug(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category';
}

/** Switcher data: categories (configured order) with members + inbox unread, and every mailbox. */
export async function categoryOverview(userId: number): Promise<ApiCategoryOverview> {
  await ensureBuiltinCategories(userId);
  const cats = await q<any>('SELECT * FROM mailbox_categories WHERE user_id = ? ORDER BY sort_order, id', [userId]);
  const members = await q<{ category_id: number; account_id: number }>(`
    SELECT m.category_id, m.account_id FROM mailbox_category_members m
    JOIN mailbox_categories c ON c.id = m.category_id WHERE c.user_id = ?`, [userId]);
  // inbox unread per account (what the badges count)
  const unreadRows = await q<{ account_id: number; c: number }>(`
    SELECT m.account_id, COUNT(*) AS c FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.account_id = ANY(?::int[]) AND mb.role = 'inbox' AND m.unread = true GROUP BY m.account_id`,
    [(await accessibleAccountIds(userId)).map((a) => a.id)]);
  const unread = new Map(unreadRows.map((r) => [r.account_id, r.c]));
  const accounts = await q<any>('SELECT id, name, email, color, enabled FROM accounts WHERE user_id = ? ORDER BY lower(coalesce(nullif(name, \'\'), email)), id', [userId]);

  const categories: ApiCategory[] = cats.map((c) => {
    const accountIds = members.filter((m) => m.category_id === c.id).map((m) => m.account_id);
    return {
      id: c.id, key: c.key, name: c.name, icon: c.icon, color: c.color, sortOrder: c.sort_order, builtin: c.builtin,
      accountIds, unread: accountIds.reduce((n, id) => n + (unread.get(id) ?? 0), 0),
    };
  });
  const sharedRows = await q<{ id: number; name: string; email: string; color: string; role: 'viewer' | 'responder' | 'manager'; owner: string }>(`
    SELECT a.id, a.name, a.email, a.color, s.role, u.email AS owner
    FROM mailbox_shares s JOIN accounts a ON a.id = s.account_id JOIN users u ON u.id = a.user_id
    WHERE s.user_id = ? ORDER BY lower(coalesce(nullif(a.name, ''), a.email)), a.id`, [userId]);
  return {
    shared: sharedRows.map((r) => ({ ...r, unread: unread.get(r.id) ?? 0 })),
    unifiedUnread: [...unread.values()].reduce((a, b) => a + b, 0),
    categories,
    mailboxes: accounts.map((a) => ({
      id: a.id, name: a.name, email: a.email, color: a.color, enabled: a.enabled, unread: unread.get(a.id) ?? 0,
      categoryIds: categories.filter((c) => c.accountIds.includes(a.id)).map((c) => c.id),
    })),
  };
}

export async function createCategory(userId: number, b: { name: string; icon?: string; color?: string }): Promise<number> {
  await ensureBuiltinCategories(userId);
  const name = String(b.name ?? '').trim();
  if (!name) throw new Error('name required');
  let key = slug(name);
  for (let i = 2; await one('SELECT 1 FROM mailbox_categories WHERE user_id = ? AND key = ?', [userId, key]); i++) key = `${slug(name)}-${i}`;
  const max = (await one<{ m: number }>('SELECT COALESCE(MAX(sort_order), 0) AS m FROM mailbox_categories WHERE user_id = ?', [userId]))?.m ?? 0;
  return insertId(`INSERT INTO mailbox_categories(user_id, key, name, icon, color, sort_order, builtin, created_at) VALUES (?,?,?,?,?,?,false,?)`,
    [userId, key, name, b.icon || 'folder', b.color || '#6b7280', max + 1, Date.now()]);
}

export async function updateCategory(userId: number, id: number, b: { name?: string; icon?: string; color?: string }): Promise<boolean> {
  const cur = await one<any>('SELECT * FROM mailbox_categories WHERE id = ? AND user_id = ?', [id, userId]);
  if (!cur) return false;
  await run('UPDATE mailbox_categories SET name = ?, icon = ?, color = ? WHERE id = ?',
    [String(b.name ?? cur.name).trim() || cur.name, b.icon ?? cur.icon, b.color ?? cur.color, id]);
  return true;
}

/** Built-ins can't be deleted; deleting a custom category never touches its mailboxes. */
export async function deleteCategory(userId: number, id: number): Promise<'ok' | 'builtin' | 'missing'> {
  const cur = await one<{ builtin: boolean }>('SELECT builtin FROM mailbox_categories WHERE id = ? AND user_id = ?', [id, userId]);
  if (!cur) return 'missing';
  if (cur.builtin) return 'builtin';
  await run('DELETE FROM mailbox_categories WHERE id = ?', [id]);
  return 'ok';
}

export async function setCategoryMembers(userId: number, id: number, accountIds: number[]): Promise<boolean> {
  const cur = await one('SELECT 1 FROM mailbox_categories WHERE id = ? AND user_id = ?', [id, userId]);
  if (!cur) return false;
  await run('DELETE FROM mailbox_category_members WHERE category_id = ?', [id]);
  for (const a of accountIds) {
    await run(`INSERT INTO mailbox_category_members(category_id, account_id)
               SELECT ?, id FROM accounts WHERE id = ? AND user_id = ? ON CONFLICT DO NOTHING`, [id, Number(a), userId]);
  }
  return true;
}

/** The categories one mailbox belongs to (Settings → Mailboxes wizard step 6). */
export async function setAccountCategories(userId: number, accountId: number, categoryIds: number[]): Promise<void> {
  const owned = await one('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
  if (!owned) return;
  await run(`DELETE FROM mailbox_category_members WHERE account_id = ?
             AND category_id IN (SELECT id FROM mailbox_categories WHERE user_id = ?)`, [accountId, userId]);
  for (const c of categoryIds) {
    await run(`INSERT INTO mailbox_category_members(category_id, account_id)
               SELECT id, ? FROM mailbox_categories WHERE id = ? AND user_id = ? ON CONFLICT DO NOTHING`, [accountId, Number(c), userId]);
  }
}

export async function reorderCategories(userId: number, ids: number[]): Promise<void> {
  let i = 1;
  for (const id of ids) await run('UPDATE mailbox_categories SET sort_order = ? WHERE id = ? AND user_id = ?', [i++, Number(id), userId]);
}
