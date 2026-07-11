import { useEffect, useRef, useState } from 'react';
import { useMail } from '../state/mail.ts';
import { TagIcon, CheckIcon } from '../icons.tsx';

export default function LabelPicker({ value, onChange }: { value: number[]; onChange: (ids: number[]) => void }) {
  const labels = useMail((s) => s.labels);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="label-menu" ref={ref}>
      <button className={`icon-btn ${open ? 'active' : ''}`} title="Labels" onClick={() => setOpen(!open)}><TagIcon /></button>
      {open && (
        <div className="dropdown">
          {labels.length === 0 && <div style={{ padding: 10, fontSize: 12.5, color: 'var(--md-text-faint)' }}>No labels yet — create them in Settings.</div>}
          {labels.map((l) => {
            const on = value.includes(l.id);
            return (
              <button key={l.id} className="side-item" onClick={() => onChange(on ? value.filter((v) => v !== l.id) : [...value, l.id])}>
                <span className="label-dot" style={{ background: l.color }} />
                <span className="name">{l.name}</span>
                {on && <CheckIcon size={14} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
