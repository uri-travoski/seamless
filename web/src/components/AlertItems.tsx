/** Red, pinned critical alerts (T8.9): the rows in the bell and on the notifications page, and the pill in the top bar. */
import { useAlerts, type AppAlert } from '../state/alerts.ts';
import { useSession } from '../state/session.ts';
import { relTime } from '../state/notifications.ts';
import { navigate } from '../router.ts';
import { WarningIcon, ChecksIcon } from '../icons.tsx';

export function AlertRow({ a, onOpen }: { a: AppAlert; onOpen?: () => void }) {
  const markRead = useAlerts((s) => s.markRead);
  const fixed = a.state === 'resolved';
  return (
    <div className={`alert-row ${fixed ? 'fixed' : ''}`} role="alert">
      <button className="alert-main" onClick={() => { onOpen?.(); if (a.link) navigate(a.link); }}>
        <span className="alert-icon"><WarningIcon size={18} /></span>
        <span className="alert-text">
          <span className="alert-title">{a.title}{fixed && <span className="alert-fixed">Fixed</span>}</span>
          <span className="alert-body">{fixed ? 'This problem has been fixed. Mark it read when you have seen it.' : a.body}</span>
          <span className="alert-time">{relTime(a.openedAt)}{a.sendCount > 0 ? ` · sent ${a.sendCount}×` : ''}</span>
        </span>
      </button>
      <button className="btn small alert-read" onClick={() => void markRead(a.id)} title="Mark this alert as read"><ChecksIcon size={14} /> Mark read</button>
    </div>
  );
}

export function AlertList({ onOpen }: { onOpen?: () => void }) {
  const items = useAlerts((s) => s.items);
  if (!items.length) return null;
  return <div className="alert-list" aria-label="Critical alerts">{items.map((a) => <AlertRow key={a.id} a={a} onOpen={onOpen} />)}</div>;
}

/** Top-bar pill: only there while something critical is unread. */
export function AlertPill() {
  const active = useAlerts((s) => s.status.active);
  const open = useAlerts((s) => s.status.open);
  if (!active) return null;
  return (
    <button className="alert-pill" onClick={() => navigate({ page: 'notifications', params: {} })}
      title={open ? `${open} problem${open === 1 ? '' : 's'} need attention` : 'Fixed problems waiting to be read'} aria-label={`${active} critical alert${active === 1 ? '' : 's'}`}>
      <WarningIcon size={14} /> {active} critical
    </button>
  );
}

/** Existing installs: red until at least one outside channel has passed its test. */
export function NoChannelBanner() {
  const has = useAlerts((s) => s.status.hasChannel);
  const viewing = useSession((s) => s.mode === 'viewing');
  if (has || viewing) return null;
  return (
    <div className="alert-banner" role="alert">
      <WarningIcon size={16} /> No alert channel set up — you will not be told if a mailbox stops working.
      <button className="btn small" onClick={() => navigate({ page: 'settings', tab: 'alerts' })}>Set up alerts</button>
    </div>
  );
}
