import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMail, PAGE } from '../state/mail.ts';
import LabelPicker from './LabelPicker.tsx';
import { IconContext } from '@phosphor-icons/react';
import { StarIcon, EyeIcon, AttachClipIcon, EnvelopeIcon, EnvelopeOpenIcon, ArchiveIcon, JunkIcon, TrashIcon, RefreshIcon, TableViewIcon, SplitViewIcon, CloseIcon, NoteIcon, RestoreMailIcon } from '../icons.tsx';
import { useSession } from '../state/session.ts';

const TOOLBAR_ICONS = { weight: 'regular' as const, size: 18 };
import type { ApiEmail } from '@seamless/shared';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: '2-digit', month: 'short', day: 'numeric' });
}

function Row({ email, selected }: { email: ApiEmail; selected: boolean }) {
  const labels = useMail((s) => s.labels);
  const select = useMail((s) => s.select);
  const toggleStar = useMail((s) => s.toggleStar);
  const toggleChecked = useMail((s) => s.toggleChecked);
  const isChecked = useMail((s) => s.checked.has(email.id));
  const unread = email.keywords.$seen !== true;
  const from = email.from[0];
  const chips = email.labelIds.map((id) => labels.find((l) => l.id === id)).filter(Boolean);

  return (
    <div className={`msg-row ${unread ? 'unread' : ''} ${selected ? 'selected' : ''} ${isChecked ? 'checked' : ''}`} style={{ height: '100%' }}
      onClick={() => void select(email.id)}>
      <span className="acct-bar" style={{ background: email.accountColor }} title={email.accountEmail} />
      <div className="star-col">
        <input type="checkbox" className="row-check" checked={isChecked} title="Select"
          onClick={(e) => e.stopPropagation()} onChange={(e) => toggleChecked(email.id, e.target.checked)} />
        <button className={`star ${email.keywords.$flagged ? 'on' : ''}`} title="Star"
          onClick={(e) => { e.stopPropagation(); toggleStar(email.id); }}><StarIcon weight={email.keywords.$flagged ? 'fill' : 'regular'} size={18} /></button>
        {unread && <span className="unread-dot" />}
      </div>
      <div className="rest">
        <div className="line1">
          <span className="from">{from?.name || from?.email || '(unknown)'}</span>
          <span className="meta-icons">
            {email.openCount >= 0 && (
              <span className={`open-badge ${email.openCount > 0 ? 'opened' : ''}`}
                title={email.openCount > 0 ? `Opened ${email.openCount}x, last ${email.lastOpenAt ? new Date(email.lastOpenAt).toLocaleString() : ''}` : 'Tracked - not opened yet'}>
                <EyeIcon size={18} />{email.openCount > 0 ? ` ${email.openCount}` : ''}
              </span>
            )}
            {email.hasNote && <NoteIcon size={18} weight="fill" className="note-flag" aria-label="Has a private note" />}
            {email.hasAttachment && <AttachClipIcon size={18} aria-label="Has attachment" />}
          </span>
          <span className="date">{fmtDate(email.receivedAt)}</span>
        </div>
        <div className="line2">
          <span className="subject">
            {email.subject || '(no subject)'}
            <span className="snippet">{email.preview ? ` — ${email.preview}` : ''}</span>
          </span>
        </div>
        {chips.length > 0 && (
          <div className="chips">
            {chips.map((l) => <span key={l!.id} className="chip" style={{ background: l!.color }}>{l!.name}</span>)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Gmail-style dense single-line row. */
function TableRow({ email, selected }: { email: ApiEmail; selected: boolean }) {
  const labels = useMail((s) => s.labels);
  const select = useMail((s) => s.select);
  const toggleStar = useMail((s) => s.toggleStar);
  const toggleChecked = useMail((s) => s.toggleChecked);
  const isChecked = useMail((s) => s.checked.has(email.id));
  const unread = email.keywords.$seen !== true;
  const from = email.from[0];
  const chips = email.labelIds.map((id) => labels.find((l) => l.id === id)).filter(Boolean);

  return (
    <div className={`msg-row table ${unread ? 'unread' : ''} ${selected ? 'selected' : ''} ${isChecked ? 'checked' : ''}`} style={{ height: '100%' }}
      onClick={() => void select(email.id)}>
      <span className="acct-bar" style={{ background: email.accountColor }} title={email.accountEmail} />
      <input type="checkbox" className="row-check" checked={isChecked} title="Select"
        onClick={(e) => e.stopPropagation()} onChange={(e) => toggleChecked(email.id, e.target.checked)} />
      <button className={`star ${email.keywords.$flagged ? 'on' : ''}`} title="Star"
        onClick={(e) => { e.stopPropagation(); toggleStar(email.id); }}><StarIcon weight={email.keywords.$flagged ? 'fill' : 'regular'} size={18} /></button>
      <span className="tbl-from">{from?.name || from?.email || '(unknown)'}</span>
      <span className="tbl-main">
        {chips.map((l) => <span key={l!.id} className="chip" style={{ background: l!.color }}>{l!.name}</span>)}
        <span className="tbl-subject">{email.subject || '(no subject)'}</span>
        {email.preview && <span className="tbl-snippet"> — {email.preview}</span>}
      </span>
      <span className="tbl-metas">
        {email.openCount > 0 && (
          <span className="open-badge opened" title={`Opened ${email.openCount}x`}><EyeIcon size={18} /> {email.openCount}</span>
        )}
        {email.hasNote && <NoteIcon size={18} weight="fill" className="note-flag" aria-label="Has a private note" />}
        {email.hasAttachment && <AttachClipIcon size={18} aria-label="Has attachment" />}
        <span className="tbl-date">{fmtDate(email.receivedAt)}</span>
      </span>
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
  const refreshCurrent = useMail((s) => s.refreshCurrent);
  const markRead = useMail((s) => s.markRead);
  const moveTo = useMail((s) => s.moveTo);
  const destroy = useMail((s) => s.destroy);
  const applyLabels = useMail((s) => s.applyLabels);
  const checkedCount = useMail((s) => s.checked.size);
  const setAllChecked = useMail((s) => s.setAllChecked);
  const clearChecked = useMail((s) => s.clearChecked);
  const bulkMarkRead = useMail((s) => s.bulkMarkRead);
  const bulkMove = useMail((s) => s.bulkMove);
  const bulkDestroy = useMail((s) => s.bulkDestroy);
  const bulkAddLabel = useMail((s) => s.bulkAddLabel);
  const mailboxes = useMail((s) => s.mailboxes);
  const layout = useSession((s) => s.settings.layout);
  const saveSettings = useSession((s) => s.saveSettings);
  const table = layout === 'table';

  const viewMailbox = view.kind === 'mailbox' ? mailboxes.find((m) => m.id === view.mailboxId) : undefined;
  const inBin = viewMailbox?.role === 'trash' || viewMailbox?.role === 'junk';

  const loadedCount = ids.filter(Boolean).length;
  const masterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = checkedCount > 0 && checkedCount < loadedCount;
  }, [checkedCount, loadedCount]);

  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (table ? 44 : 84),
    overscan: 12,
  });

  // re-measure when the layout mode changes
  useEffect(() => { virtualizer.measure(); }, [table, virtualizer]);

  const items = virtualizer.getVirtualItems();

  // request pages for whatever range is visible (server pages of 120)
  useEffect(() => {
    const needed = new Set<number>();
    for (const item of items) needed.add(Math.floor(item.index / PAGE));
    for (const p of needed) void loadPage(p);
  }, [items, loadPage, view]);

  // reset scroll on view change
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [view]);

  const selected = selectedId ? emails[selectedId] : null;

  // keyboard shortcuts: j/k navigate, enter open, e archive, # delete, u unread
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable], select')) return;
      const st = useMail.getState();
      const idx = st.selectedId ? st.ids.indexOf(st.selectedId) : -1;
      if (e.key === 'j' && idx < st.total - 1) { const next = st.ids[idx + 1]; if (next) void st.select(next); }
      else if (e.key === 'k' && idx > 0) { const prev = st.ids[idx - 1]; if (prev) void st.select(prev); }
      else if (e.key === 'e' && st.selectedId) st.moveTo(st.selectedId, 'u:archive');
      else if (e.key === '#' && st.selectedId) st.destroy(st.selectedId);
      else if (e.key === 'u' && st.selectedId) st.markRead(st.selectedId, false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section className={`list-pane ${table ? 'table-list' : ''}`}>
      <IconContext.Provider value={TOOLBAR_ICONS}>
      {checkedCount > 0 ? (
        <div className="list-toolbar bulk">
          <input ref={masterRef} type="checkbox" className="row-check master" title="Select all loaded"
            checked={loadedCount > 0 && checkedCount >= loadedCount}
            onChange={(e) => setAllChecked(e.target.checked)} />
          <span className="bulk-count">{checkedCount} selected</span>
          {inBin && <button className="icon-btn" title="Restore to Inbox" onClick={() => bulkMove('u:inbox')}><RestoreMailIcon /></button>}
          {!inBin && <button className="icon-btn" title="Archive" onClick={() => bulkMove('u:archive')}><ArchiveIcon /></button>}
          {!inBin && <button className="icon-btn" title="Junk" onClick={() => bulkMove('u:junk')}><JunkIcon /></button>}
          <button className="icon-btn" title="Delete" onClick={() => bulkDestroy()}><TrashIcon /></button>
          <button className="icon-btn" title="Mark read" onClick={() => bulkMarkRead(true)}><EnvelopeOpenIcon /></button>
          <button className="icon-btn" title="Mark unread" onClick={() => bulkMarkRead(false)}><EnvelopeIcon /></button>
          <LabelPicker value={[]} onChange={(ids) => ids.forEach((id) => bulkAddLabel(id))} />
          <div style={{ flex: 1 }} />
          <button className="icon-btn" title="Clear selection" onClick={() => clearChecked()}><CloseIcon /></button>
        </div>
      ) : (
        <div className="list-toolbar">
          <span className="title">{view.title}<span className="total">{total > 0 ? total.toLocaleString() : ''}</span></span>
          {selected && (
            <>
              <button className="icon-btn" title="Mark unread" onClick={() => markRead(selected.id, false)}><EnvelopeIcon /></button>
              {(selected.mailboxRole === 'trash' || selected.mailboxRole === 'junk') && (
                <button className="icon-btn" title="Restore to Inbox" onClick={() => moveTo(selected.id, 'u:inbox')}><RestoreMailIcon /></button>
              )}
              {selected.mailboxRole !== 'trash' && selected.mailboxRole !== 'junk' && (
                <button className="icon-btn" title="Archive (e)" onClick={() => moveTo(selected.id, 'u:archive')}><ArchiveIcon /></button>
              )}
              {selected.mailboxRole !== 'junk' && (
                <button className="icon-btn" title="Junk" onClick={() => moveTo(selected.id, 'u:junk')}><JunkIcon /></button>
              )}
              <button className="icon-btn" title="Delete (#)" onClick={() => destroy(selected.id)}><TrashIcon /></button>
              <LabelPicker
                value={selected.labelIds}
                onChange={(labelIds) => applyLabels(selected.id, labelIds)}
              />
            </>
          )}
          <button className="icon-btn" title={table ? 'Split view' : 'Table view'}
            onClick={() => saveSettings({ layout: table ? 'split' : 'table' })}>
            {table ? <SplitViewIcon /> : <TableViewIcon />}
          </button>
          <button className="icon-btn" title="Refresh" onClick={() => void refreshCurrent()}><RefreshIcon /></button>
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
                  ? (table ? <TableRow email={email} selected={id === selectedId} /> : <Row email={email} selected={id === selectedId} />)
                  : <div className="msg-row" style={{ height: '100%' }}><div className="rest"><div className="line1"><span className="from" style={{ color: 'var(--md-text-faint)' }}>Loading…</span></div></div></div>}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
