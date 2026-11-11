/** Notifications centre: bell summary, paginated/filterable list, read state, prefs, mutes. */
import type { FastifyInstance } from 'fastify';
import type { ApiNotification, ApiNotificationPage, ApiNotificationPref } from '@seamless/shared';
import { q, one, run } from '../db.ts';
import { broadcast } from '../ws.ts';
import { getPrefs, setPrefs } from '../events/notifier.ts';
import { getUserSetting, setUserSetting } from '../classify/settings.ts';
import { uid } from './util.ts';

function toApi(r: any): ApiNotification {
  return {
    id: Number(r.id), type: r.type, title: r.title, body: r.body, link: r.link,
    accountId: r.account_id, accountColor: r.account_color ?? null, count: r.count,
    read: r.read_at !== null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  };
}

const SELECT = `SELECT n.*, a.color AS account_color FROM notifications n LEFT JOIN accounts a ON a.id = n.account_id`;

export interface NotificationQuery {
  status?: 'all' | 'unread' | 'read';
  types?: string[];
  from?: number;
  to?: number;
  accountId?: number;
  categoryId?: number;
  text?: string;
  limit?: number;
  offset?: number;
}

export async function listNotifications(userId: number, f: NotificationQuery): Promise<ApiNotificationPage> {
  const where = ['n.user_id = ?'];
  const params: unknown[] = [userId];
  if (f.status === 'unread') where.push('n.read_at IS NULL');
  if (f.status === 'read') where.push('n.read_at IS NOT NULL');
  if (f.types?.length) { where.push('n.type = ANY(?::text[])'); params.push(f.types); }
  if (f.from) { where.push('n.created_at >= ?'); params.push(f.from); }
  if (f.to) { where.push('n.created_at <= ?'); params.push(f.to); }
  if (f.accountId) { where.push('n.account_id = ?'); params.push(f.accountId); }
  if (f.categoryId) {
    where.push(`n.account_id IN (SELECT m.account_id FROM mailbox_category_members m
                JOIN mailbox_categories c ON c.id = m.category_id WHERE c.id = ? AND c.user_id = ?)`);
    params.push(f.categoryId, userId);
  }
  if (f.text?.trim()) { where.push('(n.title ILIKE ? OR n.body ILIKE ?)'); params.push(`%${f.text.trim()}%`, `%${f.text.trim()}%`); }
  const w = where.join(' AND ');
  const limit = Math.min(Math.max(Number(f.limit) || 25, 1), 200);
  const offset = Math.max(Number(f.offset) || 0, 0);
  const total = (await one<{ c: number }>(`SELECT COUNT(*) AS c FROM notifications n WHERE ${w}`, params))?.c ?? 0;
  const rows = await q(`${SELECT} WHERE ${w} ORDER BY n.updated_at DESC, n.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const unread = (await one<{ c: number }>('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId]))?.c ?? 0;
  return { items: rows.map(toApi), total, unread };
}

const idList = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : []);

export function register(app: FastifyInstance): void {
  app.get('/api/notifications', async (req) => {
    const qs = req.query as Record<string, string | string[] | undefined>;
    const types = ([] as string[]).concat(qs['types[]'] ?? qs.types ?? []).flatMap((t) => String(t).split(',')).filter(Boolean);
    return listNotifications(uid(req), {
      status: (qs.status as any) ?? (qs.unread === '1' ? 'unread' : 'all'),
      types,
      from: qs.from ? Number(qs.from) : undefined,
      to: qs.to ? Number(qs.to) : undefined,
      accountId: qs.accountId ? Number(qs.accountId) : undefined,
      categoryId: qs.categoryId ? Number(qs.categoryId) : undefined,
      text: qs.q as string | undefined,
      limit: qs.limit ? Number(qs.limit) : undefined,
      offset: qs.offset ? Number(qs.offset) : undefined,
    });
  });

  /** Bell dropdown: unread badge + the latest six. */
  app.get('/api/notifications/summary', async (req) => {
    const page = await listNotifications(uid(req), { limit: 6 });
    return { unread: page.unread, latest: page.items };
  });

  app.post('/api/notifications/read', async (req) => {
    const b = (req.body ?? {}) as { ids?: number[]; all?: boolean };
    const now = Date.now();
    if (b.all) await run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now, uid(req)]);
    else if (idList(b.ids).length) await run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ANY(?::bigint[]) AND read_at IS NULL', [now, uid(req), idList(b.ids)]);
    broadcast({ type: 'notifications' }, uid(req));
    return { ok: true };
  });

  app.post('/api/notifications/unread', async (req) => {
    const ids = idList((req.body as any)?.ids);
    // a grouped row can only be reopened if no other unread row holds its group key
    for (const id of ids) {
      await run(`UPDATE notifications n SET read_at = NULL WHERE n.user_id = ? AND n.id = ? AND (n.group_key IS NULL OR NOT EXISTS (
                   SELECT 1 FROM notifications o WHERE o.user_id = n.user_id AND o.group_key = n.group_key AND o.read_at IS NULL AND o.id <> n.id))`,
        [uid(req), id]);
    }
    broadcast({ type: 'notifications' }, uid(req));
    return { ok: true };
  });

  app.delete('/api/notifications/:id', async (req) => {
    await run('DELETE FROM notifications WHERE user_id = ? AND id = ?', [uid(req), Number((req.params as any).id)]);
    broadcast({ type: 'notifications' }, uid(req));
    return { ok: true };
  });

  app.post('/api/notifications/delete', async (req) => {
    const ids = idList((req.body as any)?.ids);
    if (ids.length) await run('DELETE FROM notifications WHERE user_id = ? AND id = ANY(?::bigint[])', [uid(req), ids]);
    broadcast({ type: 'notifications' }, uid(req));
    return { ok: true };
  });

  // ---- Settings → Notifications ----
  app.get('/api/notification-prefs', async (req) => {
    const userId = uid(req);
    const mutes = await q<{ account_id: number }>('SELECT account_id FROM notification_mutes WHERE user_id = ?', [userId]);
    let quiet = { enabled: false, from: '22:00', to: '07:00', tz: 'Australia/Perth' };
    try { quiet = { ...quiet, ...JSON.parse((await getUserSetting(userId, 'notif_quiet')) || '{}') }; } catch { /* default */ }
    const digest = (await getUserSetting(userId, 'notif_digest')) || 'off';
    const sound = (await getUserSetting(userId, 'notif_sound')) === 'true';
    return { prefs: await getPrefs(userId), mutedAccountIds: mutes.map((m) => m.account_id), quiet, digest, sound };
  });

  app.put('/api/notification-prefs', async (req) => {
    const userId = uid(req);
    const b = (req.body ?? {}) as { prefs?: ApiNotificationPref[]; mutedAccountIds?: number[]; quiet?: object; digest?: string; sound?: boolean };
    if (Array.isArray(b.prefs)) await setPrefs(userId, b.prefs);
    if (Array.isArray(b.mutedAccountIds)) {
      await run('DELETE FROM notification_mutes WHERE user_id = ?', [userId]);
      for (const id of idList(b.mutedAccountIds)) {
        await run(`INSERT INTO notification_mutes(user_id, account_id) SELECT ?, id FROM accounts WHERE id = ? AND user_id = ? ON CONFLICT DO NOTHING`, [userId, id, userId]);
      }
    }
    if (b.quiet) await setUserSetting(userId, 'notif_quiet', JSON.stringify(b.quiet));
    if (b.digest) await setUserSetting(userId, 'notif_digest', ['off', 'daily', 'weekly'].includes(b.digest) ? b.digest : 'off');
    if (b.sound !== undefined) await setUserSetting(userId, 'notif_sound', b.sound ? 'true' : 'false');
    return { ok: true };
  });
}
