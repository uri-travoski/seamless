/** "Own domain (Cloudflare Email Routing)" mailbox setup (T3 F-24). The secret is shown once. */
import { useEffect, useState } from 'react';
import type { ApiTransport } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

interface PushInbox { token: string; accountId: number; email: string; name: string; domains: string[]; endpoint: string; secret?: string }

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  return <button className="btn ghost" onClick={() => { void navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', 'error')); }}>{label}</button>;
}

function Block({ title, text }: { title: string; text: string }) {
  return (
    <div className="field">
      <label>{title} <Copy text={text} /></label>
      <pre className="text-input" style={{ whiteSpace: 'pre-wrap', userSelect: 'all', margin: 0 }}>{text}</pre>
    </div>
  );
}

export function PushInstructions({ inbox, secret, onRotate }: { inbox: PushInbox; secret: string | null; onRotate: () => void }) {
  const [test, setTest] = useState<string | null>(null);
  const routes = JSON.stringify(Object.fromEntries(inbox.domains.map((d) => [d, inbox.token])));
  const origin = inbox.endpoint.replace(/\/api\/ingest\/.*$/, '');
  const secrets = JSON.stringify({ [inbox.token]: secret ?? '<secret>' });
  const runTest = async () => {
    setTest('Sending…');
    try {
      const r = await api.post<{ ok: boolean; status: number }>(`/api/push-inboxes/${inbox.token}/test`, {});
      setTest(r.ok ? 'The endpoint accepted a signed test message — it is in your Inbox. To test the whole path, deploy the Worker and send a real email to one of your addresses.' : `The endpoint answered ${r.status}.`);
    } catch (e: any) { setTest(String(e?.message ?? e)); }
  };
  return (
    <div>
      {secret
        ? <p className="settings-desc"><strong>Save the secret now</strong> — it is shown only once. Lost it? Rotate it below (then update the Worker).</p>
        : <p className="settings-desc">The secret is not shown again. Rotate it if you need a new one.</p>}
      <Block title="Endpoint" text={inbox.endpoint} />
      <Block title="Token" text={inbox.token} />
      {secret && <Block title="Secret" text={secret} />}
      <h3>wrangler.toml values</h3>
      <Block title="SEAMLESS_URL" text={origin} />
      <Block title="ROUTES (variable)" text={routes} />
      {secret && <Block title="SECRETS (wrangler secret put SECRETS)" text={secrets} />}
      <h3>Deploy</h3>
      <Block title="Commands" text={'cd workers/inbound\ncp wrangler.toml.example wrangler.toml   # fill in the values above\nnpx wrangler secret put SECRETS\nnpx wrangler deploy'} />
      <ol className="settings-desc">
        <li>Cloudflare dashboard → your domain → Email → Email Routing → enable it (adds the MX and SPF records).</li>
        <li>Routes → Catch-all address → action "Send to a Worker" → <code>seamless-inbound</code> → enable.</li>
        <li>Add a verified destination address and set it as <code>FALLBACK_ADDRESS</code>, so mail is forwarded if Seamless is down.</li>
      </ol>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={() => void runTest()}>Send test</button>
        <button className="btn ghost danger" onClick={onRotate}>Rotate secret</button>
      </div>
      {test && <p className="dim">{test}</p>}
    </div>
  );
}

/** Existing push mailbox: setup details + rotate. */
export function PushPanel({ accountId, onClose }: { accountId: number; onClose: () => void }) {
  const [inbox, setInbox] = useState<PushInbox | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => { void api.get<PushInbox[]>('/api/push-inboxes').then((l) => setInbox(l.find((x) => x.accountId === accountId) ?? null)); }, [accountId]);
  if (!inbox) return <div className="dim">Loading…</div>;
  const rotate = async () => {
    if (!confirm('Rotate the secret? The deployed Worker stops working until you update it.')) return;
    const r = await api.post<{ secret: string }>(`/api/push-inboxes/${inbox.token}/rotate`, {});
    setSecret(r.secret);
  };
  return <div className="safe-panel"><PushInstructions inbox={inbox} secret={secret} onRotate={() => void rotate()} /><button className="btn ghost" onClick={onClose}>Close</button></div>;
}

export default function PushInboxSetup({ onDone }: { onDone: (saved: boolean) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [domains, setDomains] = useState('');
  const [transportId, setTransportId] = useState<number | ''>('');
  const [transports, setTransports] = useState<ApiTransport[]>([]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<PushInbox | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => { void api.get<ApiTransport[]>('/api/transports').then(setTransports).catch(() => {}); }, []);

  const create = async () => {
    setBusy(true);
    try {
      const list = domains.split(/[\s,]+/).filter(Boolean);
      const r = await api.post<PushInbox>('/api/push-inboxes', { name, email: email || undefined, domains: list, transportId: transportId === '' ? null : transportId });
      setSecret(r.secret ?? null); setCreated(r);
    } catch (e: any) { toast(String(e?.message ?? e), 'error'); }
    setBusy(false);
  };
  const rotate = async () => {
    if (!created || !confirm('Rotate the secret? The deployed Worker stops working until you update it.')) return;
    const r = await api.post<{ secret: string }>(`/api/push-inboxes/${created.token}/rotate`, {});
    setSecret(r.secret);
  };

  return (
    <div>
      <h2>Own domain (Cloudflare Email Routing)</h2>
      {!created ? (
        <>
          <p className="settings-desc">Receive mail for a domain you own: Cloudflare Email Routing hands each message to a small Worker, which pushes it to Seamless. Sending goes through one of your outbound transports.</p>
          <div className="field"><label>Mailbox name</label><input className="text-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My domain" /></div>
          <div className="field"><label>Main address (used as From)</label><input className="text-input" value={email} onChange={(e) => setEmail(e.target.value.trim())} placeholder="me@example.com" /></div>
          <div className="field"><label>Domains (comma or space separated)</label><input className="text-input" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="example.com" /></div>
          <div className="field"><label>Send through</label>
            <select className="text-input" value={transportId} onChange={(e) => setTransportId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Choose later (Settings → Sending)</option>
              {transports.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" disabled={busy || !domains.trim()} onClick={() => void create()}>{busy ? 'Creating…' : 'Create mailbox'}</button>
            <button className="btn ghost" onClick={() => onDone(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <PushInstructions inbox={created} secret={secret} onRotate={() => void rotate()} />
          <button className="btn primary" onClick={() => onDone(true)}>Done</button>
        </>
      )}
    </div>
  );
}
