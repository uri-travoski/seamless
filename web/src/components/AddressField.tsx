import { useEffect, useRef, useState } from 'react';
import type { ApiAddress, ApiContactSuggestion } from '@seamless/shared';
import { isEmail, parseAddressList } from '@seamless/shared';
import { api } from '../api/client.ts';
import { CloseIcon } from '../icons.tsx';

const initial = (s: ApiContactSuggestion) => ((s.name || s.email || '?').trim()[0] ?? '?').toUpperCase();

export default function AddressField({ label, value, onChange, autoFocus }: {
  label: string;
  value: ApiAddress[];
  onChange: (v: ApiAddress[]) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<ApiContactSuggestion[]>([]);
  const [hi, setHi] = useState(0);
  // typo guard: address -> message, for addresses never used before that look like someone known
  const [warn, setWarn] = useState<Record<string, string>>({});
  const debounce = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (text.trim().length < 2) { setSuggestions([]); return; }
    debounce.current = setTimeout(async () => {
      try {
        const res = await api.get<ApiContactSuggestion[]>(`/api/contacts/suggest?q=${encodeURIComponent(text.trim())}`);
        setSuggestions(res.filter((s) => s.type === 'group' || !value.some((v) => v.email.toLowerCase() === s.email.toLowerCase())));
        setHi(0);
      } catch { setSuggestions([]); }
    }, 150);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [text]);

  const checkTypo = (a: ApiAddress) => {
    if (!isEmail(a.email)) return;
    void api.get<{ known: boolean; warning?: { reason: string; name: string; email: string } }>(
      `/api/contacts/check?email=${encodeURIComponent(a.email)}&name=${encodeURIComponent(a.name)}`).then((r) => {
      if (!r.warning) return;
      const w = r.warning;
      setWarn((prev) => ({ ...prev, [a.email.toLowerCase()]: w.reason === 'name'
        ? `New address — you usually write to ${w.name} at ${w.email}`
        : `New address — did you mean ${w.email}?` }));
    }).catch(() => {});
  };

  const addMany = (list: ApiAddress[], current: ApiAddress[] = value) => {
    const next = [...current];
    for (const a of list) {
      if (!a.email || next.some((x) => x.email.toLowerCase() === a.email.toLowerCase())) continue;
      next.push(a);
      checkTypo(a);
    }
    onChange(next);
    setText('');
    setSuggestions([]);
  };

  const add = (s: ApiContactSuggestion) => {
    if (s.type === 'group') addMany((s.members ?? []).map((m) => ({ name: m.name, email: m.email })));
    else addMany([{ name: s.name, email: s.email }]);
  };

  // "Name <a@b>, c@d" and group names; plain words that match a group exactly expand to its members
  const commit = async (raw = text) => {
    const parts = parseAddressList(raw);
    if (parts.length === 0) return;
    const out: ApiAddress[] = [];
    for (const p of parts) {
      if (p.email) { out.push({ name: p.name, email: p.email }); continue; }
      try {
        const res = await api.get<ApiContactSuggestion[]>(`/api/contacts/suggest?q=${encodeURIComponent(p.name)}`);
        const g = res.find((s) => s.type === 'group' && s.name.toLowerCase() === p.name.toLowerCase());
        if (g) { out.push(...(g.members ?? []).map((m) => ({ name: m.name, email: m.email }))); continue; }
      } catch { /* fall through */ }
      out.push({ name: '', email: p.name });   // shows as a red chip so the typo is visible
    }
    addMany(out);
  };

  return (
    <div className="compose-row" style={{ position: 'relative' }}>
      <span className="lbl">{label}</span>
      {value.map((a, i) => {
        const w = warn[a.email.toLowerCase()];
        return (
          <span key={`${a.email}-${i}`} className={`addr-chip ${isEmail(a.email) ? (w ? 'warn' : '') : 'bad'}`} title={w ?? a.email}>
            {w && <span className="warn-mark" aria-label="Check this address">!</span>}
            {a.name || a.email}
            <button onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${a.email}`}><CloseIcon size={12} /></button>
          </span>
        );
      })}
      <input
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text');
          if (/[,;\n<]/.test(pasted)) { e.preventDefault(); void commit(pasted); }
        }}
        onKeyDown={(e) => {
          if (suggestions.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
          } else if ((e.key === 'Enter' || e.key === 'Tab') && suggestions.length > 0 && text.trim() && !text.includes('@')) {
            // typed a name, then Enter/Tab: take the highlighted contact
            e.preventDefault();
            add(suggestions[hi]);
          } else if (e.key === 'Enter' && suggestions.length > 0 && !text.includes('<')) {
            e.preventDefault();
            add(suggestions[hi]);
          } else if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === 'Tab') {
            if (text.trim()) { e.preventDefault(); void commit(); }
          } else if (e.key === 'Escape') {
            setSuggestions([]);
          } else if (e.key === 'Backspace' && !text && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => setTimeout(() => { void commit(); }, 150)}
        placeholder={value.length === 0 ? 'name@example.com' : ''}
      />
      {suggestions.length > 0 && (
        <div className="addr-suggest">
          {suggestions.map((s, i) => (
            <div key={`${s.type}-${s.email || s.name}`}>
              {s.other && (i === 0 || !suggestions[i - 1].other) && <div className="addr-suggest-head">Other contacts</div>}
              <button className={`addr-suggest-item ${i === hi ? 'hi' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); add(s); }}>
                <span className={`avatar-dot ${s.type === 'group' ? 'group' : ''}`}>{initial(s)}</span>
                <span className="text">
                  <b>{s.name || s.email}</b>
                  {s.type === 'group' ? <span> · group, {s.members?.length ?? 0} people</span>
                    : <span> {s.name ? `<${s.email}>` : ''}{s.org ? ` · ${s.org}` : ''}</span>}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
