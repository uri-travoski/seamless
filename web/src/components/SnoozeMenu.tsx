/** Snooze picker (T2 F-18): presets in Perth time + a custom date/time. */
import { useEffect, useRef, useState } from 'react';
import { snoozePresets, fmtSnooze, fromLocalInput, SNOOZE_TZ } from '../snoozeTimes.ts';
import { SnoozeIcon } from '../icons.tsx';
import { useUi } from '../state/ui.ts';
import { actions } from '../state/actions.ts';

/** The list itself — used inside the toolbar popover and as a submenu of the email menu. */
export function SnoozeList({ onPick }: { onPick: (at: number) => void }) {
  const [custom, setCustom] = useState(false);
  const [val, setVal] = useState('');
  const presets = snoozePresets();
  return (
    <>
      <div className="switch-head">Snooze until… <span className="dim">({SNOOZE_TZ.split('/')[1]} time)</span></div>
      {presets.map((p) => (
        <button key={p.id} className="side-item" role="menuitem" onClick={() => onPick(p.at)}>
          <span className="name">{p.label}</span><span className="dim snooze-when">{fmtSnooze(p.at)}</span>
        </button>
      ))}
      {!custom
        ? <button className="side-item" role="menuitem" onClick={() => setCustom(true)}><span className="name">Pick date and time…</span></button>
        : (
          <div className="snooze-custom">
            <input type="datetime-local" className="text-input compact" value={val} onChange={(e) => setVal(e.target.value)} aria-label="Snooze until" />
            <button className="btn primary small" disabled={!(fromLocalInput(val) > Date.now())} onClick={() => onPick(fromLocalInput(val))}>Snooze</button>
          </div>
        )}
    </>
  );
}

/** Toolbar button with a popover. */
export default function SnoozeButton({ onPick, title = 'Snooze (b)' }: { onPick: (at: number) => void; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="label-menu" ref={ref}>
      <button className={`icon-btn ${open ? 'active' : ''}`} title={title} aria-label="Snooze" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><SnoozeIcon /></button>
      {open && <div className="dropdown snooze-pop" role="menu"><SnoozeList onPick={(at) => { setOpen(false); onPick(at); }} /></div>}
    </div>
  );
}

/** Fixed-position picker opened from a row's clock icon or the `b` key (state in useUi.snoozeFor). */
export function SnoozePopup() {
  const target = useUi((s) => s.snoozeFor);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => useUi.getState().set({ snoozeFor: null });
  useEffect(() => {
    if (!target) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [target]);
  if (!target) return null;
  const left = Math.max(8, Math.min(target.x, window.innerWidth - 260));
  const top = Math.max(8, Math.min(target.y, window.innerHeight - 340));
  return (
    <div ref={ref} className="dropdown snooze-pop" role="menu" style={{ position: 'fixed', left, top, right: 'auto', width: 260 }}>
      <SnoozeList onPick={(at) => { close(); void actions.snooze(target.id, at); }} />
    </div>
  );
}
