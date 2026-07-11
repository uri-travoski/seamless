import { useState } from 'react';
import type { ApiAddress } from '@seamless/shared';
import { CloseIcon } from '../icons.tsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function AddressField({ label, value, onChange, autoFocus }: {
  label: string;
  value: ApiAddress[];
  onChange: (v: ApiAddress[]) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');

  const commit = () => {
    const parts = text.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) {
      const m = p.match(/^(.*)<([^>]+)>$/);
      const email = (m ? m[2] : p).trim();
      const name = (m ? m[1] : '').trim().replace(/^"|"$/g, '');
      if (!next.some((a) => a.email.toLowerCase() === email.toLowerCase())) next.push({ name, email });
    }
    onChange(next);
    setText('');
  };

  return (
    <div className="compose-row">
      <span className="lbl">{label}</span>
      {value.map((a, i) => (
        <span key={`${a.email}-${i}`} className={`addr-chip ${EMAIL_RE.test(a.email) ? '' : 'bad'}`} title={a.email}>
          {a.name || a.email}
          <button onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${a.email}`}><CloseIcon size={12} /></button>
        </span>
      ))}
      <input
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
            if (text.trim()) { e.preventDefault(); commit(); }
          } else if (e.key === 'Backspace' && !text && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={value.length === 0 ? 'name@example.com' : ''}
      />
    </div>
  );
}
