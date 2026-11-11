/** "?" cheatsheet for the Gmail-compatible shortcuts (T1 F-16). */
import { useEffect } from 'react';
import { useSession } from '../state/session.ts';
import { CloseIcon } from '../icons.tsx';

export const SHORTCUTS: [string, string][][] = [
  [
    ['j / k', 'Next / previous message'],
    ['o or Enter', 'Open message'],
    ['u', 'Back to the list'],
    ['x', 'Select message'],
    ['/', 'Search'],
    ['c', 'Compose'],
    ['?', 'This cheatsheet'],
  ],
  [
    ['e', 'Archive'],
    ['#', 'Delete'],
    ['!', 'Report spam'],
    ['s', 'Star / unstar'],
    ['Shift+I / Shift+U', 'Mark read / unread'],
    ['l', 'Label'],
    ['v', 'Move to'],
  ],
  [
    ['r / a / f', 'Reply / reply all / forward'],
    ['g u', 'Unified mailbox'],
    ['g w / g p / g d', 'Work / Personal / Disposable'],
    ['Ctrl+K', 'Switch mailbox (type to filter)'],
  ],
];

export default function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const enabled = useSession((s) => s.settings.shortcuts);
  const save = useSession((s) => s.saveSettings);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal small shortcuts-modal" role="dialog" aria-label="Keyboard shortcuts">
        <div className="modal-title">Keyboard shortcuts<button className="icon-btn" onClick={onClose} aria-label="Close"><CloseIcon /></button></div>
        <div className="modal-body">
          <label className="checkbox-line">
            <input type="checkbox" checked={enabled} onChange={(e) => save({ shortcuts: e.target.checked })} />
            Keyboard shortcuts on
          </label>
          <div className="shortcut-grid">
            {SHORTCUTS.map((col, i) => (
              <dl key={i}>
                {col.map(([k, d]) => (
                  <div key={k} className="shortcut-row"><dt>{k.split(' / ').map((p, j) => <span key={j}>{j > 0 && ' / '}<kbd>{p}</kbd></span>)}</dt><dd>{d}</dd></div>
                ))}
              </dl>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
