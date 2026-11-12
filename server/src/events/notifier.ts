/**
 * Event → notification. Per-user prefs decide in-app / push; a muted mailbox records the
 * event but raises nothing; repeats with the same group key collapse into one unread row
 * with a count ("Opened 5x").
 */
import type { EventType, ApiNotificationPref } from '@seamless/shared';
import { q, one, run } from '../db.ts';
import { broadcast } from '../ws.ts';
import { notifyUser } from '../push.ts';
import { bypassQuiet } from '../mail/vip.ts';

export interface EventRow {
  id: number;
  user_id: number;
  type: EventType;
  subject_type: string | null;
  subject_id: string | null;
  payload: Record<string, any>;
  created_at: number;
}

/** Defaults when the user hasn't set a preference for a type. */
export const DEFAULT_PREFS: Record<EventType, { inApp: boolean; push: boolean }> = {
  'mail.received': { inApp: true, push: true },        // push was always on for new mail
  'mail.opened': { inApp: true, push: false },
  'mail.bounced': { inApp: true, push: false },
  'send.failed': { inApp: true, push: true },
  'send.sent': { inApp: false, push: false },
  'reminder.due': { inApp: true, push: true },
  'snooze.woke': { inApp: true, push: false },
  'followup.due': { inApp: true, push: true },
  'sync.failed': { inApp: true, push: false },
  'oauth.expiring': { inApp: true, push: false },
  'job.failed': { inApp: true, push: false },
  'storage.unreachable': { inApp: true, push: true },
  'backup.failed': { inApp: true, push: true },        // was a direct push to admins; the alert email stays in backup/schedule.ts
  'backup.ok': { inApp: false, push: false },
  'storage.migration.done': { inApp: true, push: false },
  'storage.migration.failed': { inApp: true, push: false },
  'export.created': { inApp: true, push: false },
  'export.imported': { inApp: true, push: false },
  'disposable.received': { inApp: true, push: false },
  'disposable.leak': { inApp: true, push: true },
  'lead.captured': { inApp: true, push: true },
  'view.match': { inApp: true, push: false },
  'assignment.changed': { inApp: true, push: true },
  'comment.mention': { inApp: true, push: true },
  'security.login': { inApp: false, push: false },     // opt-in: one per sign-in is noisy
  'security.2fa_changed': { inApp: true, push: false },
  'webhook.failed': { inApp: true, push: false },
  'quota.warning': { inApp: true, push: true },
  'quota.full': { inApp: true, push: true },
  'labels.offered': { inApp: true, push: true },
  'archive.done': { inApp: true, push: false },
  'archive.failed': { inApp: true, push: true },
};

export const ALL_EVENT_TYPES = Object.keys(DEFAULT_PREFS) as EventType[];

export async function getPrefs(userId: number): Promise<ApiNotificationPref[]> {
  const rows = await q<{ type: EventType; in_app: boolean; push: boolean; email_digest: boolean }>(
    'SELECT type, in_app, push, email_digest FROM notification_prefs WHERE user_id = ?', [userId]);
  const byType = new Map(rows.map((r) => [r.type, r]));
  return ALL_EVENT_TYPES.map((type) => {
    const r = byType.get(type);
    const d = DEFAULT_PREFS[type];
    return { type, inApp: r ? r.in_app : d.inApp, push: r ? r.push : d.push, emailDigest: r ? r.email_digest : false };
  });
}

export async function setPrefs(userId: number, prefs: ApiNotificationPref[]): Promise<void> {
  for (const p of prefs) {
    if (!ALL_EVENT_TYPES.includes(p.type)) continue;
    await run(`INSERT INTO notification_prefs(user_id, type, in_app, push, email_digest) VALUES (?,?,?,?,?)
               ON CONFLICT (user_id, type) DO UPDATE SET in_app = excluded.in_app, push = excluded.push, email_digest = excluded.email_digest`,
      [userId, p.type, !!p.inApp, !!p.push, !!p.emailDigest]);
  }
}

async function prefFor(userId: number, type: EventType) {
  const r = await one<{ in_app: boolean; push: boolean }>('SELECT in_app, push FROM notification_prefs WHERE user_id = ? AND type = ?', [userId, type]);
  const d = DEFAULT_PREFS[type] ?? { inApp: true, push: false };
  return { inApp: r ? r.in_app : d.inApp, push: r ? r.push : d.push };
}

/** "22:00"–"07:00" in the user's zone (default Australia/Perth). Push is held during it. */
async function inQuietHours(userId: number, now: number): Promise<boolean> {
  const row = await one<{ value: string }>("SELECT value FROM user_settings WHERE user_id = ? AND key = 'notif_quiet'", [userId]);
  if (!row) return false;
  let cfg: { enabled?: boolean; from?: string; to?: string; tz?: string };
  try { cfg = JSON.parse(row.value); } catch { return false; }
  if (!cfg.enabled || !cfg.from || !cfg.to) return false;
  const tz = cfg.tz || 'Australia/Perth';
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now));
  const mins = (s: string) => { const [h, m] = s.split(':').map(Number); return (h % 24) * 60 + (m || 0); };
  const cur = mins(hm), from = mins(cfg.from), to = mins(cfg.to);
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

interface Rendered { title: string; body: string; link: string | null; groupKey: string | null; accountId: number | null }

/** `"Priya Shah" <priya@x>` → Priya Shah; a bare address stays as it is. */
export function displayName(from: string): string {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? (m[1].trim() || m[2].trim()) : from.trim();
}

const quote = (s: unknown) => `"${String(s ?? '').slice(0, 120) || '(no subject)'}"`;

export function render(ev: EventRow): Rendered {
  const p = ev.payload ?? {};
  const accountId = typeof p.accountId === 'number' ? p.accountId : null;
  switch (ev.type) {
    case 'mail.received':
      return { title: p.vip ? `★ ${displayName(String(p.from ?? '')) || 'VIP'}` : p.risk === 'high' ? `Possible phishing: ${displayName(String(p.from ?? '')) || 'unknown sender'}` : displayName(String(p.from ?? '')) || 'New mail', body: String(p.subject || '(no subject)'), link: p.messageId ? `/mail/msg/m${p.messageId}` : null, groupKey: null, accountId };
    case 'disposable.received':
      return { title: `New mail to ${p.address ?? 'a disposable address'}`, body: String(p.subject ?? ''), link: p.messageId ? `/mail/msg/m${p.messageId}` : null, groupKey: null, accountId };
    case 'disposable.leak':
      return { title: `${p.label || p.address || 'A disposable address'} may have been leaked`, body: `Mail arrived from ${p.senderDomain ?? 'another domain'}, but you signed up with ${p.signupDomain ?? 'someone else'}`, link: p.messageId ? `/mail/msg/m${p.messageId}` : '/settings/disposable', groupKey: `leak:${p.disposableId}:${p.senderDomain}`, accountId };
    case 'mail.opened':
      return {
        title: `${p.recipient || 'Your recipient'} opened ${quote(p.subject)}`,
        body: p.proxied ? 'Probably an automatic open (mail privacy proxy)' : (p.client ? `On ${p.client}` : ''),
        link: p.messageId ? `/mail/msg/m${p.messageId}/opens` : null,
        // per-recipient sends group per person; a normal send has one token per message
        groupKey: p.messageId ? `opened:msg:${p.messageId}${p.perRecipient ? `:${p.token}` : ''}` : null, accountId,
      };
    case 'send.failed':
      return { title: `Couldn't send ${quote(p.subject)}`, body: String(p.error ?? ''), link: '/mail/drafts', groupKey: null, accountId };
    case 'mail.bounced':
      return { title: `Bounced: ${p.recipient ?? 'a recipient'}`, body: `${quote(p.subject)}${p.error ? ` — ${p.error}` : ''}`, link: p.messageId ? `/mail/msg/m${p.messageId}` : null, groupKey: null, accountId };
    case 'send.sent':
      return { title: `Sent ${quote(p.subject)}`, body: '', link: p.messageId ? `/mail/msg/m${p.messageId}` : null, groupKey: null, accountId };
    case 'sync.failed':
      return { title: `Can't sync ${p.email ?? 'a mailbox'}`, body: String(p.error ?? ''), link: '/settings/mailboxes', groupKey: `sync:${accountId ?? p.email}`, accountId };
    case 'oauth.expiring':
      return { title: `Reconnect ${p.email ?? 'a mailbox'}`, body: 'Its sign-in is about to expire', link: '/settings/mailboxes', groupKey: `oauth:${accountId}`, accountId };
    case 'storage.unreachable':
      return { title: 'Mail storage is unreachable', body: String(p.error ?? ''), link: '/settings/health', groupKey: 'storage:unreachable', accountId: null };
    case 'job.failed':
      return { title: 'A background task failed', body: `${p.kind ?? ''}: ${p.error ?? ''}`.trim(), link: '/settings/health', groupKey: null, accountId: null };
    case 'backup.failed':
      return { title: 'Backup failed', body: String(p.error ?? ''), link: '/settings/backup', groupKey: 'backup:failed', accountId: null };
    case 'backup.ok':
      return { title: 'Backup completed', body: p.rows ? `${p.rows} rows saved` : '', link: '/settings/backup', groupKey: 'backup:ok', accountId: null };
    case 'export.created':
      return { title: 'Full export created', body: p.includeMail ? `${p.rows} rows and ${p.blobs} messages` : `${p.rows} rows`, link: '/settings/backup', groupKey: null, accountId: null };
    case 'export.imported':
      return { title: p.mode === 'settings' ? 'Settings imported from an export' : 'Instance restored from an export', body: p.mode === 'settings' ? `${p.added ?? 0} added, ${p.skipped ?? 0} skipped` : `${p.rows} rows`, link: '/settings/backup', groupKey: null, accountId: null };
    case 'security.login':
      return { title: 'New sign-in', body: [p.ip ? `from ${p.ip}` : '', p.mfa ? `(2FA: ${p.mfa})` : ''].filter(Boolean).join(' '), link: '/settings/security', groupKey: null, accountId: null };
    case 'security.2fa_changed':
      return { title: p.enabled ? 'Two-factor sign-in turned on' : 'Two-factor sign-in turned off', body: '', link: '/settings/security', groupKey: null, accountId: null };
    case 'assignment.changed':
      if (p.auto) return { title: `${p.assignee ?? 'Someone'} was assigned a new thread`, body: String(p.subject || '(no subject)'), link: p.messageId ? `/mail/msg/m${p.messageId}` : null, groupKey: null, accountId };
      return { title: `${p.by ?? 'Someone'} assigned you a thread`, body: String(p.subject || '(no subject)'), link: p.messageId ? `/mail/msg/m${p.messageId}` : null, groupKey: null, accountId };
    case 'view.match':
      return { title: `New in ${quote(p.viewName)}`, body: [p.from ? displayName(String(p.from)) : '', p.subject || '(no subject)'].filter(Boolean).join(': '), link: p.messageId ? `/mail/msg/m${p.messageId}` : null, groupKey: null, accountId };
    case 'comment.mention':
      return { title: `${p.by ?? 'Someone'} mentioned you`, body: `${p.subject ? quote(p.subject) + ': ' : ''}${p.excerpt ?? ''}`, link: p.messageId ? `/mail/msg/m${p.messageId}` : null, groupKey: null, accountId };
    case 'lead.captured':
      return { title: `${p.repeat ? 'Repeat enquiry' : 'New lead'}: ${String(p.name || p.email || p.phone || 'unknown').slice(0, 80)}`, body: [p.service, p.suburb, p.businessName || p.source].filter(Boolean).join(' · '), link: `/leads?lead=${p.leadId}`, groupKey: null, accountId };
    case 'webhook.failed':
      return { title: `Webhook "${String(p.name ?? 'webhook').slice(0, 60)}" is failing`, body: `Gave up delivering ${p.eventType ?? 'an event'}: ${String(p.error ?? '').slice(0, 200)}`, link: '/settings/integrations', groupKey: `webhook:${p.webhookId}`, accountId: null };
    case 'quota.warning':
    case 'quota.full': {
      const full = ev.type === 'quota.full';
      const gb = (n: unknown) => `${Math.round((Number(n) / 1024 ** 3) * 10) / 10} GB`;
      const use = `${gb(p.usedBytes)} of ${gb(p.quotaBytes)}`;
      if (p.own) {
        return { title: full ? 'Your mailbox space is full' : `Your mailbox space is ${p.percent}% used`, body: full ? `${use}. Mail keeps arriving and nothing is deleted, but ask your administrator for more space.` : use, link: '/settings/storage', groupKey: null, accountId: null };
      }
      return { title: `${p.email ?? 'A user'} ${full ? 'has used all of their mailbox space' : `is ${p.percent}% full`}`, body: `${use}. Nothing is refused or deleted.`, link: '/settings/users', groupKey: null, accountId: null };
    }
    case 'archive.done':
    case 'archive.failed': {
      const bad = ev.type === 'archive.failed';
      const n = Number(p.archived ?? 0);
      return {
        title: bad ? `Archive "${String(p.name ?? '').slice(0, 60)}" failed` : `Archive "${String(p.name ?? '').slice(0, 60)}" is finished`,
        body: bad ? String(p.error ?? 'Something went wrong.').slice(0, 200)
          : `${n.toLocaleString()} message${n === 1 ? '' : 's'} ${p.mode === 'move' ? 'moved' : 'copied'}${p.failed ? `, ${p.failed} could not be verified and ${p.mode === 'move' ? 'stayed in the app' : 'were left out'}` : ''}.`,
        link: '/settings/backup', groupKey: null, accountId: null,
      };
    }
    case 'labels.offered':
      return { title: `${p.ownerName ?? 'Someone'} shared ${p.count ?? 'some'} label${p.count === 1 ? '' : 's'} from ${p.email ?? 'a mailbox'}`, body: 'Accept or reject them in Settings → Labels.', link: '/settings/labels', groupKey: null, accountId };
    case 'reminder.due':
    case 'followup.due':
    case 'snooze.woke':
      return { title: String(p.title ?? ev.type), body: String(p.subject ?? ''), link: p.messageId ? `/mail/msg/m${p.messageId}` : null, groupKey: null, accountId };
    default:
      return { title: String(p.title ?? ev.type), body: String(p.body ?? ''), link: (p.link as string) ?? null, groupKey: null, accountId };
  }
}

export async function notifyFromEvent(ev: EventRow): Promise<number | null> {
  let pref = await prefFor(ev.user_id, ev.type);
  const vip = ev.type === 'mail.received' && ev.payload?.vip === true;
  if (vip) pref = { inApp: true, push: true }; // VIP mail always notifies
  if (!pref.inApp && !pref.push) return null;
  const r = render(ev);
  if (r.accountId !== null) {
    const muted = await one('SELECT 1 FROM notification_mutes WHERE user_id = ? AND account_id = ?', [ev.user_id, r.accountId]);
    if (muted) return null;
  }

  let id: number | null = null;
  if (pref.inApp) {
    const now = Date.now();
    const row = await one<{ id: number }>(`
      INSERT INTO notifications(user_id, event_id, type, title, body, link, account_id, group_key, count, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL
      DO UPDATE SET count = notifications.count + 1, updated_at = excluded.updated_at,
                    event_id = excluded.event_id, body = excluded.body
      RETURNING id`,
      [ev.user_id, ev.id, ev.type, r.title, r.body, r.link, r.accountId, r.groupKey, now, now]);
    id = row?.id ?? null;
    broadcast({ type: 'notifications' }, ev.user_id);
  }
  if (pref.push && ((vip && (await bypassQuiet(ev.user_id))) || !(await inQuietHours(ev.user_id, Date.now())))) {
    void notifyUser(ev.user_id, r.title, r.body, r.groupKey ?? `${ev.type}-${ev.id}`).catch(() => {});
  }
  return id;
}
