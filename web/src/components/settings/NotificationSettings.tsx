/** Settings → Notifications (T1 F-14): per-type in-app / push, mailbox mutes, quiet hours, sound. */
import { useEffect, useState } from 'react';
import { NOTIFICATION_GROUPS, type ApiNotificationPref, type EventType } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { useMail } from '../../state/mail.ts';
import { useNotifs } from '../../state/notifications.ts';
import { toast } from '../../toast.ts';

interface Prefs {
  prefs: ApiNotificationPref[];
  mutedAccountIds: number[];
  quiet: { enabled: boolean; from: string; to: string; tz: string };
  sound: boolean;
}

const TYPE_NAMES: Partial<Record<EventType, string>> = {
  'mail.received': 'New mail', 'disposable.received': 'Mail to a disposable address', 'disposable.leak': 'A disposable address may have leaked', 'mail.opened': 'Someone opened your email',
  'reminder.due': 'Reminders', 'followup.due': 'Follow-ups due', 'snooze.woke': 'Snoozed mail is back',
  'send.failed': 'A message couldn’t be sent', 'mail.bounced': 'Bounces', 'sync.failed': 'A mailbox can’t sync', 'oauth.expiring': 'Sign-in expiring',
  'job.failed': 'A background task failed', 'storage.unreachable': 'Mail storage unreachable', 'backup.failed': 'Backup failed', 'backup.ok': 'Backup completed', 'storage.migration.done': 'Storage move finished', 'storage.migration.failed': 'Storage move failed',
  'security.login': 'New sign-in', 'security.2fa_changed': 'Two-factor changed', 'lead.captured': 'New lead', 'assignment.changed': 'Assigned to you', 'comment.mention': 'Mentioned in a comment',
};

export default function NotificationSettings() {
  const overview = useMail((s) => s.overview);
  const [p, setP] = useState<Prefs | null>(null);

  useEffect(() => { void api.get<Prefs>('/api/notification-prefs').then(setP).catch(() => {}); }, []);

  const persist = async (next: Prefs) => {
    setP(next);
    try {
      await api.put('/api/notification-prefs', next);
      useNotifs.setState({ sound: next.sound });
    } catch { toast('Could not save', 'error'); }
  };
  if (!p) return <div><h2>Notifications</h2><p className="dim">Loading…</p></div>;

  const setPref = (type: EventType, key: 'inApp' | 'push', v: boolean) =>
    void persist({ ...p, prefs: p.prefs.map((x) => (x.type === type ? { ...x, [key]: v } : x)) });

  return (
    <div>
      <h2>Notifications</h2>
      <p className="settings-desc">Choose what reaches the bell and what pushes to your devices.</p>

      <div className="table-scroll">
        <table className="tbl pref-matrix">
          <thead><tr><th>Type</th><th>In-app</th><th>Push</th></tr></thead>
          <tbody>
            {NOTIFICATION_GROUPS.map((g) => g.types.map((type, i) => {
              const pref = p.prefs.find((x) => x.type === type);
              if (!pref) return null;
              return (
                <tr key={type}>
                  <td>{i === 0 && <span className="group-name">{g.name}</span>}<span className={i === 0 ? 'type-name first' : 'type-name'}>{TYPE_NAMES[type] ?? type}</span></td>
                  <td><input type="checkbox" checked={pref.inApp} onChange={(e) => setPref(type, 'inApp', e.target.checked)} aria-label={`${type} in-app`} /></td>
                  <td><input type="checkbox" checked={pref.push} onChange={(e) => setPref(type, 'push', e.target.checked)} aria-label={`${type} push`} /></td>
                </tr>
              );
            }))}
          </tbody>
        </table>
      </div>

      <h3>Mute mailboxes</h3>
      <p className="settings-desc">Muted mailboxes still get mail; they just don't notify.</p>
      <div className="cat-checks">
        {(overview?.mailboxes ?? []).map((m) => (
          <label key={m.id} className="cat-check">
            <input type="checkbox" checked={p.mutedAccountIds.includes(m.id)}
              onChange={(e) => void persist({ ...p, mutedAccountIds: e.target.checked ? [...p.mutedAccountIds, m.id] : p.mutedAccountIds.filter((x) => x !== m.id) })} />
            <span className="acct-dot" style={{ background: m.color }} />{m.name || m.email}
          </label>
        ))}
      </div>

      <h3>Quiet hours</h3>
      <label className="checkbox-line">
        <input type="checkbox" checked={p.quiet.enabled} onChange={(e) => void persist({ ...p, quiet: { ...p.quiet, enabled: e.target.checked } })} />
        Hold push notifications between
        <input type="time" className="text-input compact inline" value={p.quiet.from} onChange={(e) => void persist({ ...p, quiet: { ...p.quiet, from: e.target.value } })} />
        and
        <input type="time" className="text-input compact inline" value={p.quiet.to} onChange={(e) => void persist({ ...p, quiet: { ...p.quiet, to: e.target.value } })} />
        <span className="dim">({p.quiet.tz.replace('_', ' ')} time)</span>
      </label>

      <h3>Sound</h3>
      <label className="checkbox-line">
        <input type="checkbox" checked={p.sound} onChange={(e) => void persist({ ...p, sound: e.target.checked })} />
        Play a chime when a new notification arrives
      </label>
    </div>
  );
}
