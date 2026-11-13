/** Settings → Disposable (T3 F-25, T10.2): aliases on your own domain that you can Stop / Start; their mail is deleted after a week unless kept. */
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

/** Stop with a toast whose Undo starts the address again. */
export async function stopWithUndo(id: number, after?: () => void): Promise<void> {
  try {
    await api.post(`/api/disposable/${id}/stop`);
    after?.();
    undoToast('Address stopped — new mail goes to the Bin for a while, then is deleted', () => { void api.post(`/api/disposable/${id}/start`).then(() => { toast('Address started'); after?.(); }, () => toast('Could not start it again', 'error')); });
  } catch (e: any) { toast(e?.message ?? 'Could not stop', 'error'); }
}

/** Keep one message (or all mail from an address) so the one-week rule leaves it alone. */
export async function keepMessage(id: number | string, after?: () => void): Promise<void> {
  try { await api.post(`/api/messages/${id.toString().replace(/^m/, '')}/keep`); toast('Kept — it will not be deleted'); after?.(); } catch (e: any) { toast(e?.message ?? 'Could not keep it', 'error'); }
}
export async function keepAllFrom(id: number, after?: () => void): Promise<void> {
  try { const r = await api.post<{ kept: number }>(`/api/disposable/${id}/keep-all`); toast(`Kept ${r.kept} message${r.kept === 1 ? '' : 's'}, and everything new from this address`); after?.(); } catch (e: any) { toast(e?.message ?? 'Could not keep', 'error'); }
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

interface Rules { stopBinDays: number; stopCap: number; expireDays: number; stoppedDeleteDays: number }

function RulesCard() {
  const [r, setR] = useState<Rules | null>(null);
  useEffect(() => { void api.get<Rules>('/api/disposable/settings').then(setR).catch(() => {}); }, []);
  const save = async (patch: Partial<Rules>) => {
    try { setR(await api.put<Rules>('/api/disposable/settings', patch)); toast('Saved'); } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
  };
  if (!r) return null;
  const num = (k: keyof Rules, min: number, max: number) => (
    <input className="text-input" type="number" min={min} max={max} style={{ width: 70 }} defaultValue={r[k]} key={`${k}${r[k]}`}
      onBlur={(e) => { const v = Number(e.target.value); if (v !== r[k]) void save({ [k]: v }); }} />
  );
  return (
    <div className="dns-panel" style={{ marginBottom: 12 }}>
      <p className="settings-desc" style={{ margin: 0 }}>
        Mail on a disposable address is deleted after {num('expireDays', 1, 90)} days unless you press <b>Keep</b>. A stopped address keeps new mail in the Bin
        for {num('stopBinDays', 1, 365)} days or {num('stopCap', 1, 10000)} mails (whichever comes first), then deletes it on arrival.
        Addresses stopped for more than {num('stoppedDeleteDays', 0, 3650)} days are removed automatically (0 = never).
      </p>
    </div>
  );
}

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
      <p className="settings-desc">Give each sign-up its own address on your domain. Mail to it is deleted after a week unless you keep it. Stop an address when you are done with it; start it again any time. If a different company starts writing to an address, you get a leak alert. Replies are always sent from your normal address.</p>
      <RulesCard />
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button className="btn primary" onClick={() => setAdding(true)}>+ New address</button>
        {sel.size > 0 && <>
          <button className="btn" onClick={() => void bulk('stop')}>Stop {sel.size}</button>
          <button className="btn ghost" onClick={() => void bulk('start')}>Start</button>
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
                <td title={a.status === 'stopped' ? `${a.stoppedStored} mail${a.stoppedStored === 1 ? '' : 's'} in the Bin since it was stopped` : undefined}>{a.status === 'stopped' ? `stopped ${when(a.stoppedAt)}` : 'active'}</td>
                <td>{a.receivedCount}</td>
                <td>{a.lastSender || '—'}</td>
                <td>{when(a.expiresAt)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn ghost" onClick={() => navigate({ page: 'mail', scope: 'unified', folder: 'inbox', q: `disposable:${a.id}` })}>Mail</button>
                  {a.status === 'active'
                    ? <button className="btn ghost danger" onClick={() => void stopWithUndo(a.id, load)}>Stop</button>
                    : <button className="btn ghost" onClick={() => void act(a.id, 'start')}>Start</button>}
                  <button className="btn ghost" title="Never delete mail from this address" disabled={a.keepAll} onClick={() => void keepAllFrom(a.id, load)}>{a.keepAll ? 'Keeping all' : 'Keep all'}</button>
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
