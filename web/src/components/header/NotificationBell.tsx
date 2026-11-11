/** Notification bell, far top-right (T1 F-13): unread badge, latest six, mark all read, see all. */
import { useEffect, useRef, useState } from 'react';
import type { ApiNotification, EventType } from '@seamless/shared';
import { useNotifs, relTime } from '../../state/notifications.ts';
import { navigate } from '../../router.ts';
import {
  BellIcon, SettingsIcon, EnvelopeIcon, EyeIcon, WarningIcon, BackupIcon, ShieldIcon, ScheduledIcon, ChecksIcon,
} from '../../icons.tsx';

export function NotifIcon({ type, size = 16 }: { type: EventType; size?: number }) {
  if (type === 'mail.opened') return <EyeIcon size={size} />;
  if (type.startsWith('mail.') || type === 'disposable.received') return <EnvelopeIcon size={size} />;
  if (type.startsWith('send.') || type === 'sync.failed' || type === 'oauth.expiring') return <WarningIcon size={size} />;
  if (type.startsWith('backup.') || type.startsWith('storage.')) return <BackupIcon size={size} />;
  if (type.startsWith('security.')) return <ShieldIcon size={size} />;
  
  return <ScheduledIcon size={size} />;
}

export function openNotification(n: ApiNotification): void {
  if (!n.read) void useNotifs.getState().markRead([n.id]);
  if (n.link) navigate(n.link);
}

export function NotifRow({ n, onOpen }: { n: ApiNotification; onOpen: () => void }) {
  const isWarn = n.type === 'send.failed' || n.type === 'sync.failed' || n.type === 'backup.failed';
  return (
    <button className={`notif-row ${n.read ? '' : 'unread'} ${isWarn ? 'warn' : ''}`} onClick={onOpen}>
      <span className="notif-icon"><NotifIcon type={n.type} /></span>
      <span className="notif-text">
        <span className="notif-title">{n.title}{n.count > 1 && <span className="notif-count">{n.type === 'mail.opened' ? `Opened ${n.count}×` : `×${n.count}`}</span>}</span>
        {n.body && <span className="notif-body">{n.body}</span>}
      </span>
      <span className="notif-meta">
        {n.accountColor && <span className="acct-dot" style={{ background: n.accountColor }} />}
        <span className="notif-time">{relTime(n.updatedAt)}</span>
        {!n.read && <span className="unread-dot" aria-label="unread" />}
      </span>
    </button>
  );
}

export default function NotificationBell() {
  const unread = useNotifs((s) => s.unread);
  const latest = useNotifs((s) => s.latest);
  const refresh = useNotifs((s) => s.refresh);
  const markRead = useNotifs((s) => s.markRead);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { void refresh(); void useNotifs.getState().loadPrefs(); }, [refresh]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open, refresh]);

  return (
    <div className="notif-bell" ref={ref}>
      <button className="icon-btn bell-btn" onClick={() => setOpen((v) => !v)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} title="Notifications">
        <BellIcon size={20} />
        {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="dropdown notif-pop" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <span className="notif-head-title">Notifications</span>
            <button className="btn ghost small" disabled={unread === 0} onClick={() => void markRead('all')}><ChecksIcon size={14} /> Mark all read</button>
            <button className="icon-btn" title="Notification settings" onClick={() => { setOpen(false); navigate({ page: 'settings', tab: 'notifications' }); }}><SettingsIcon size={16} /></button>
          </div>
          <div className="notif-list">
            {latest.length === 0 && <div className="menu-empty">You're all caught up.</div>}
            {latest.map((n) => <NotifRow key={n.id} n={n} onOpen={() => { setOpen(false); openNotification(n); }} />)}
          </div>
          <button className="switch-foot" onClick={() => { setOpen(false); navigate({ page: 'notifications', params: {} }); }}>See all notifications</button>
        </div>
      )}
    </div>
  );
}
