import { useEffect, useState } from 'react';
import type { ApiContact } from '@seamless/shared';
import { api } from '../api/client.ts';
import { toast } from '../toast.ts';

interface Lookup { contact: ApiContact | null; own: boolean }
const cache = new Map<string, Lookup>();

/** Sender name with a hover card (T8.11) and a one-click "Add to contacts" when the sender is not saved yet. */
export default function SenderContact({ name, email }: { name: string; email: string }) {
  const key = email.toLowerCase();
  const [info, setInfo] = useState<Lookup | null>(cache.get(key) ?? null);
  const [card, setCard] = useState(false);

  useEffect(() => {
    let live = true;
    if (!email) return;
    if (cache.has(key)) { setInfo(cache.get(key)!); return; }
    void api.get<Lookup>(`/api/contacts/lookup?email=${encodeURIComponent(email)}`).then((r) => { cache.set(key, r); if (live) setInfo(r); }).catch(() => {});
    return () => { live = false; };
  }, [key]);

  const add = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.post('/api/contacts/add-sender', { email, name });
      cache.delete(key);
      setInfo((await api.get<Lookup>(`/api/contacts/lookup?email=${encodeURIComponent(email)}`)));
      toast(`${name || email} added to contacts`);
    } catch { toast('Could not add to contacts', 'error'); }
  };

  const c = info?.contact ?? null;
  const saved = !!c && !c.autoCreated;
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}
      onMouseEnter={() => setCard(true)} onMouseLeave={() => setCard(false)}>
      <span className="from-name">{name || email}</span>
      {info && !info.own && !saved && (
        <button className="btn ghost" style={{ padding: '0 6px', fontSize: 11.5 }} onClick={add}
          title={c ? 'Auto-saved — keep as a contact' : 'Save this sender'}>{c ? 'Keep contact' : 'Add to contacts'}</button>
      )}
      {card && (
        <span className="sender-card" onClick={(e) => e.stopPropagation()}>
          <b>{c?.displayName || name || email}</b>
          <span>{email}</span>
          {c ? (
            <>
              {c.org && <span style={{ display: 'block' }}>{c.org}</span>}
              {c.phones.map((p) => <span key={p.value} style={{ display: 'block' }}>{p.value} ({p.label})</span>)}
              <span style={{ display: 'block', color: 'var(--md-text-faint)', marginTop: 4 }}>
                {c.autoCreated ? 'Auto-saved' : 'In your contacts'} · sent {c.sentCount} · received {c.receivedCount}
                {c.lastInteractionAt ? ` · last ${new Date(c.lastInteractionAt).toLocaleDateString()}` : ''}
              </span>
            </>
          ) : <span style={{ display: 'block', color: 'var(--md-text-faint)', marginTop: 4 }}>{info?.own ? 'This is one of your own addresses' : 'Not in your contacts'}</span>}
        </span>
      )}
    </span>
  );
}
