/** Settings → Integrations (T5 F-36): outgoing webhooks, delivery log, and the admin allow-list. */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { useSession } from '../../state/session.ts';

interface Hook { id: number; name: string; url: string; eventTypes: string[]; filterQuery: string | null; include: string; active: boolean; lastStatus: string | null }
interface Delivery { id: number; eventType: string | null; status: string; httpStatus: number | null; attempts: number; nextAttemptAt: number | null; lastError: string | null; requestBody: string | null; responseSnippet: string | null; createdAt: number }
interface Listing { items: Hook[]; eventTypes: string[]; includeLevels: string[] }

const INCLUDE_HELP: Record<string, string> = {
  metadata: 'Metadata only (sender, subject, date, labels, ids)',
  body: 'Metadata + message text and HTML',
  attachments: 'Body + attachments as 1-hour download links',
  raw: 'Everything + a 1-hour download link to the original .eml',
};

const when = (ms: number) => new Date(ms).toLocaleString('en-AU', { timeZone: 'Australia/Perth', dateStyle: 'short', timeStyle: 'medium' });

function SecretNotice({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <div className="dns-panel" role="status">
      <strong>Signing secret — shown once. Copy it now.</strong>
      <p><code>{secret}</code></p>
      <p className="dim">Each request carries <code>X-Seamless-Signature: sha256=HMAC(secret, timestamp + "." + body)</code>.</p>
      <button className="btn" onClick={() => { void navigator.clipboard?.writeText(secret).catch(() => {}); toast('Secret copied'); }}>Copy</button>{' '}
      <button className="btn ghost" onClick={onClose}>I've saved it</button>
    </div>
  );
}

function HookForm({ initial, listing, onSaved, onCancel }: { initial?: Hook; listing: Listing; onSaved: (secret?: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [types, setTypes] = useState<string[]>(initial?.eventTypes ?? ['mail.received']);
  const [filter, setFilter] = useState(initial?.filterQuery ?? '');
  const [include, setInclude] = useState(initial?.include ?? 'metadata');
  const [active, setActive] = useState(initial?.active ?? true);
  const save = async () => {
    const body = { name, url, eventTypes: types, filterQuery: filter || null, include, active };
    try {
      if (initial) { await api.put(`/api/webhooks/${initial.id}`, body); onSaved(); }
      else onSaved((await api.post<{ secret: string }>('/api/webhooks', body)).secret);
    } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
  };
  const toggle = (t: string) => setTypes((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]);
  return (
    <div className="dns-panel">
      <div className="field"><label>Name</label><input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM" /></div>
      <div className="field"><label>URL</label><input className="text-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hook" /></div>
      <div className="field"><label>Events</label>
        <div className="check-grid">
          {listing.eventTypes.map((t) => <label key={t} className="checkbox-line"><input type="checkbox" checked={types.includes(t)} onChange={() => toggle(t)} />{t}</label>)}
        </div></div>
      <div className="field"><label>Only mail matching (optional)</label>
        <input className="text-input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder='from:*@client.com.au subject:"timesheet"' />
        <span className="dim">Uses the search language. Applies to events about a message.</span></div>
      <div className="field"><label>Include</label>
        <select value={include} onChange={(e) => setInclude(e.target.value)}>{listing.includeLevels.map((l) => <option key={l} value={l}>{INCLUDE_HELP[l] ?? l}</option>)}</select></div>
      <label className="checkbox-line"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Active</label>
      <div><button className="btn primary" onClick={() => void save()}>{initial ? 'Save' : 'Create webhook'}</button>{' '}<button className="btn ghost" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

function DeliveryLog({ hookId }: { hookId: number }) {
  const [items, setItems] = useState<Delivery[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const load = useCallback(() => api.get<{ items: Delivery[] }>(`/api/webhooks/${hookId}/deliveries`).then((r) => setItems(r.items)).catch(() => setItems([])), [hookId]);
  useEffect(() => { void load(); }, [load]);
  if (!items) return <p className="dim">Loading…</p>;
  if (items.length === 0) return <p className="dim">No deliveries yet. Try “Send test event”.</p>;
  return (
    <table className="settings-table">
      <thead><tr><th>When</th><th>Event</th><th>Status</th><th>HTTP</th><th>Attempts</th><th /></tr></thead>
      <tbody>
        {items.map((d) => (
          <Fragment key={d.id}>
            <tr>
              <td>{when(d.createdAt)}</td><td>{d.eventType ?? '—'}</td>
              <td>{d.status}{d.status === 'failed' && d.nextAttemptAt ? ` — retry ${when(d.nextAttemptAt)}` : ''}</td>
              <td>{d.httpStatus ?? '—'}</td><td>{d.attempts}</td>
              <td>
                <button className="btn-link" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? 'Hide' : 'Details'}</button>{' '}
                <button className="btn-link" onClick={() => void api.post(`/api/webhook-deliveries/${d.id}/redeliver`).then(() => { toast('Redelivery queued'); setTimeout(() => void load(), 1500); }, (e) => toast(e?.message ?? 'Failed', 'error'))}>Redeliver</button>
              </td>
            </tr>
            {open === d.id && (
              <tr><td colSpan={6}>
                {d.lastError && <p className="dim">Error: {d.lastError}</p>}
                <strong>Request</strong><pre className="code-block">{d.requestBody ?? '(not sent yet)'}</pre>
                <strong>Response</strong><pre className="code-block">{d.responseSnippet || '(empty)'}</pre>
              </td></tr>
            )}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function Allowlist() {
  const [items, setItems] = useState<{ id: number; value: string }[]>([]);
  const [value, setValue] = useState('');
  const load = () => api.get<{ items: { id: number; value: string }[] }>('/api/webhook-allowlist').then((r) => setItems(r.items)).catch(() => {});
  useEffect(() => { void load(); }, []);
  const add = async () => {
    try { await api.post('/api/webhook-allowlist', { value }); setValue(''); await load(); }
    catch (e: any) { toast(e?.message ?? 'Could not add', 'error'); }
  };
  return (
    <>
      <h3>Private-network allow-list (admin)</h3>
      <p className="settings-desc">Webhooks may not call private, loopback or link-local addresses. Add the host name, IP or CIDR of an app on your own network (for example your DMS on the same server) to let webhooks reach it.</p>
      <div className="row-gap">
        <input className="text-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="127.0.0.1, dms.internal or 10.0.0.0/24" aria-label="Allow-list entry"
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
        <button className="btn" onClick={() => void add()}>Allow</button>
      </div>
      {items.length === 0 ? <p className="dim">Nothing allowed.</p> : (
        <ul className="plain-list">{items.map((i) => (
          <li key={i.id}><code>{i.value}</code>{' '}<button className="btn-link" onClick={() => void api.del(`/api/webhook-allowlist/${i.id}`).then(load)}>Remove</button></li>
        ))}</ul>
      )}
    </>
  );
}

export default function IntegrationsSettings() {
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const [listing, setListing] = useState<Listing | null>(null);
  const [editing, setEditing] = useState<Hook | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<number | null>(null);
  const load = () => api.get<Listing>('/api/webhooks').then(setListing).catch(() => {});
  useEffect(() => { void load(); }, []);

  const test = async (h: Hook) => {
    try {
      const d = await api.post<Delivery>(`/api/webhooks/${h.id}/test`);
      toast(d.status === 'ok' ? `Test delivered (HTTP ${d.httpStatus})` : `Test failed: ${d.lastError ?? d.status}`, d.status === 'ok' ? undefined : 'error');
      setLogFor(h.id); void load();
    } catch (e: any) { toast(e?.message ?? 'Test failed', 'error'); }
  };

  if (!listing) return <p className="dim">Loading…</p>;
  return (
    <>
      <h2>Integrations</h2>
      <h3>Webhooks</h3>
      <p className="settings-desc">Send an event to your own URL when something happens — new mail, a lead, a failed send. Every request is signed so you can check it came from Seamless.</p>
      {secret && <SecretNotice secret={secret} onClose={() => setSecret(null)} />}
      {listing.items.length === 0 && !editing && <p className="dim">No webhooks yet.</p>}
      {listing.items.map((h) => (
        <div key={h.id} className="dns-panel">
          <strong>{h.name}</strong> {!h.active && <span className="dim">(off)</span>} {h.lastStatus && <span className="dim">· last: {h.lastStatus}</span>}
          <div className="dim"><code>{h.url}</code></div>
          <div className="dim">{h.eventTypes.join(', ')}{h.filterQuery ? ` · only ${h.filterQuery}` : ''} · {h.include}</div>
          <div>
            <button className="btn-link" onClick={() => void test(h)}>Send test event</button>{' '}
            <button className="btn-link" onClick={() => setLogFor(logFor === h.id ? null : h.id)}>Deliveries</button>{' '}
            <button className="btn-link" onClick={() => setEditing(h)}>Edit</button>{' '}
            <button className="btn-link" onClick={() => { if (confirm('Make a new secret? The old one stops working.')) void api.post<{ secret: string }>(`/api/webhooks/${h.id}/rotate`).then((r) => setSecret(r.secret)); }}>Rotate secret</button>{' '}
            <button className="btn-link" onClick={() => { if (confirm(`Delete “${h.name}” and its delivery log?`)) void api.del(`/api/webhooks/${h.id}`).then(load); }}>Delete</button>
          </div>
          {editing && typeof editing === 'object' && editing.id === h.id && (
            <HookForm initial={h} listing={listing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
          )}
          {logFor === h.id && <DeliveryLog hookId={h.id} />}
        </div>
      ))}
      {editing === 'new'
        ? <HookForm listing={listing} onCancel={() => setEditing(null)} onSaved={(s) => { setEditing(null); if (s) setSecret(s); void load(); }} />
        : <button className="btn" onClick={() => setEditing('new')}>Add webhook</button>}
      {isAdmin && <Allowlist />}
    </>
  );
}
