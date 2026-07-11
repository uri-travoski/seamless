import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

interface Contact {
  id: number; displayName: string; org: string; notes: string; emails: string[];
  sentCount: number; receivedCount: number; lastInteractionAt: string | null;
  autoCreated: boolean; hidden: boolean;
}

export default function ContactsSettings() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<Contact | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async () => setContacts(await api.get<Contact[]>('/api/contacts?hidden=1'));
  useEffect(() => { void refresh(); }, []);

  const save = async () => {
    if (!editing) return;
    await api.put(`/api/contacts/${editing.id}`, editing);
    setEditing(null);
    await refresh();
  };

  const remove = async (c: Contact) => {
    if (!window.confirm(`Delete ${c.displayName || c.emails[0]}?`)) return;
    await api.del(`/api/contacts/${c.id}`);
    await refresh();
  };

  const importVcf = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/contacts/import', { method: 'POST', body: fd, credentials: 'same-origin' });
    if (res.ok) { toast(`Imported ${(await res.json()).created} contacts`); await refresh(); }
    else toast('Import failed', 'error');
  };

  const term = filter.toLowerCase();
  const shown = contacts.filter((c) =>
    !term || c.displayName.toLowerCase().includes(term) || c.emails.some((e) => e.includes(term)));

  return (
    <div>
      <h2>Contacts</h2>
      <p className="settings-desc">
        Built automatically from who you write to and reply to — never from unsolicited mail. Phones sync this
        addressbook over CardDAV (Settings → Devices). Hidden contacts stay out of autocomplete and CardDAV.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <input className="text-input" style={{ width: 240 }} placeholder="Search contacts…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn ghost" onClick={async () => { await api.post('/api/contacts/harvest'); await refresh(); toast('Addressbook refreshed'); }}>Rebuild from mail</button>
        <span style={{ flex: 1 }} />
        <a className="btn ghost" href="/api/contacts/export.vcf" style={{ textDecoration: 'none' }}>Export .vcf</a>
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>Import .vcf</button>
        <input ref={fileRef} type="file" accept=".vcf,text/vcard" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importVcf(f); e.target.value = ''; }} />
      </div>

      <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid var(--md-border)', borderRadius: 8 }}>
        {shown.map((c) => (
          <div key={c.id} className="cond-row" style={{ margin: 0, padding: '5px 10px', borderBottom: '1px solid var(--md-border)', opacity: c.hidden ? 0.5 : 1 }}>
            <span style={{ width: 180, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.displayName || '—'}</span>
            <span style={{ flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.emails.join(', ')}</span>
            <span style={{ width: 110, fontSize: 11.5, color: 'var(--md-text-faint)', textAlign: 'right' }}
              title={`sent ${c.sentCount} / received ${c.receivedCount}`}>
              {c.sentCount + c.receivedCount}× {c.hidden ? '· hidden' : ''}
            </span>
            <button className="btn ghost" onClick={() => setEditing(c)}>Edit</button>
            <button className="btn ghost danger" onClick={() => void remove(c)}>Delete</button>
          </div>
        ))}
        {shown.length === 0 && <p style={{ color: 'var(--md-text-faint)', padding: 12, margin: 0 }}>No contacts yet — send some mail, or Rebuild from mail.</p>}
      </div>

      {editing && (
        <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 14, marginTop: 14 }}>
          <div className="field-row">
            <div className="field"><label>Name</label>
              <input className="text-input" value={editing.displayName} onChange={(e) => setEditing({ ...editing, displayName: e.target.value })} /></div>
            <div className="field"><label>Organisation</label>
              <input className="text-input" value={editing.org} onChange={(e) => setEditing({ ...editing, org: e.target.value })} /></div>
          </div>
          <div className="field"><label>Notes</label>
            <input className="text-input" value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></div>
          <label className="checkbox-line">
            <input type="checkbox" checked={editing.hidden} onChange={(e) => setEditing({ ...editing, hidden: e.target.checked })} />
            Hidden (kept, but out of autocomplete and CardDAV)
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn primary" onClick={() => void save()}>Save contact</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
