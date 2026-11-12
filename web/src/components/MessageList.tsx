import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ApiEmail } from '@seamless/shared';
import { AttachmentMatch } from './AttachmentMatch.tsx';
import { AssigneeChip } from './SharedThread.tsx';
import { useMail, PAGE } from '../state/mail.ts';
import { actions, runBulk } from '../state/actions.ts';
import { useCompose } from '../state/compose.ts';
import LabelPicker from './LabelPicker.tsx';
import { readableTextOn } from './LabelColorPicker.tsx';
import { ContextMenu, type MenuPos } from './EmailMenu.tsx';
import { IconContext } from '@phosphor-icons/react';
import {
  StarIcon, EyeIcon, AttachClipIcon, EnvelopeIcon, EnvelopeOpenIcon, ArchiveIcon, JunkIcon, TrashIcon,
  TableViewIcon, SplitViewIcon, CompactIcon, ComfortableIcon, CloseIcon, NoteIcon, RestoreMailIcon, ReplyIcon, InboxIcon, SnoozeIcon,
} from '../icons.tsx';
import { useSession } from '../state/session.ts';
import { useUi } from '../state/ui.ts';
import QuickStrip from './QuickStrip.tsx';
import SnoozeButton from './SnoozeMenu.tsx';
import { fmtSnoozeLong } from '../snoozeTimes.ts';
import { DENSITY } from '../theme/registry.ts';

const TOOLBAR_ICONS = { weight: 'regular' as const, size: 18 };

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: '2-digit', month: 'short', day: 'numeric' });
}

/** Received date — or, in the Snoozed view, when the message comes back. */
function dateCell(email: ApiEmail): React.ReactNode {
  if (email.readLater && email.readMinutes) return <span className="read-time" title="Estimated reading time">{email.readMinutes} min read · {fmtDate(email.receivedAt)}</span>;
  if (!email.snoozedUntil) return fmtDate(email.receivedAt);
  return <span className="snooze-wake" title="Comes back to your Inbox then"><SnoozeIcon size={13} /> {fmtSnoozeLong(new Date(email.snoozedUntil).getTime())}</span>;
}

/** Countdown chip for mail the retention sweep will trash ("3d" = three days left). */
function TtlBadge({ email }: { email: ApiEmail }) {
  if (email.disposition !== 'delete' || !email.deleteAt) return null;
  const days = Math.ceil((new Date(email.deleteAt).getTime() - Date.now()) / 86_400_000);
  return (
    <span className={`ttl-badge ${days <= 1 ? 'due' : ''}`}
      title={`Auto-deletes ${new Date(email.deleteAt).toLocaleDateString()} (recoverable from Bin for 30 days). Mark unread to keep.`}>
      <TrashIcon size={14} />{days <= 0 ? 'due' : `${days}d`}
    </span>
  );
}

/** 👁 3 on tracked sent mail; hover shows the last open, click opens the report. */
function OpenBadge({ email }: { email: ApiEmail }) {
  if (email.openCount >= 0) {
    const auto = email.autoOpenCount ?? 0;
    const title = email.openCount > 0
      ? `Opened ${email.openCount}× · last ${email.lastOpenAt ? new Date(email.lastOpenAt).toLocaleString() : ''}${auto ? ` · plus ${auto} probable automatic` : ''} — click for the open report`
      : `Tracked — not opened yet${auto ? ` (${auto} probable automatic open${auto === 1 ? '' : 's'})` : ''}`;
    return (
      <button className={`open-badge ${email.openCount > 0 ? 'opened' : ''}`} title={title}
        onClick={(e) => { e.stopPropagation(); actions.openReport(email.id); }}>
        <EyeIcon size={16} />{email.openCount > 0 ? ` ${email.openCount}` : ''}
      </button>
    );
  }
  if (email.threadOpenCount > 0) {
    return (
      <span className="open-badge opened reply-open"
        title={`Your reply in this thread was opened ${email.threadOpenCount}×${email.threadOpenAt ? `, last ${new Date(email.threadOpenAt).toLocaleString()}` : ''}`}>
        <ReplyIcon size={13} /><EyeIcon size={16} /> {email.threadOpenCount}
      </span>
    );
  }
  return null;
}

/** Red chip on a sent message whose delivery failed (T3 F-22). */
function BounceChip({ email }: { email: ApiEmail }) {
  if (!email.bounced?.length) return null;
  return <span className="bounce-chip" title={email.bounced.map((b) => `${b.recipient}: ${b.diagnostic || b.status}`).join('\n')}>Bounced</span>;
}

/** Shield on rows with a phishing / lookalike warning. */
function VipBadge({ email }: { email: ApiEmail }) {
  return email.vip ? <StarIcon size={14} weight="fill" className="vip-badge" aria-label="VIP sender" /> : null;
}

function RiskFlag({ email }: { email: ApiEmail }) {
  if (!email.risk) return null;
  return (
    <span className={`risk-flag ${email.risk.level}`} title={email.risk.reasons.map((r) => r.text).join('\n')}>
      <span aria-label={email.risk.level === 'high' ? 'Possible phishing' : 'Be careful'}>!</span>
    </span>
  );
}

/** Hover actions: archive, delete, read/unread, spam (T1 F-16). */
function RowActions({ email }: { email: ApiEmail }) {
  const unread = email.keywords.$seen !== true;
  const inBin = email.mailboxRole === 'trash';
  const inSpam = email.mailboxRole === 'junk';
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <span className="row-actions" onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn" title={unread ? 'Mark read (Shift+I)' : 'Mark unread (Shift+U)'} onClick={stop(() => actions.markRead(email.id, unread))}>
        {unread ? <EnvelopeOpenIcon size={17} /> : <EnvelopeIcon size={17} />}
      </button>
      {email.mailboxRole === 'inbox' && (
        <button className="icon-btn" title="Snooze (b)" aria-label="Snooze"
          onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); useUi.getState().set({ snoozeFor: { id: email.id, x: r.left - 180, y: r.bottom + 4 } }); }}><SnoozeIcon size={17} /></button>
      )}
      {inBin || inSpam
        ? <button className="icon-btn" title={inSpam ? 'Not spam' : 'Restore to Inbox'} onClick={stop(() => (inSpam ? actions.notSpam(email.id) : actions.restore(email.id)))}><InboxIcon size={17} /></button>
        : <button className="icon-btn" title="Archive (e)" onClick={stop(() => actions.archive(email.id))}><ArchiveIcon size={17} /></button>}
      {!inSpam && <button className="icon-btn" title="Report spam (!)" onClick={stop(() => actions.spam(email.id))}><JunkIcon size={17} /></button>}
      <button className="icon-btn" title={inBin || inSpam ? 'Delete forever' : 'Delete (#)'} onClick={stop(() => actions.trash(email.id))}><TrashIcon size={17} /></button>
    </span>
  );
}

/** Touch swipe: left = archive, right = toggle read. */
function useSwipe(email: ApiEmail) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dx, setDx] = useState(0);
  return {
    dx,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => { start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; },
      onTouchMove: (e: React.TouchEvent) => {
        if (!start.current) return;
        const x = e.touches[0].clientX - start.current.x;
        const y = e.touches[0].clientY - start.current.y;
        if (Math.abs(x) > Math.abs(y) && Math.abs(x) > 10) setDx(Math.max(-140, Math.min(140, x)));
      },
      onTouchEnd: () => {
        if (dx < -90) actions.archive(email.id);
        else if (dx > 90) actions.toggleRead(email.id);
        start.current = null;
        setDx(0);
      },
    },
  };
}

function useRowBits(email: ApiEmail) {
  const labels = useMail((s) => s.labels);
  const isChecked = useMail((s) => s.checked.has(email.id) || s.allMatching);
  const chips = email.labelIds.map((id) => labels.find((l) => l.id === id)).filter(Boolean);
  return { isChecked, chips, unread: email.keywords.$seen !== true, from: email.from[0] };
}

function Row({ email, selected, onMenu }: { email: ApiEmail; selected: boolean; onMenu: (e: React.MouseEvent, email: ApiEmail) => void }) {
  const select = useMail((s) => s.select);
  const toggleChecked = useMail((s) => s.toggleChecked);
  const { isChecked, chips, unread, from } = useRowBits(email);
  const swipe = useSwipe(email);
  const isSent = email.mailboxRole === 'sent';
  const who = isSent ? `To: ${email.to.map((a) => a.name || a.email).join(', ') || '—'}` : (from?.name || from?.email || '(unknown)');

  return (
    <div className="swipe-wrap" style={{ height: '100%' }}>
      {swipe.dx !== 0 && <div className={`swipe-under ${swipe.dx < 0 ? 'left' : 'right'}`}>{swipe.dx < 0 ? <ArchiveIcon /> : <EnvelopeOpenIcon />}</div>}
      <div className={`msg-row ${unread ? 'unread' : ''} ${selected ? 'selected' : ''} ${isChecked ? 'checked' : ''}`}
        style={{ height: '100%', transform: swipe.dx ? `translateX(${swipe.dx}px)` : undefined }}
        onClick={() => void select(email.id)} onContextMenu={(e) => onMenu(e, email)} {...swipe.handlers}>
        <span className="acct-bar" style={{ background: email.accountColor }} title={email.accountEmail} />
        <div className="star-col">
          <input type="checkbox" className="row-check" checked={isChecked} title="Select (x)" aria-label="Select"
            onClick={(e) => e.stopPropagation()} onChange={(e) => toggleChecked(email.id, e.target.checked)} />
          <button className={`star ${email.keywords.$flagged ? 'on' : ''}`} title="Star (s)" aria-label="Star"
            onClick={(e) => { e.stopPropagation(); actions.star(email.id); }}><StarIcon weight={email.keywords.$flagged ? 'fill' : 'regular'} size={18} /></button>
          {unread && <span className="unread-dot" />}
        </div>
        <div className="rest">
          <div className="line1">
            <span className="from">{who}</span>
            <span className="meta-icons">
              <VipBadge email={email} />
              <AssigneeChip email={email} />
              <BounceChip email={email} />
              <BounceChip email={email} />
        <RiskFlag email={email} />
              <OpenBadge email={email} />
              {email.hasNote && <NoteIcon size={18} weight="fill" className="note-flag" aria-label="Has a private note" />}
              {email.hasAttachment && <AttachClipIcon size={14} aria-label="Has attachment" />}
              <TtlBadge email={email} />
            </span>
            <span className="date">{dateCell(email)}</span>
          </div>
          <div className="line2">
            <span className="subject">
              {email.subject || '(no subject)'}
              <span className="snippet">{email.preview ? ` — ${email.preview}` : ''}</span>
            </span>
          </div>
          <AttachmentMatch email={email} />
          {chips.length > 0 && (
            <div className="chips">
              {chips.map((l) => <span key={l!.id} className="chip" style={{ background: l!.color, color: readableTextOn(l!.color), ['--chip' as any]: l!.color }}>{l!.name}</span>)}
            </div>
          )}
        </div>
        <RowActions email={email} />
      </div>
    </div>
  );
}

/** Gmail-style dense single-line row. */
function TableRow({ email, selected, onMenu }: { email: ApiEmail; selected: boolean; onMenu: (e: React.MouseEvent, email: ApiEmail) => void }) {
  const select = useMail((s) => s.select);
  const toggleChecked = useMail((s) => s.toggleChecked);
  const { isChecked, chips, unread, from } = useRowBits(email);
  const isSent = email.mailboxRole === 'sent';
  const who = isSent ? `To: ${email.to.map((a) => a.name || a.email).join(', ') || '—'}` : (from?.name || from?.email || '(unknown)');

  return (
    <div className={`msg-row table ${unread ? 'unread' : ''} ${selected ? 'selected' : ''} ${isChecked ? 'checked' : ''}`} style={{ height: '100%' }}
      onClick={() => void select(email.id)} onContextMenu={(e) => onMenu(e, email)}>
      <span className="acct-bar" style={{ background: email.accountColor }} title={email.accountEmail} />
      <input type="checkbox" className="row-check" checked={isChecked} title="Select (x)" aria-label="Select"
        onClick={(e) => e.stopPropagation()} onChange={(e) => toggleChecked(email.id, e.target.checked)} />
      <button className={`star ${email.keywords.$flagged ? 'on' : ''}`} title="Star (s)" aria-label="Star"
        onClick={(e) => { e.stopPropagation(); actions.star(email.id); }}><StarIcon weight={email.keywords.$flagged ? 'fill' : 'regular'} size={18} /></button>
      <span className="tbl-from">{who}</span>
      <span className="tbl-main">
        {chips.map((l) => <span key={l!.id} className="chip" style={{ background: l!.color, color: readableTextOn(l!.color), ['--chip' as any]: l!.color }}>{l!.name}</span>)}
        <span className="tbl-subject">{email.subject || '(no subject)'}</span>
        {email.preview && <span className="tbl-snippet"> — {email.preview}</span>}
        <AttachmentMatch email={email} />
      </span>
      <span className="tbl-metas">
        <VipBadge email={email} />
        <AssigneeChip email={email} />
        <RiskFlag email={email} />
        <OpenBadge email={email} />
        {email.hasNote && <NoteIcon size={18} weight="fill" className="note-flag" aria-label="Has a private note" />}
        {email.hasAttachment && <AttachClipIcon size={14} aria-label="Has attachment" />}
        <TtlBadge email={email} />
        <span className="tbl-date">{dateCell(email)}</span>
      </span>
      <RowActions email={email} />
    </div>
  );
}

export default function MessageList() {
  const view = useMail((s) => s.view);
  const total = useMail((s) => s.total);
  const ids = useMail((s) => s.ids);
  const emails = useMail((s) => s.emails);
  const selectedId = useMail((s) => s.selectedId);
  const loadPage = useMail((s) => s.loadPage);
  const checkedCount = useMail((s) => s.checked.size);
  const allMatching = useMail((s) => s.allMatching);
  const setAllChecked = useMail((s) => s.setAllChecked);
  const setAllMatching = useMail((s) => s.setAllMatching);
  const clearChecked = useMail((s) => s.clearChecked);
  const mailboxes = useMail((s) => s.mailboxes);
  const layout = useSession((s) => s.settings.layout);
  const density = useSession((s) => s.settings.density);
  const saveSettings = useSession((s) => s.saveSettings);
  const settings = useSession((s) => s.settings);
  const table = layout === 'table';
  const [menu, setMenu] = useState<{ email: ApiEmail; pos: MenuPos } | null>(null);

  const viewMailbox = view.kind === 'mailbox' ? mailboxes.find((m) => m.id === view.mailboxId) : undefined;
  const inBin = viewMailbox?.role === 'trash' || viewMailbox?.role === 'junk';
  const inSpam = viewMailbox?.role === 'junk';

  const loadedCount = ids.filter(Boolean).length;
  const masterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = !allMatching && checkedCount > 0 && checkedCount < loadedCount;
  }, [checkedCount, loadedCount, allMatching]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowH = DENSITY[density ?? 'comfortable'][table ? 'table' : 'split'];

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 12,
  });

  // re-measure when the layout mode or density changes
  useEffect(() => { virtualizer.measure(); }, [rowH, virtualizer]);

  const items = virtualizer.getVirtualItems();

  // request pages for whatever range is visible (server pages of 120)
  useEffect(() => {
    const needed = new Set<number>();
    for (const item of items) needed.add(Math.floor(item.index / PAGE));
    for (const p of needed) void loadPage(p);
  }, [items, loadPage, view]);

  // reset scroll on view change
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [view]);

  // keep the selected row in view when moving with j/k
  useEffect(() => {
    if (!selectedId) return;
    const idx = useMail.getState().ids.indexOf(selectedId);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'auto' });
  }, [selectedId, virtualizer]);

  const openMenu = (e: React.MouseEvent, email: ApiEmail) => {
    e.preventDefault();
    setMenu({ email, pos: { x: e.clientX, y: e.clientY } });
  };

  // Gmail-compatible keyboard shortcuts (toggle in Settings / the "?" cheatsheet)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!useSession.getState().settings.shortcuts) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable], select') || e.ctrlKey || e.metaKey || e.altKey) return;
      const st = useMail.getState();
      const sel = st.selectedId;
      const idx = sel ? st.ids.indexOf(sel) : -1;
      const k = e.key;
      const handled = () => e.preventDefault();
      if (k === 'j') { const next = st.ids[idx + 1]; if (next) { handled(); void st.select(next); } }
      else if (k === 'k') { const prev = st.ids[Math.max(0, idx - 1)]; if (prev && idx > 0) { handled(); void st.select(prev); } }
      else if ((k === 'o' || k === 'Enter') && !sel && st.ids[0]) { handled(); void st.select(st.ids[0]); }
      else if (k === 'u' && sel) { handled(); void st.select(null); }
      else if (k === 'c') { handled(); useCompose.getState().openBlank(); }
      else if (k === '/') { handled(); (document.getElementById('global-search') as HTMLInputElement | null)?.focus(); }
      else if (!sel) return;
      else if (k === 'x') { handled(); st.toggleChecked(sel); }
      else if (k === 'e') { handled(); actions.archive(sel); }
      else if (k === '#') { handled(); actions.trash(sel); }
      else if (k === '!') { handled(); actions.spam(sel); }
      else if (k === 's') { handled(); actions.star(sel); }
      else if (k === 'I') { handled(); actions.markRead(sel, true); }
      else if (k === 'U') { handled(); actions.markRead(sel, false); }
      else if (k === 'r') { handled(); actions.reply(sel); }
      else if (k === 'a') { handled(); actions.replyAll(sel); }
      else if (k === 'f') { handled(); actions.forward(sel); }
      else if (k === 'b') {
        handled();
        const row = document.querySelector('.msg-row.selected') as HTMLElement | null;
        const r = row?.getBoundingClientRect();
        useUi.getState().set({ snoozeFor: { id: sel, x: (r?.left ?? 200) + 60, y: (r?.bottom ?? 200) } });
      }
      else if (k === 'l' || k === 'v') {
        handled();
        const em = st.emails[sel];
        const row = document.querySelector('.msg-row.selected') as HTMLElement | null;
        const r = row?.getBoundingClientRect();
        if (em) setMenu({ email: em, pos: { x: (r?.left ?? 200) + 60, y: (r?.bottom ?? 200) } });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectedCount = allMatching ? total : checkedCount;
  const pageAllChecked = loadedCount > 0 && checkedCount >= loadedCount;

  return (
    <section className={`list-pane ${table ? 'table-list' : ''}`}>
      <IconContext.Provider value={TOOLBAR_ICONS}>
      {selectedCount > 0 ? (
        <div className="list-toolbar bulk">
          <input ref={masterRef} type="checkbox" className="row-check master" title="Select all on this page"
            checked={allMatching || pageAllChecked} onChange={(e) => setAllChecked(e.target.checked)} />
          <span className="bulk-count">{selectedCount.toLocaleString()} selected</span>
          {inBin
            ? <button className="icon-btn" title={inSpam ? 'Not spam' : 'Restore to Inbox'} onClick={() => void runBulk('inbox')}><RestoreMailIcon /></button>
            : <button className="icon-btn" title="Archive" onClick={() => void runBulk('archive')}><ArchiveIcon /></button>}
          {!inSpam && <button className="icon-btn" title="Report spam" onClick={() => void runBulk('spam')}><JunkIcon /></button>}
          <button className="icon-btn" title={inBin ? 'Delete forever' : 'Delete'} onClick={() => void runBulk('delete')}><TrashIcon /></button>
          <button className="icon-btn" title="Mark read" onClick={() => void runBulk('read')}><EnvelopeOpenIcon /></button>
          <button className="icon-btn" title="Mark unread" onClick={() => void runBulk('unread')}><EnvelopeIcon /></button>
          <button className="icon-btn" title="Star" onClick={() => void runBulk('star')}><StarIcon /></button>
          <LabelPicker value={[]} onChange={(ids2) => ids2.forEach((id) => void runBulk('label', id))} />
          <MoveMenu onPick={(target) => void runBulk('move', target)} />
          <SnoozeButton title="Snooze" onPick={(at) => void runBulk('snooze', at)} />
          <div style={{ flex: 1 }} />
          <button className="icon-btn" title="Clear selection" onClick={() => clearChecked()}><CloseIcon /></button>
        </div>
      ) : (
        <div className="list-toolbar">
          <input type="checkbox" className="row-check master always" title="Select all on this page" aria-label="Select all on this page"
            checked={false} disabled={total === 0} onChange={() => setAllChecked(true)} />
          <span className="title">{view.title}<span className="total">{total > 0 ? total.toLocaleString() : ''}</span></span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title={table ? 'Split view' : 'Table view'}
            onClick={() => saveSettings({ layout: table ? 'split' : 'table' })}>
            {table ? <SplitViewIcon /> : <TableViewIcon />}
          </button>
          <button className="icon-btn" title={settings.density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
            onClick={() => saveSettings({ density: settings.density === 'compact' ? 'comfortable' : 'compact' })}>
            {settings.density === 'compact' ? <ComfortableIcon /> : <CompactIcon />}
          </button>
        </div>
      )}
      {!checkedCount && <QuickStrip view={view} unread={viewMailbox?.unreadEmails ?? 0} />}
      {!allMatching && pageAllChecked && total > checkedCount && (
        <div className="select-all-banner">
          All {checkedCount.toLocaleString()} loaded messages are selected.{' '}
          <button className="linklike" onClick={() => setAllMatching(true)}>Select all {total.toLocaleString()} in “{view.title}”</button>
        </div>
      )}
      {allMatching && (
        <div className="select-all-banner">
          All {total.toLocaleString()} messages in “{view.title}” are selected.{' '}
          <button className="linklike" onClick={() => clearChecked()}>Clear selection</button>
        </div>
      )}
      </IconContext.Provider>
      <div className="list-scroll" ref={scrollRef}>
        {total === 0 && <div className="list-empty">No messages here.</div>}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((item) => {
            const id = ids[item.index];
            const email = id ? emails[id] : undefined;
            return (
              <div key={item.key} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: item.size, transform: `translateY(${item.start}px)` }}>
                {email
                  ? (table ? <TableRow email={email} selected={id === selectedId} onMenu={openMenu} /> : <Row email={email} selected={id === selectedId} onMenu={openMenu} />)
                  : <div className="msg-row" style={{ height: '100%' }}><div className="rest"><div className="line1"><span className="from skeleton" /></div><div className="line2"><span className="subject skeleton wide" /></div></div></div>}
              </div>
            );
          })}
        </div>
      </div>
      {menu && <ContextMenu email={menu.email} pos={menu.pos} onClose={() => setMenu(null)} />}
    </section>
  );
}

/** "Move to" for the bulk bar: unified folders (per account target resolved server-side). */
function MoveMenu({ onPick }: { onPick: (target: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  const targets: [string, string][] = [['u:inbox', 'Inbox'], ['u:archive', 'Archive'], ['u:junk', 'Spam'], ['u:trash', 'Bin']];
  return (
    <div className="label-menu" ref={ref}>
      <button className={`icon-btn ${open ? 'active' : ''}`} title="Move to" onClick={() => setOpen(!open)}><InboxIcon /></button>
      {open && (
        <div className="dropdown">
          <div className="switch-head">Move to</div>
          {targets.map(([t, name]) => (
            <button key={t} className="side-item" onClick={() => { setOpen(false); onPick(t); }}><span className="name">{name}</span></button>
          ))}
        </div>
      )}
    </div>
  );
}
