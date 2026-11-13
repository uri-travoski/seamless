/** Gmail-style action menu for one message (T1 F-16): right-click in the list, "More" in the reading pane. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApiEmail } from '@seamless/shared';
import { useMail } from '../state/mail.ts';
import { actions } from '../state/actions.ts';
import { SnoozeList } from './SnoozeMenu.tsx';
import { FollowupChoices } from './FollowupMenu.tsx';
import { api } from '../api/client.ts';
import { keepMessage, stopWithUndo } from './settings/DisposableSettings.tsx';
import {
  ReplyIcon, ReplyAllIcon, ForwardIcon, EnvelopeIcon, EnvelopeOpenIcon, StarIcon, TagIcon, FolderIcon, JunkIcon,
  TrashIcon, ArchiveIcon, CaretRightIcon, CheckIcon, FilterIcon, SourceIcon, DownloadIcon, PrinterIcon, BlockIcon,
  EyeIcon, InboxIcon, SnoozeIcon, AlarmIcon,
} from '../icons.tsx';

export interface MenuPos { x: number; y: number }

function Sub({ label, Icon, children }: { label: string; Icon: any; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-sub" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className="side-item" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <Icon size={15} /><span className="name">{label}</span><CaretRightIcon size={12} />
      </button>
      {open && <div className="dropdown menu-flyout" role="menu">{children}</div>}
    </div>
  );
}

export function EmailMenuItems({ email, close }: { email: ApiEmail; close: () => void }) {
  const labels = useMail((s) => s.labels);
  const mailboxes = useMail((s) => s.mailboxes);
  const unread = email.keywords.$seen !== true;
  const starred = !!email.keywords.$flagged;
  const inBin = email.mailboxRole === 'trash';
  const inSpam = email.mailboxRole === 'junk';
  const folders = mailboxes.filter((m) => m.accountId === email.accountId && m.id !== email.mailboxId && m.role !== 'scheduled' && m.role !== 'drafts');
  const run = (fn: () => void) => () => { close(); fn(); };
  const item = (label: string, Icon: any, fn: () => void, extra?: string) => (
    <button className={`side-item ${extra ?? ''}`} role="menuitem" onClick={run(fn)}>
      <Icon size={15} /><span className="name">{label}</span>
    </button>
  );

  return (
    <>
      {!email.keywords.$draft && <>
        {item('Reply', ReplyIcon, () => actions.reply(email.id))}
        {item('Reply all', ReplyAllIcon, () => actions.replyAll(email.id))}
        {item('Forward', ForwardIcon, () => actions.forward(email.id))}
        <div className="menu-sep" />
      </>}
      {item(unread ? 'Mark as read' : 'Mark as unread', unread ? EnvelopeOpenIcon : EnvelopeIcon, () => actions.markRead(email.id, unread))}
      {item(starred ? 'Remove star' : 'Star', StarIcon, () => actions.star(email.id))}
      {email.disposable && !email.disposable.kept && email.disposable.deleteAt && item('Keep (do not delete)', CheckIcon, () => void keepMessage(email.id, () => { void useMail.getState().refreshCurrent(); }))}
      {email.disposable?.status === 'active' && item('Stop this address', BlockIcon, () => void stopWithUndo(email.disposable!.id, () => { void useMail.getState().refreshCurrent(); }))}
      {email.mailboxRole === 'inbox' && email.snoozeAllowed !== false && (
        <Sub label="Snooze" Icon={SnoozeIcon}>
          <SnoozeList onPick={(at) => { close(); void actions.snooze(email.id, at); }} />
        </Sub>
      )}
      {email.mailboxRole === 'sent' && (
        <Sub label="Follow up…" Icon={AlarmIcon}>
          <FollowupChoices onPick={(days) => { close(); void actions.followup(email.id, days); }} />
        </Sub>
      )}
      {email.followupId && item('Cancel reminder', AlarmIcon, () => void actions.cancelFollowup(email.followupId!))}
      {email.snoozedUntil && item('Remove snooze', SnoozeIcon, () => { void api.del(`/api/snooze/${encodeURIComponent(email.threadId)}`).then(() => useMail.getState().refreshCurrent()); })}
      <Sub label="Label" Icon={TagIcon}>
        {labels.length === 0 && <div className="menu-empty">No labels yet</div>}
        {labels.map((l) => {
          const on = email.labelIds.includes(l.id);
          return (
            <button key={l.id} className="side-item" role="menuitemcheckbox" aria-checked={on}
              onClick={() => actions.labels(email.id, on ? email.labelIds.filter((x) => x !== l.id) : [...email.labelIds, l.id])}>
              <span className="label-dot" style={{ background: l.color }} /><span className="name">{l.name}</span>{on && <CheckIcon size={13} />}
            </button>
          );
        })}
      </Sub>
      <Sub label="Move to" Icon={FolderIcon}>
        {email.mailboxRole !== 'inbox' && item('Inbox', InboxIcon, () => actions.move(email.id, 'u:inbox', 'Inbox'))}
        {email.mailboxRole !== 'archive' && item('Archive', ArchiveIcon, () => actions.move(email.id, 'u:archive', 'Archive'))}
        {folders.filter((f) => !f.role).map((f) => item(f.name, FolderIcon, () => actions.move(email.id, f.id, f.name)))}
      </Sub>
      <div className="menu-sep" />
      {!inBin && !inSpam && item('Archive', ArchiveIcon, () => actions.archive(email.id))}
      {inSpam ? item('Not spam', InboxIcon, () => actions.notSpam(email.id)) : item('Report spam', JunkIcon, () => actions.spam(email.id))}
      {inBin && item('Restore to Inbox', InboxIcon, () => actions.restore(email.id))}
      {item(inBin || inSpam ? 'Delete forever' : 'Delete', TrashIcon, () => actions.trash(email.id), 'danger-item')}
      {item(email.vip ? 'Remove sender from VIPs' : 'Mark sender as VIP', StarIcon, () => void actions.toggleVip(email.id))}
      {item('Block sender', BlockIcon, () => void actions.blockSender(email.id))}
      {item('Create filter from this…', FilterIcon, () => actions.createFilter(email.id))}
      <div className="menu-sep" />
      {email.openCount >= 0 && item('Open report', EyeIcon, () => actions.openReport(email.id))}
      {item('Print', PrinterIcon, () => void actions.print(email.id))}
      {item('View original', SourceIcon, () => actions.viewOriginal(email.id))}
      {item('Download .eml', DownloadIcon, () => actions.downloadEml(email.id))}
    </>
  );
}

/** Floating context menu at the pointer, kept inside the viewport. */
export function ContextMenu({ email, pos, onClose }: { email: ApiEmail; pos: MenuPos; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(pos);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAt({ x: Math.min(pos.x, window.innerWidth - r.width - 8), y: Math.min(pos.y, window.innerHeight - r.height - 8) });
  }, [pos]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); window.removeEventListener('blur', onClose); };
  }, [onClose]);

  return (
    <div ref={ref} className="dropdown context-menu" role="menu" style={{ position: 'fixed', left: Math.max(8, at.x), top: Math.max(8, at.y) }}
      onContextMenu={(e) => e.preventDefault()}>
      <EmailMenuItems email={email} close={onClose} />
    </div>
  );
}
