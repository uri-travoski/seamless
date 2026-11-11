/**
 * Top-right scope switcher (T1 F-08): categories first (Unified, Work, Personal,
 * Disposable, custom), then every mailbox A–Z. Keyboard: g u / g w / g p / g d,
 * Ctrl/Cmd+K to open with type-to-filter, arrows + Enter. Mobile: bottom sheet.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMail, scopeToSlug, scopeName } from '../../state/mail.ts';
import { useRouter, navigate, type Route } from '../../router.ts';
import { CaretDownIcon, CategoryGlyph, SettingsIcon } from '../../icons.tsx';
import { NO_AUTOFILL } from '../../state/ui.ts';

interface Row { kind: 'category' | 'mailbox'; scope: string; name: string; sub?: string; unread: number; icon?: string; color: string }

export default function ScopeSwitcher({ dot }: { dot?: React.ReactNode }) {
  const overview = useMail((s) => s.overview);
  const scope = useMail((s) => s.scope);
  const route = useRouter((s) => s.route);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const rows = useMemo<Row[]>(() => {
    if (!overview) return [];
    const cats: Row[] = [
      { kind: 'category', scope: 'unified', name: 'Unified Mailbox', unread: overview.unifiedUnread, icon: 'unified', color: 'var(--color-accent)' },
      ...overview.categories.map((c) => ({ kind: 'category' as const, scope: `category:${c.id}`, name: `${c.name} Mailbox`, unread: c.unread, icon: c.icon, color: c.color })),
    ];
    const boxes: Row[] = [...overview.mailboxes]
      .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email))
      .map((m) => ({ kind: 'mailbox', scope: `account:${m.id}`, name: m.name || m.email, sub: m.email, unread: m.unread, color: m.color }));
    const f = filter.trim().toLowerCase();
    const all = [...cats, ...boxes];
    return f ? all.filter((r) => `${r.name} ${r.sub ?? ''}`.toLowerCase().includes(f)) : all;
  }, [overview, filter]);

  const current = useMemo(() => {
    const unread = !overview ? 0 : scope === 'unified' ? overview.unifiedUnread
      : scope.startsWith('category:') ? overview.categories.find((c) => `category:${c.id}` === scope)?.unread ?? 0
        : overview.mailboxes.find((m) => `account:${m.id}` === scope)?.unread ?? 0;
    const cat = overview?.categories.find((c) => `category:${c.id}` === scope);
    const mb = overview?.mailboxes.find((m) => `account:${m.id}` === scope);
    return { name: scopeName(scope, overview), unread, icon: scope === 'unified' ? 'unified' : cat?.icon, color: cat?.color ?? mb?.color };
  }, [overview, scope]);

  const pick = (s: string) => {
    setOpen(false);
    setFilter('');
    const slug = scopeToSlug(s, overview);
    const r: Route = route.page === 'mail'
      ? { ...route, scope: slug, ...(route.folder === 'folder' ? { folder: 'inbox', arg: undefined } : {}) }
      : { page: 'mail', scope: slug, folder: 'inbox' };
    navigate(r);
  };

  // close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => { setHi(0); }, [filter, open]);

  // global keys: g u / g w / g p / g d, Ctrl/Cmd+K
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(true); return; }
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'g') { gAt = Date.now(); return; }
      if (Date.now() - gAt > 1200) return;
      const ov = useMail.getState().overview;
      const byKey = (k: string) => ov?.categories.find((c) => c.key === k);
      const target = e.key === 'u' ? 'unified' : e.key === 'w' ? byKey('work') : e.key === 'p' ? byKey('personal') : e.key === 'd' ? byKey('disposable') : null;
      if (!target) return;
      gAt = 0;
      e.preventDefault();
      pick(typeof target === 'string' ? target : `category:${target.id}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(rows.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === 'Enter' && rows[hi]) { e.preventDefault(); pick(rows[hi].scope); }
    else if (e.key === 'Escape') setOpen(false);
  };

  const cats = rows.filter((r) => r.kind === 'category');
  const boxes = rows.filter((r) => r.kind === 'mailbox');
  const rowEl = (r: Row, i: number) => (
    <button key={r.scope} className={`switch-row ${r.scope === scope ? 'current' : ''} ${i === hi ? 'hi' : ''}`}
      onMouseEnter={() => setHi(i)} onClick={() => pick(r.scope)} role="option" aria-selected={r.scope === scope}>
      {r.kind === 'category'
        ? <span className="switch-icon" style={{ color: r.color }}><CategoryGlyph icon={r.icon ?? 'folder'} size={17} /></span>
        : <span className="acct-dot" style={{ background: r.color }} />}
      <span className="switch-text">
        <span className="switch-name">{r.name}</span>
        {r.sub && r.sub !== r.name && <span className="switch-sub">{r.sub}</span>}
      </span>
      {r.unread > 0 && <span className="switch-count">{r.unread}</span>}
    </button>
  );

  return (
    <div className="scope-switcher" ref={ref}>
      <button className="scope-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open} title="Switch mailbox (Ctrl+K)">
        {dot}
        {!current.icon && <span className="acct-dot" style={{ background: current.color }} />}
        <span className="scope-name">{current.name}</span>
        {current.unread > 0 && <span className="switch-count">{current.unread}</span>}
        <CaretDownIcon size={13} />
      </button>
      {open && (
        <>
          <div className="sheet-scrim" onClick={() => setOpen(false)} />
          <div className="dropdown switcher-pop" role="listbox" onKeyDown={onListKey}>
            <input ref={inputRef} type="search" name="seamless-mailbox-filter" role="searchbox" {...NO_AUTOFILL}
              className="text-input switch-filter" placeholder="Type to filter…" value={filter}
              onChange={(e) => setFilter(e.target.value)} aria-label="Filter mailboxes" />
            <div className="switch-scroll">
              {cats.length > 0 && <div className="switch-head">Categories</div>}
              {cats.map((r, i) => rowEl(r, i))}
              {cats.length > 0 && boxes.length > 0 && <div className="menu-sep" />}
              {boxes.length > 0 && <div className="switch-head">Mailboxes</div>}
              {boxes.map((r, i) => rowEl(r, cats.length + i))}
              {rows.length === 0 && <div className="menu-empty">Nothing matches “{filter}”</div>}
            </div>
            <button className="switch-foot" onClick={() => { setOpen(false); navigate({ page: 'settings', tab: 'mailboxes' }); }}>
              <SettingsIcon size={15} /> Manage mailboxes…
            </button>
          </div>
        </>
      )}
    </div>
  );
}
