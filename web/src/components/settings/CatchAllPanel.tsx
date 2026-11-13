/** Settings → Disposable: where disposable mail arrives (domains, unknown-address policy), catch-all mailboxes (IMAP / POP3), unknown addresses (T10.1). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

type Policy = 'quarantine' | 'deliver' | 'drop';
interface Domain { domain: string; token: string; via: 'catchall' | 'cloudflare'; policy: Policy; rejectStopped?: boolean }
interface Mailbox {
  accountId: number; email: string; kind: 'imap' | 'pop3'; after: 'move' | 'delete' | 'leave'; cleanDays: number;
  domains: { domain: string; policy: Policy }[]; state: string; lastSyncAt: number | null; lastError: string; failures: number;
}
interface Unknown { id: number; address: string; domain: string; status: 'quarantine' | 'blocked'; receivedCount: number; droppedCount: number; held: number; lastFrom: string; lastSubject: string; lastAt: number }
interface Data { mailboxes: Mailbox[]; domains: Domain[]; unknown: Unknown[]; candidates: { accountId: number; email: string; kind: 'imap' | 'pop3' }[] }

const POLICY_TEXT: Record<Policy, string> = {
  quarantine: 'Keep out of sight for a week (you decide)',
  deliver: 'Deliver to the Inbox',
  drop: 'Drop it',
};
const when = (t: number | null) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

const PROVIDERS: { id: string; name: string; steps: string[] }[] = [
  { id: 'mxroute', name: 'MXroute', steps: ['In DirectAdmin add your domain, then Email Accounts → Default Address (catch-all) → “Forward to” a mailbox such as <code>catchall@yourdomain</code>.', 'Point the domain’s MX records at the MXroute server shown in the welcome mail.', 'Use IMAP on that server (or POP3) with the mailbox login.'] },
  { id: 'migadu', name: 'Migadu', steps: ['Add the domain, create a mailbox (for example <code>catchall</code>).', 'Domain → Aliases/Catch-all: tick “Catch-all” and choose that mailbox.', 'IMAP is <code>imap.migadu.com</code>, port 993.'] },
  { id: 'fastmail', name: 'Fastmail', steps: ['Settings → Domains: add the domain and use Fastmail DNS or copy its MX records.', 'Add an alias <code>*@yourdomain</code> that delivers to one mailbox.', 'Create an app password and use IMAP <code>imap.fastmail.com</code>, port 993.'] },
  { id: 'cpanel', name: 'cPanel / DirectAdmin', steps: ['Email → Default Address (cPanel) or Email Accounts → Catch-all (DirectAdmin).', 'Send unrouted mail to one mailbox (not “:fail:” and not “/dev/null”).', 'Use that mailbox with IMAP, or POP3 if IMAP is not offered.'] },
  { id: 'other', name: 'Other provider', steps: ['Make the provider deliver every address of the domain to one mailbox (a “catch-all” or “wildcard alias”).', 'Use a mailbox that has nothing else in it: Seamless takes over reading it.', 'IMAP is best (new mail arrives at once); POP3 is checked every 2 minutes.'] },
];

function Health({ m }: { m: Mailbox }) {
  const ok = m.state === 'ok';
  return (
    <span className={ok ? 'dim' : 'danger'} role="status">
      {ok ? `Syncing — last check ${when(m.lastSyncAt)}` : m.state === 'error' ? `Not syncing: ${m.lastError || 'connection failed'}` : m.state === 'connecting' ? 'Connecting…' : 'Stopped'}
    </span>
  );
}

function Setup({ data, onDone, onCancel }: { data: Data; onDone: () => void; onCancel: () => void }) {
  const [provider, setProvider] = useState(PROVIDERS[0].id);
  const choices = [...data.mailboxes.map((m) => ({ accountId: m.accountId, email: m.email, kind: m.kind })), ...data.candidates];
  const [accountId, setAccountId] = useState<number>(choices[0]?.accountId ?? 0);
  const [domain, setDomain] = useState('');
  const [after, setAfter] = useState<'move' | 'delete' | 'leave'>('move');
  const [busy, setBusy] = useState(false);
  const chosen = choices.find((c) => c.accountId === accountId);
  const steps = PROVIDERS.find((p) => p.id === provider)!.steps;
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/api/catchall', { accountId, domains: [domain.trim().toLowerCase()], after: chosen?.kind === 'pop3' && after === 'move' ? 'leave' : after });
      toast('Catch-all domain added'); onDone();
    } catch (e: any) { toast(e?.message ?? 'Could not add the domain', 'error'); }
    setBusy(false);
  };
  return (
    <div className="dns-panel">
      <h3>Add a catch-all domain</h3>
      <div className="field"><label>1 · Provider</label>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>{PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <ol className="settings-desc">{steps.map((s, i) => <li key={i} dangerouslySetInnerHTML={{ __html: s }} />)}</ol>
      </div>
      <div className="field"><label>2 · The catch-all mailbox</label>
        {choices.length === 0
          ? <p className="settings-desc">Add the catch-all mailbox first in Settings → Mailboxes (IMAP or POP3), then come back here.</p>
          : <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>{choices.map((c) => <option key={c.accountId} value={c.accountId}>{c.email} ({c.kind.toUpperCase()})</option>)}</select>}
        <p className="settings-desc">Seamless reads this mailbox and routes each message; it is not shown in your mailbox list. Use one that holds nothing else.</p>
      </div>
      <div className="field"><label>3 · Domain</label><input className="text-input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="burn.example.com" /></div>
      <div className="field"><label>4 · After a message is saved in Seamless</label>
        <select value={after} onChange={(e) => setAfter(e.target.value as any)}>
          {chosen?.kind !== 'pop3' && <option value="move">Move it to “Seamless processed” (cleaned after 14 days)</option>}
          <option value="leave">Leave it on the provider</option>
          <option value="delete">Delete it from the provider</option>
        </select></div>
      <button className="btn primary" disabled={busy || !chosen || !domain.trim()} onClick={() => void save()}>Add domain</button>{' '}
      <button className="btn ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function MailboxCard({ m, onChange }: { m: Mailbox; onChange: () => void }) {
  const [probe, setProbe] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);
  const put = async (body: object) => { try { await api.put(`/api/catchall/${m.accountId}`, body); onChange(); } catch (e: any) { toast(e?.message ?? 'Failed', 'error'); } };
  const check = async () => {
    try {
      const r = await api.post<{ ok: boolean; routed: number; error: string | null }>(`/api/catchall/${m.accountId}/check`);
      toast(r.ok ? `Checked: ${r.routed} message${r.routed === 1 ? '' : 's'} routed` : `Could not connect: ${r.error}`, r.ok ? 'info' : 'error'); onChange();
    } catch (e: any) { toast(e?.message ?? 'Failed', 'error'); }
  };
  const test = async () => {
    setProbe('Sending a test mail to a random address on the domain…');
    try {
      const r = await api.post<{ token: string; address: string }>(`/api/catchall/${m.accountId}/test-mail`, { domain: m.domains[0]?.domain });
      let tries = 0;
      timer.current = window.setInterval(async () => {
        tries++;
        await api.post(`/api/catchall/${m.accountId}/check`).catch(() => {});
        const s = await api.get<{ state: string }>(`/api/catchall/test/${r.token}`).catch(() => ({ state: 'waiting' }));
        if (s.state === 'routed') { window.clearInterval(timer.current!); setProbe(`Works: mail to ${r.address} reached Seamless and was routed.`); }
        else if (tries >= 12) { window.clearInterval(timer.current!); setProbe(`Nothing arrived at ${r.address} yet. Check the provider’s catch-all setting and the domain’s MX records, then try again.`); }
      }, 5000);
    } catch (e: any) { setProbe(e?.message ?? 'Could not send the test mail'); }
  };
  const remove = async () => {
    if (!window.confirm('Stop using this mailbox as a catch-all? Your disposable addresses and their mail stay.')) return;
    await api.del(`/api/catchall/${m.accountId}`).catch((e: any) => toast(e?.message ?? 'Failed', 'error')); onChange();
  };
  return (
    <div className="dns-panel">
      <p><strong>{m.email}</strong> <span className="dim">({m.kind.toUpperCase()}) · {m.domains.map((d) => d.domain).join(', ') || 'no domains'}</span></p>
      <p><Health m={m} /></p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label>After saving: <select value={m.after} onChange={(e) => void put({ after: e.target.value })}>
          {m.kind === 'imap' && <option value="move">move to “Seamless processed”</option>}
          <option value="leave">leave on the provider</option>
          <option value="delete">delete from the provider</option>
        </select></label>
        {m.kind === 'imap' && m.after === 'move' && <label>clean after <input className="text-input" style={{ width: 60 }} type="number" min={1} max={365} defaultValue={m.cleanDays} onBlur={(e) => void put({ cleanDays: Number(e.target.value) })} /> days</label>}
        <button className="btn" onClick={() => void check()}>Check now</button>
        <button className="btn" onClick={() => void test()}>Send a test mail</button>
        <button className="btn ghost danger" onClick={() => void remove()}>Remove</button>
      </div>
      {probe && <p className="settings-desc" role="status">{probe}</p>}
    </div>
  );
}

export default function CatchAllPanel({ onCreated }: { onCreated?: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => { try { setData(await api.get<Data>('/api/catchall')); } catch { /* offline */ } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!data) return null;
  const setPolicy = async (d: Domain, policy: Policy) => {
    try { await api.put(`/api/push-inboxes/${d.token}`, { domainPolicies: { [d.domain]: policy } }); await load(); } catch (e: any) { toast(e?.message ?? 'Failed', 'error'); }
  };
  const unknownAct = async (u: Unknown, act: 'create' | 'block' | 'remove') => {
    try {
      if (act === 'create') { const r = await api.post<{ address: string; delivered: number }>(`/api/catchall/unknown/${u.id}/create`, {}); toast(`Created ${r.address}; ${r.delivered} held message${r.delivered === 1 ? '' : 's'} delivered`); onCreated?.(); }
      else if (act === 'block') { await api.post(`/api/catchall/unknown/${u.id}/block`); toast('Blocked: mail to it is dropped'); }
      else await api.del(`/api/catchall/unknown/${u.id}`);
      await load();
    } catch (e: any) { toast(e?.message ?? 'Failed', 'error'); }
  };
  return (
    <div>
      <h3>Where disposable mail arrives</h3>
      {data.domains.length === 0
        ? <p className="dim">No domain yet. Add a catch-all domain below, or an “Own domain (Cloudflare Email Routing)” mailbox in Settings → Mailboxes.</p>
        : (
          <table className="settings-table">
            <thead><tr><th>Domain</th><th>Delivered by</th><th>Mail to an address you have not created</th><th>Stopped addresses</th></tr></thead>
            <tbody>{data.domains.map((d) => (
              <tr key={d.domain}><td><code>{d.domain}</code></td><td>{d.via === 'catchall' ? 'Catch-all mailbox' : 'Cloudflare route'}</td>
                <td><select aria-label={`Unknown address policy for ${d.domain}`} value={d.policy} onChange={(e) => void setPolicy(d, e.target.value as Policy)}>
                  {(Object.keys(POLICY_TEXT) as Policy[]).map((p) => <option key={p} value={p}>{POLICY_TEXT[p]}</option>)}</select></td>
                <td>{d.via === 'cloudflare'
                  ? <label title="The Cloudflare Worker refuses mail to a stopped address at SMTP time, so nothing is stored"><input type="checkbox" checked={!!d.rejectStopped} onChange={(e) => void api.put(`/api/push-inboxes/${d.token}`, { rejectStopped: e.target.checked }).then(load, () => toast('Failed', 'error'))} /> Reject at the door</label>
                  : <span className="dim">Bin, then deleted</span>}</td></tr>
            ))}</tbody>
          </table>
        )}
      {data.mailboxes.map((m) => <MailboxCard key={m.accountId} m={m} onChange={() => void load()} />)}
      {adding
        ? <Setup data={data} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); void load(); onCreated?.(); }} />
        : <p><button className="btn" onClick={() => setAdding(true)}>+ Add a catch-all domain</button></p>}
      {data.unknown.length > 0 && (
        <>
          <h3>Unknown addresses</h3>
          <p className="settings-desc">Mail to these addresses is held for a week. Create the address to deliver what was held, or block it to drop everything sent to it.</p>
          <table className="settings-table">
            <thead><tr><th>Address</th><th>Last mail</th><th>Mail</th><th /></tr></thead>
            <tbody>{data.unknown.map((u) => (
              <tr key={u.id}>
                <td><code>{u.address}</code>{u.status === 'blocked' && <span className="dim"> · blocked</span>}</td>
                <td title={u.lastSubject}>{u.lastFrom || '—'} · {when(u.lastAt)}</td>
                <td>{u.status === 'blocked' ? `${u.droppedCount} dropped` : `${u.held} held`}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {u.status === 'quarantine' && <><button className="btn ghost" onClick={() => void unknownAct(u, 'create')}>Create this address</button><button className="btn ghost danger" onClick={() => void unknownAct(u, 'block')}>Block</button></>}
                  <button className="btn ghost" onClick={() => void unknownAct(u, 'remove')}>{u.status === 'blocked' ? 'Unblock' : 'Discard'}</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}
    </div>
  );
}
