/** Settings → Integrations (T5 F-36): outgoing webhooks, delivery log, and the admin allow-list. */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { useSession } from '../../state/session.ts';
import { useViews } from '../../state/views.ts';

interface Hook { id: number; name: string; url: string; eventTypes: string[]; filterQuery: string | null; include: string; active: boolean; lastStatus: string | null; connector: string | null; connectorConfig: { baseUrl: string; projectId: string; hasToken: boolean } | null }
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
  const views = useViews((v) => v.views);
  useEffect(() => { if (views.length === 0) void useViews.getState().load(); }, [views.length]);
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
        {views.length > 0 && (
          <select aria-label="Use a saved view" value="" onChange={(e) => { const v = views.find((x) => String(x.id) === e.target.value); if (v) setFilter(v.query); }}>
            <option value="">Use a saved view…</option>
            {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>)}
        <span className="dim">Uses the search language. Applies to events about a message. Pick a saved view to fire only for mail it matches.</span></div>
      <div className="field"><label>Include</label>
        <select value={include} onChange={(e) => setInclude(e.target.value)}>{listing.includeLevels.map((l) => <option key={l} value={l}>{INCLUDE_HELP[l] ?? l}</option>)}</select></div>
      <label className="checkbox-line"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Active</label>
      <div><button className="btn primary" onClick={() => void save()}>{initial ? 'Save' : 'Create webhook'}</button>{' '}<button className="btn ghost" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

const CONNECTOR_LABELS: Record<string, string> = {
  dms: 'DMS (documents)', bizbooks: 'BizBooks (bills inbox)', todoist: 'Todoist tasks', vikunja: 'Vikunja tasks', 'task-webhook': 'Generic task webhook',
};

/** Connector presets (T5.2): the app's address + token. Shown as buttons in the reading pane and as rule actions. */
function ConnectorForm({ initial, onSaved, onCancel }: { initial?: Hook; onSaved: (secret?: string) => void; onCancel: () => void }) {
  const [kind, setKind] = useState(initial?.connector ?? 'dms');
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.connectorConfig?.baseUrl ?? '');
  const [token, setToken] = useState('');
  const [projectId, setProjectId] = useState(initial?.connectorConfig?.projectId ?? '');
  const [active, setActive] = useState(initial?.active ?? true);
  const save = async () => {
    const body = { name: name || CONNECTOR_LABELS[kind], connector: kind, connectorConfig: { baseUrl, projectId, ...(token ? { token } : {}) }, active };
    try {
      if (initial) { await api.put(`/api/webhooks/${initial.id}`, body); onSaved(); }
      else { const r = await api.post<{ secret: string }>('/api/webhooks', body); onSaved(kind === 'task-webhook' ? r.secret : undefined); }   // only the generic task webhook is signed
    } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
  };
  return (
    <div className="dns-panel">
      <div className="field"><label>App</label>
        <select value={kind} disabled={!!initial} onChange={(e) => setKind(e.target.value)}>{Object.entries(CONNECTOR_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      <div className="field"><label>Name</label><input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={CONNECTOR_LABELS[kind]} /></div>
      <div className="field"><label>{kind === 'todoist' ? 'Base URL (leave empty for Todoist)' : 'Base URL'}</label>
        <input className="text-input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://dms.example.com" /></div>
      {kind !== 'task-webhook' && <div className="field"><label>API token{initial?.connectorConfig?.hasToken ? ' (leave empty to keep the saved one)' : ''}</label>
        <input className="text-input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></div>}
      {(kind === 'vikunja' || kind === 'todoist') && <div className="field"><label>Project id{kind === 'todoist' ? ' (optional)' : ''}</label>
        <input className="text-input" value={projectId} onChange={(e) => setProjectId(e.target.value)} /></div>}
      <label className="checkbox-line"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Active</label>
      <div><button className="btn primary" onClick={() => void save()}>{initial ? 'Save' : 'Add app'}</button>{' '}<button className="btn ghost" onClick={onCancel}>Cancel</button></div>
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

interface Tok { id: number; name: string; prefix: string; scopes: string[]; lastUsedAt: number | null; expiresAt: number | null; createdAt: number; revoked: boolean }

function ApiTokens() {
  const [data, setData] = useState<{ items: Tok[]; scopes: string[] } | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['mail:read']);
  const [days, setDays] = useState('90');
  const [token, setToken] = useState<string | null>(null);
  const load = useCallback(async () => { setData(await api.get('/api/api-tokens')); }, []);
  useEffect(() => { void load(); }, [load]);
  const create = async () => {
    try {
      const r = await api.post<{ token: string }>('/api/api-tokens', { name, scopes, expiresInDays: days ? Number(days) : null });
      setToken(r.token); setCreating(false); setName(''); void load();
    } catch (e: any) { toast(e?.message ?? 'Could not create the token', 'error'); }
  };
  if (!data) return null;
  return (
    <>
      <h3>API tokens</h3>
      <p className="settings-desc">Let your own scripts read mail, send, or follow events through the REST API at <code>/api/v1</code> (<a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">OpenAPI</a>). Each token has only the scopes you give it.</p>
      {token && (
        <div className="dns-panel" role="status">
          <strong>Your new token — shown once. Copy it now.</strong>
          <p><code>{token}</code></p>
          <button className="btn" onClick={() => { void navigator.clipboard?.writeText(token).catch(() => {}); toast('Token copied'); }}>Copy</button>{' '}
          <button className="btn ghost" onClick={() => setToken(null)}>I've saved it</button>
        </div>)}
      {data.items.length === 0 && !creating && <p className="dim">No API tokens yet.</p>}
      {data.items.map((t) => (
        <div key={t.id} className="dns-panel">
          <strong>{t.name}</strong> {t.revoked && <span className="dim">(revoked)</span>} <code>{t.prefix}…</code>
          <div className="dim">{t.scopes.join(', ')}</div>
          <div className="dim">Last used: {t.lastUsedAt ? when(t.lastUsedAt) : 'never'} · {t.expiresAt ? `expires ${when(t.expiresAt)}` : 'no expiry'}</div>
          {!t.revoked && <button className="btn-link" onClick={() => { if (confirm(`Revoke “${t.name}”? Anything using it stops working.`)) void api.del(`/api/api-tokens/${t.id}`).then(load); }}>Revoke</button>}
        </div>))}
      {creating ? (
        <div className="dns-panel">
          <div className="field"><label>Name</label><input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly report script" /></div>
          <div className="field"><label>Scopes</label>
            <div className="check-grid">
              {data.scopes.map((sc) => <label key={sc} className="checkbox-line"><input type="checkbox" checked={scopes.includes(sc)} onChange={() => setScopes((cur) => cur.includes(sc) ? cur.filter((x) => x !== sc) : [...cur, sc])} />{sc}</label>)}
            </div></div>
          <div className="field"><label>Expires after (days, blank = never)</label><input className="text-input" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} /></div>
          <button className="btn" onClick={() => void create()}>Create token</button>{' '}<button className="btn ghost" onClick={() => setCreating(false)}>Cancel</button>
        </div>
      ) : <button className="btn" onClick={() => setCreating(true)}>New API token</button>}
    </>
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

/** Mobile push (T9.1): the Firebase key that lets the Android app get push notifications. Admin only; the key is never shown again. */
function MobilePush() {
  const [st, setSt] = useState<{ configured: boolean; projectId: string | null; clientEmail: string | null } | null>(null);
  const [text, setText] = useState('');
  const load = () => api.get<typeof st>('/api/mobile/fcm').then(setSt).catch(() => {});
  useEffect(() => { void load(); }, []);
  const save = async () => {
    try { setSt(await api.put('/api/mobile/fcm', { serviceAccount: text })); setText(''); toast('Mobile push is on'); }
    catch (e: any) { toast(e?.message ?? 'Could not save the key', 'error'); }
  };
  const test = async () => {
    try {
      const r = await api.post<{ devices: number; sent: number }>('/api/mobile/test-push');
      toast(r.sent ? `Test push sent to ${r.sent} phone${r.sent === 1 ? '' : 's'}` : 'Google did not accept the test push — check the key and the app', r.sent ? undefined : 'error');
    } catch (e: any) { toast(e?.message ?? 'Test failed', 'error'); }
  };
  if (!st) return null;
  return (
    <>
      <h3>Mobile push (Firebase)</h3>
      <p className="settings-desc">Lets the Seamless Android app get new-mail and critical-alert notifications instantly. Without it the app checks for new mail about every 15 minutes instead.</p>
      <details>
        <summary>How to set it up</summary>
        <ol className="dim">
          <li>Go to the Firebase console (console.firebase.google.com) and create a project (Analytics is not needed).</li>
          <li>Add an Android app with package name <code>au.sam.seamless</code>, download <code>google-services.json</code> and give it to whoever builds the app.</li>
          <li>Project settings → Service accounts → <strong>Generate new private key</strong>. This downloads a <code>.json</code> file.</li>
          <li>Open that file in a text editor, copy everything and paste it below. Seamless keeps it encrypted and never shows it again.</li>
        </ol>
      </details>
      {st.configured && (
        <div className="dns-panel" role="status">
          <strong>On</strong> · project <code>{st.projectId}</code><div className="dim">{st.clientEmail}</div>
          <button className="btn" onClick={() => void test()}>Send test push to my phone</button>{' '}
          <button className="btn ghost" onClick={() => { if (confirm('Turn mobile push off? Phones fall back to checking every 15 minutes.')) void api.del('/api/mobile/fcm').then(() => load()); }}>Turn off</button>
        </div>
      )}
      <div className="field"><label>{st.configured ? 'Replace the service-account key' : 'Service-account key (JSON)'}</label>
        <textarea className="text-input" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder='{ "type": "service_account", … }' spellCheck={false} />
      </div>
      <button className="btn primary" disabled={!text.trim()} onClick={() => void save()}>Save key</button>
    </>
  );
}

export default function IntegrationsSettings() {
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const [listing, setListing] = useState<Listing | null>(null);
  const [editing, setEditing] = useState<Hook | 'new' | 'new-app' | null>(null);
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
      {listing.items.length === 0 && !editing && <p className="dim">No webhooks or connected apps yet.</p>}
      {listing.items.map((h) => (
        <div key={h.id} className="dns-panel">
          <strong>{h.name}</strong> {!h.active && <span className="dim">(off)</span>} {h.lastStatus && <span className="dim">· last: {h.lastStatus}</span>}
          <div className="dim"><code>{h.url}</code></div>
          {h.connector
            ? <div className="dim">{CONNECTOR_LABELS[h.connector] ?? h.connector} · used by the reading-pane buttons and rule actions</div>
            : <div className="dim">{h.eventTypes.join(', ')}{h.filterQuery ? ` · only ${h.filterQuery}` : ''} · {h.include}</div>}
          <div>
            <button className="btn-link" onClick={() => void test(h)}>Send test event</button>{' '}
            <button className="btn-link" onClick={() => setLogFor(logFor === h.id ? null : h.id)}>Deliveries</button>{' '}
            <button className="btn-link" onClick={() => setEditing(h)}>Edit</button>{' '}
            <button className="btn-link" onClick={() => { if (confirm('Make a new secret? The old one stops working.')) void api.post<{ secret: string }>(`/api/webhooks/${h.id}/rotate`).then((r) => setSecret(r.secret)); }}>Rotate secret</button>{' '}
            <button className="btn-link" onClick={() => { if (confirm(`Delete “${h.name}” and its delivery log?`)) void api.del(`/api/webhooks/${h.id}`).then(load); }}>Delete</button>
          </div>
          {editing && typeof editing === 'object' && editing.id === h.id && (h.connector
            ? <ConnectorForm initial={h} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
            : <HookForm initial={h} listing={listing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />)}
          {logFor === h.id && <DeliveryLog hookId={h.id} />}
        </div>
      ))}
      {editing === 'new'
        ? <HookForm listing={listing} onCancel={() => setEditing(null)} onSaved={(s) => { setEditing(null); if (s) setSecret(s); void load(); }} />
        : editing === 'new-app'
          ? <ConnectorForm onCancel={() => setEditing(null)} onSaved={(s) => { setEditing(null); if (s) setSecret(s); void load(); }} />
          : <><button className="btn" onClick={() => setEditing('new')}>Add webhook</button>{' '}<button className="btn" onClick={() => setEditing('new-app')}>Connect an app (DMS, BizBooks, tasks)</button></>}
      <ApiTokens />
      {isAdmin && <Allowlist />}
      {isAdmin && <MobilePush />}
    </>
  );
}
