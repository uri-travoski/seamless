/** Settings → Disposable (T3 F-25): aliases on your own domain that you can pause, dispose or let expire. */
import { useCallback, useEffect, useState } from 'react';
import type { ApiDisposable } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { toast, undoToast } from '../../toast.ts';
import { navigate } from '../../router.ts';
import CatchAllPanel from './CatchAllPanel.tsx';

interface Domain { accountId: number; domain: string }
interface Listing { addresses: ApiDisposable[]; domains: Domain[] }

export async function createDisposableAddress(o: { domain: string; generator?: string; prefix?: string; label?: string; purpose?: string; expiresInDays?: number | null }): Promise<ApiDisposable> {
  return api.post<ApiDisposable>('/api/disposable', o);
}

/** Dispose with a toast that undoes it (works for 30 days from the table too). */
export async function disposeWithUndo(id: number, after?: () => void): Promise<void> {
  try {
    await api.post(`/api/disposable/${id}/dispose`);
    after?.();
    undoToast('Address disposed — new mail to it is dropped', () => { void api.post(`/api/disposable/${id}/undispose`).then(() => { toast('Address restored'); after?.(); }, () => toast('Could not restore', 'error')); });
  } catch (e: any) { toast(e?.message ?? 'Could not dispose', 'error'); }
}

export function NewAddressForm({ domains, onCreated, onCancel }: { domains: Domain[]; onCreated: (d: ApiDisposable) => void; onCancel?: () => void }) {
  const [domain, setDomain] = useState(domains[0]?.domain ?? '');
  const [generator, setGenerator] = useState('random');
  const [prefix, setPrefix] = useState('');
  const [label, setLabel] = useState('');
  const [purpose, setPurpose] = useState('');
  const [expires, setExpires] = useState('0');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const d = await createDisposableAddress({ domain, generator, prefix, label, purpose, expiresInDays: Number(expires) || null });
      void navigator.clipboard?.writeText(d.address).catch(() => {});
      toast(`Created ${d.address} (copied)`);
      onCreated(d);
    } catch (e: any) { toast(e?.message ?? 'Could not create', 'error'); }
    setBusy(false);
  };
  if (domains.length === 0) return <p className="settings-desc">Add a catch-all domain (below) or a mailbox with “Own domain (Cloudflare Email Routing)” first — disposable addresses live on those domains.</p>;
  return (
    <div className="dns-panel">
      <div className="field"><label>Domain</label>
        <select value={domain} onChange={(e) => setDomain(e.target.value)}>{domains.map((d) => <option key={d.domain}>{d.domain}</option>)}</select></div>
      <div className="field"><label>Style</label>
        <select value={generator} onChange={(e) => setGenerator(e.target.value)}>
          <option value="random">Random (k7f2q9)</option><option value="words">Two words (quiet.river)</option><option value="prefix">My prefix (bunnings.x7)</option>
        </select></div>
      {generator === 'prefix' && <div className="field"><label>Prefix</label><input className="text-input" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="bunnings" /></div>}
      <div className="field"><label>Label</label><input className="text-input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Bunnings newsletter" /></div>
      <div className="field"><label>Purpose (optional)</label><input className="text-input" value={purpose} onChange={(e) => setPurpose(e.target.value)} /></div>
      <div className="field"><label>Expires</label>
        <select value={expires} onChange={(e) => setExpires(e.target.value)}>
          <option value="1">In 1 day</option><option value="7">In 7 days</option><option value="30">In 30 days</option><option value="0">Never</option>
        </select></div>
      <button className="btn primary" disabled={busy} onClick={() => void go()}>Create address</button>{' '}
      {onCancel && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
    </div>
  );
}

const when = (t: number | null) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export default function DisposableSettings() {
  const [data, setData] = useState<Listing | null>(null);
  const [adding, setAdding] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const load = useCallback(async () => { try { setData(await api.get<Listing>('/api/disposable')); } catch { /* offline */ } }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (id: number, action: string) => {
    try { await api.post(`/api/disposable/${id}/${action}`); await load(); } catch (e: any) { toast(e?.message ?? 'Failed', 'error'); }
  };
  const bulk = async (action: string) => {
    const r = await api.post<{ updated: number }>('/api/disposable/bulk', { ids: [...sel], action });
    toast(`${r.updated} address${r.updated === 1 ? '' : 'es'} updated`); setSel(new Set()); await load();
  };
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div>
      <h2>Disposable addresses</h2>
      <p className="settings-desc">Give each sign-up its own address on your domain. Pause it to hold mail quietly, dispose it to stop it for good (you can undo for 30 days). If a different company starts writing to an address, you get a leak alert.</p>
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button className="btn primary" onClick={() => setAdding(true)}>+ New address</button>
        {sel.size > 0 && <>
          <button className="btn" onClick={() => void bulk('dispose')}>Dispose {sel.size}</button>
          <button className="btn ghost" onClick={() => void bulk('pause')}>Pause</button>
          <button className="btn ghost" onClick={() => void bulk('resume')}>Resume</button>
        </>}
      </div>
      {adding && data && <NewAddressForm domains={data.domains} onCancel={() => setAdding(false)} onCreated={() => { setAdding(false); void load(); }} />}
      {data && data.addresses.length === 0 && !adding && <p className="dim">No disposable addresses yet.</p>}
      {data && data.addresses.length > 0 && (
        <table className="settings-table">
          <thead><tr><th /><th>Address</th><th>Label</th><th>Status</th><th>Received</th><th>Last sender</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {data.addresses.map((a) => (
              <tr key={a.id}>
                <td><input type="checkbox" checked={sel.has(a.id)} onChange={() => toggle(a.id)} aria-label={`Select ${a.address}`} /></td>
                <td><code>{a.address}</code></td>
                <td>{a.label || '—'}{a.leakDomains.length > 0 && <span title={`Also written to by ${a.leakDomains.join(', ')}`}> ⚠ leaked?</span>}</td>
                <td>{a.status}</td>
                <td title={`${a.droppedCount} dropped`}>{a.receivedCount}</td>
                <td>{a.lastSender || '—'}</td>
                <td>{a.status === 'disposed' ? `disposed ${when(a.disposedAt)}` : when(a.expiresAt)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn ghost" onClick={() => navigate({ page: 'mail', scope: 'unified', folder: 'inbox', q: `disposable:${a.id}` })}>Mail</button>
                  {a.status === 'active' && <button className="btn ghost" onClick={() => void act(a.id, 'pause')}>Pause</button>}
                  {a.status === 'paused' && <button className="btn ghost" onClick={() => void act(a.id, 'resume')}>Resume</button>}
                  {a.status !== 'disposed' && <button className="btn ghost danger" onClick={() => void disposeWithUndo(a.id, load)}>Dispose</button>}
                  {a.canUndo && <button className="btn ghost" onClick={() => void act(a.id, 'undispose')}>Undo</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CatchAllPanel onCreated={() => void load()} />
    </div>
  );
}
