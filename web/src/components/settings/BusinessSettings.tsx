/** Settings → Businesses (T4 F-30): brand, logo, signature + the identities that belong to each business. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiBusiness, ApiIdentity } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

const VARS = ['{{business.name}}', '{{business.phone}}', '{{business.website}}', '{{business.abn}}', '{{business.address}}', '{{identity.name}}', '{{identity.email}}', '{{logo}}'];
const BLANK: Partial<ApiBusiness> = { name: '', shortName: '', brandColor: '#2f7ed8', website: '', phone: '', abn: '', address: '', defaultSignatureHtml: '', disclaimerHtml: '' };

/** The preview can't resolve cid: images, so point them at the logo endpoint. */
const previewHtml = (html: string) => html.replace(/cid:logo-(\d+)/g, '/api/businesses/$1/logo');

function Editor({ initial, onDone }: { initial: Partial<ApiBusiness>; onDone: () => void }) {
  const [b, setB] = useState<Partial<ApiBusiness>>(initial);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const set = (k: keyof ApiBusiness, v: string) => setB((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!b.id) { setPreview(''); return; }
    const t = setTimeout(() => {
      api.post<{ html: string }>(`/api/businesses/${b.id}/signature-preview`, { business: { defaultSignatureHtml: b.defaultSignatureHtml, disclaimerHtml: b.disclaimerHtml } })
        .then((r) => setPreview(r.html), () => {});
    }, 300);
    return () => clearTimeout(t);
  }, [b.id, b.defaultSignatureHtml, b.disclaimerHtml]);

  const save = async () => {
    setBusy(true);
    try {
      if (b.id) await api.put(`/api/businesses/${b.id}`, b); else {
        const made = await api.post<ApiBusiness>('/api/businesses', b);
        setB(made);
      }
      toast('Saved');
      if (b.id) onDone();
    } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
    setBusy(false);
  };
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append('file', f);
    try {
      const res = await fetch(`/api/businesses/${b.id}/logo`, { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as any).error ?? 'Upload failed');
      setB((x) => ({ ...x, hasLogo: true })); toast('Logo saved');
    } catch (e: any) { toast(e?.message, 'error'); }
  };
  const text = (k: keyof ApiBusiness, label: string, ph = '') => (
    <div className="field"><label>{label}</label><input className="text-input" value={String(b[k] ?? '')} placeholder={ph} onChange={(e) => set(k, e.target.value)} /></div>
  );
  return (
    <div className="dns-panel">
      {text('name', 'Business name', 'Office Cleaners R Us')}
      {text('shortName', 'Short name', 'OCR')}
      <div className="field"><label>Brand colour</label>
        <input type="color" aria-label="Brand colour" value={b.brandColor ?? '#2f7ed8'} onChange={(e) => set('brandColor', e.target.value)} /></div>
      {text('phone', 'Phone')}{text('website', 'Website')}{text('abn', 'ABN')}
      <div className="field"><label>Address</label><textarea className="text-input" rows={2} value={b.address ?? ''} onChange={(e) => set('address', e.target.value)} /></div>
      <div className="field"><label>Logo (PNG, JPEG or SVG, up to 512 KB)</label>
        {b.id ? <>
          {b.hasLogo && <img src={`/api/businesses/${b.id}/logo?${Date.now()}`} alt="Logo" style={{ maxHeight: 60, display: 'block', marginBottom: 6 }} />}
          <input ref={file} type="file" accept="image/png,image/jpeg,image/svg+xml" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
        </> : <span className="dim">Save the business first, then upload a logo.</span>}
      </div>
      <div className="field"><label>Default signature (HTML)</label>
        <textarea className="text-input" rows={5} value={b.defaultSignatureHtml ?? ''} onChange={(e) => set('defaultSignatureHtml', e.target.value)} />
        <div className="dim">Variables: {VARS.map((v) => <code key={v} style={{ marginRight: 6 }}>{v}</code>)}</div></div>
      <div className="field"><label>Disclaimer (appended under every signature)</label>
        <textarea className="text-input" rows={2} value={b.disclaimerHtml ?? ''} onChange={(e) => set('disclaimerHtml', e.target.value)} /></div>
      {b.id && <div className="field"><label>Preview</label><div className="tpl-preview" dangerouslySetInnerHTML={{ __html: previewHtml(preview) }} /></div>}
      <button className="btn primary" disabled={busy || !b.name} onClick={() => void save()}>{b.id ? 'Save' : 'Create'}</button>{' '}
      <button className="btn ghost" onClick={onDone}>{b.id ? 'Close' : 'Cancel'}</button>
    </div>
  );
}

function IdentityTable({ businesses, identities, reload }: { businesses: ApiBusiness[]; identities: ApiIdentity[]; reload: () => void }) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Partial<ApiIdentity>>({});
  const own = identities.filter((i) => i.id !== undefined);
  const save = async (id: number) => {
    try { await api.put(`/api/identities/${id}`, draft); setEditing(null); reload(); } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
  };
  return (
    <>
      <h3>Identities</h3>
      <p className="settings-desc">One per mailbox address and alias. Give each a display name, a business, and optionally its own signature, reply-to or Bcc.</p>
      <table className="settings-table">
        <thead><tr><th>Address</th><th>Name</th><th>Business</th><th>Reply-to</th><th>Bcc me</th><th /></tr></thead>
        <tbody>
          {own.map((i) => {
            const biz = businesses.find((x) => x.id === i.businessId);
            if (editing === i.id) {
              return (
                <tr key={i.id}>
                  <td><code>{i.email}</code>{i.isDefault && ' (default)'}</td>
                  <td><input className="text-input" aria-label="Display name" value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></td>
                  <td><select aria-label="Business" value={draft.businessId ?? ''} onChange={(e) => setDraft({ ...draft, businessId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">None</option>{businesses.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
                  <td><input className="text-input" aria-label="Reply-to" value={draft.replyTo ?? ''} onChange={(e) => setDraft({ ...draft, replyTo: e.target.value })} /></td>
                  <td><input type="checkbox" aria-label="Bcc me" checked={!!draft.bccSelf} onChange={(e) => setDraft({ ...draft, bccSelf: e.target.checked })} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn primary" onClick={() => void save(i.id!)}>Save</button>
                    <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </td>
                </tr>
              );
            }
            return (
              <tr key={i.id}>
                <td><code>{i.email}</code>{i.isDefault && ' (default)'}</td>
                <td>{i.name}</td>
                <td>{biz ? <><span className="chip-dot" style={{ background: biz.brandColor, display: 'inline-block', width: 10, height: 10, borderRadius: '50%', marginRight: 6 }} />{biz.name}</> : '—'}</td>
                <td>{i.replyTo || '—'}</td>
                <td>{i.bccSelf ? 'Yes' : 'No'}</td>
                <td><button className="btn ghost" onClick={() => { setEditing(i.id!); setDraft(i); }}>Edit</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

export default function BusinessSettings() {
  const [list, setList] = useState<ApiBusiness[]>([]);
  const [identities, setIdentities] = useState<ApiIdentity[]>([]);
  const [editing, setEditing] = useState<Partial<ApiBusiness> | null>(null);
  const load = useCallback(async () => {
    try {
      setList(await api.get<ApiBusiness[]>('/api/businesses'));
      setIdentities(await api.get<ApiIdentity[]>('/api/identities'));
    } catch (e: any) { toast(e?.message ?? 'Could not load', 'error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const remove = async (b: ApiBusiness) => {
    if (!window.confirm(`Delete ${b.name}? Its identities are kept, just no longer assigned.`)) return;
    try { await api.del(`/api/businesses/${b.id}`); void load(); } catch (e: any) { toast(e?.message ?? 'Could not delete', 'error'); }
  };
  return (
    <div>
      <h2>Businesses</h2>
      <p className="settings-desc">A business groups identities and gives them a logo, colour and signature. Assign identities below.</p>
      {editing ? <Editor key={editing.id ?? 'new'} initial={editing} onDone={() => { setEditing(null); void load(); }} /> : (
        <>
          <button className="btn primary" onClick={() => setEditing({ ...BLANK })}>New business</button>
          {list.length === 0 ? <p className="dim">No businesses yet.</p> : (
            <table className="settings-table">
              <thead><tr><th /><th>Name</th><th>Phone</th><th>Website</th><th /></tr></thead>
              <tbody>{list.map((b) => (
                <tr key={b.id}>
                  <td><span style={{ background: b.brandColor, display: 'inline-block', width: 14, height: 14, borderRadius: 3 }} /></td>
                  <td>{b.name}</td><td>{b.phone || '—'}</td><td>{b.website || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn ghost" onClick={() => setEditing(b)}>Edit</button>
                    <button className="btn ghost danger" onClick={() => void remove(b)}>Delete</button>
                  </td>
                </tr>))}</tbody>
            </table>
          )}
          <IdentityTable businesses={list} identities={identities} reload={() => void load()} />
        </>
      )}
    </div>
  );
}
