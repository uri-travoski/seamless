import { useEffect, useRef, useState } from 'react';
import { useMail } from '../state/mail.ts';
import { TagIcon, CheckIcon } from '../icons.tsx';

/** `accountId` = the account of the message being labelled: on a mailbox shared with me only the labels shared for it apply (T8.2). */
export default function LabelPicker({ value, onChange, accountId }: { value: number[]; onChange: (ids: number[]) => void; accountId?: number }) {
  const all = useMail((s) => s.labels);
  const sharedWithMe = useMail((s) => accountId != null && !!s.overview?.shared?.some((a) => a.id === accountId));
  const labels = sharedWithMe ? all.filter((l) => l.shared && l.sharedAccountIds?.includes(accountId!)) : all.filter((l) => !l.shared);
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
          {labels.length === 0 && <div style={{ padding: 10, fontSize: 12.5, color: 'var(--md-text-faint)' }}>{sharedWithMe ? 'No shared labels for this mailbox — accept them in Settings → Labels.' : 'No labels yet — create them in Settings.'}</div>}
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
