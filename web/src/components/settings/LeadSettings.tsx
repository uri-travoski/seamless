/** Settings → Leads (T5.4 F-38): lead sources (a search query + a business) with "Test against recent mail". */
import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

interface Source { id: number; businessId: number | null; name: string; query: string; enabled: boolean }
interface Biz { id: number; name: string }
interface Fields { name: string | null; email: string | null; phone: string | null; suburb: string | null; service: string | null; message: string | null }
interface Match { id: string; subject: string; from: string; date: string; fields: Fields }

function SourceForm({ initial, biz, onSaved, onCancel }: { initial?: Source; biz: Biz[]; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [query, setQuery] = useState(initial?.query ?? '');
  const [businessId, setBusinessId] = useState<string>(initial?.businessId ? String(initial.businessId) : '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [result, setResult] = useState<{ matches: Match[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const body = () => ({ name, query, businessId: businessId ? Number(businessId) : null, enabled });
  const save = async () => {
    try {
      if (initial) await api.put(`/api/lead-sources/${initial.id}`, body()); else await api.post('/api/lead-sources', body());
      onSaved();
    } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
  };
  const test = async () => {
    setBusy(true);
    try { setResult(await api.post('/api/lead-sources/test', { query })); } catch (e: any) { toast(e?.message ?? 'Could not run that search', 'error'); }
    setBusy(false);
  };
  return (
    <div className="dns-panel">
      <div className="field"><label>Name</label><input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Office Cleaners website" /></div>
      <div className="field"><label>Which mail is a lead? (search)</label>
        <input className="text-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={'from:wordpress@officecleaners.com.au subject:"New quote request"'} />
        <p className="dim">Uses the same search as the search box: <code>from:</code>, <code>to:</code>, <code>subject:</code>, words…</p></div>
      <div className="field"><label>Business</label>
        <select className="text-input" value={businessId} onChange={(e) => setBusinessId(e.target.value)}><option value="">None</option>{biz.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
      <label className="checkbox-line"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Enabled</label>
      <div>
        <button className="btn primary" onClick={() => void save()}>{initial ? 'Save' : 'Add source'}</button>{' '}
        <button className="btn" disabled={!query.trim() || busy} onClick={() => void test()}>Test against recent mail</button>{' '}
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
      {result && (
        <div>
          <p>{result.total === 0 ? 'No mail matches this search.' : `${result.total} message${result.total === 1 ? '' : 's'} match${result.total === 1 ? 'es' : ''}${result.total > result.matches.length ? ` (showing the latest ${result.matches.length})` : ''}. This is what would be extracted:`}</p>
          {result.matches.length > 0 && (
            <table className="tbl">
              <thead><tr><th>Email</th><th>Name</th><th>Contact</th><th>Suburb</th><th>Service</th></tr></thead>
              <tbody>
                {result.matches.map((m) => (
                  <tr key={m.id}>
                    <td title={m.from}>{m.subject || '(no subject)'}</td>
                    <td>{m.fields.name ?? '—'}</td>
                    <td>{m.fields.email ?? '—'}<br />{m.fields.phone ?? ''}</td>
                    <td>{m.fields.suburb ?? '—'}</td><td>{m.fields.service ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export default function LeadSettings() {
  const [items, setItems] = useState<Source[] | null>(null);
  const [biz, setBiz] = useState<Biz[]>([]);
  const [editing, setEditing] = useState<Source | 'new' | null>(null);
  const load = () => api.get<{ items: Source[] }>('/api/lead-sources').then((r) => setItems(r.items), () => setItems([]));
  useEffect(() => { void load(); api.get<Biz[]>('/api/businesses').then(setBiz, () => {}); }, []);
  const bizName = (id: number | null) => biz.find((b) => b.id === id)?.name ?? '—';
  return (
    <>
      <h2>Leads</h2>
      <p className="settings-desc">Web-form notification emails (WordPress, Contact Form 7, Gravity Forms, Elementor, WPForms, Wix, Squarespace, Google Ads and Facebook lead forms) become leads. Each source is a search that picks out one website’s form emails.</p>
      {editing ? (
        <SourceForm initial={editing === 'new' ? undefined : editing} biz={biz} onSaved={() => { setEditing(null); void load(); }} onCancel={() => setEditing(null)} />
      ) : <p><button className="btn primary" onClick={() => setEditing('new')}>Add lead source</button></p>}
      {items && items.length === 0 && !editing && <p className="dim">No lead sources yet.</p>}
      {items && items.length > 0 && (
        <table className="settings-table">
          <thead><tr><th>Name</th><th>Search</th><th>Business</th><th>On</th><th /></tr></thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td><td><code>{s.query}</code></td><td>{bizName(s.businessId)}</td><td>{s.enabled ? 'Yes' : 'No'}</td>
                <td>
                  <button className="btn-link" onClick={() => setEditing(s)}>Edit</button>{' '}
                  <button className="btn-link" onClick={() => { if (confirm(`Delete “${s.name}”? Leads already captured are kept.`)) void api.del(`/api/lead-sources/${s.id}`).then(load); }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
