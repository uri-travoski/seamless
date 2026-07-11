import { useEffect, useRef, useState } from 'react';
import type { ApiAddress } from '@seamless/shared';
import { api } from '../api/client.ts';
import { CloseIcon } from '../icons.tsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function AddressField({ label, value, onChange, autoFocus }: {
  label: string;
  value: ApiAddress[];
  onChange: (v: ApiAddress[]) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<ApiAddress[]>([]);
  const [hi, setHi] = useState(0);
  const debounce = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (text.trim().length < 2) { setSuggestions([]); return; }
    debounce.current = setTimeout(async () => {
      try {
        const res = await api.get<ApiAddress[]>(`/api/contacts/suggest?q=${encodeURIComponent(text.trim())}`);
        setSuggestions(res.filter((s) => !value.some((v) => v.email.toLowerCase() === s.email.toLowerCase())));
        setHi(0);
      } catch { setSuggestions([]); }
    }, 150);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [text]);

  const add = (a: ApiAddress) => {
    if (!value.some((v) => v.email.toLowerCase() === a.email.toLowerCase())) onChange([...value, a]);
    setText('');
    setSuggestions([]);
  };

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
    setSuggestions([]);
  };

  return (
    <div className="compose-row" style={{ position: 'relative' }}>
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
          if (suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
          } else if (e.key === 'Enter' && suggestions.length > 0) {
            e.preventDefault();
            add(suggestions[hi]);
          } else if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
            if (text.trim()) { e.preventDefault(); commit(); }
          } else if (e.key === 'Escape') {
            setSuggestions([]);
          } else if (e.key === 'Backspace' && !text && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => setTimeout(() => { commit(); }, 150)}
        placeholder={value.length === 0 ? 'name@example.com' : ''}
      />
      {suggestions.length > 0 && (
        <div className="addr-suggest">
          {suggestions.map((s, i) => (
            <button key={s.email} className={`addr-suggest-item ${i === hi ? 'hi' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); add(s); }}>
              <b>{s.name || s.email}</b>{s.name ? <span> &lt;{s.email}&gt;</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
