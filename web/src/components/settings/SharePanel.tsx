/** Settings → Mailboxes → "Share with…": give other users viewer / responder / manager access (T4 F-32). */
import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

interface Share { userId: number; email: string; name: string; role: 'viewer' | 'responder' | 'manager' }
interface Person { id: number; email: string; name: string }

const ROLE_HELP: Record<Share['role'], string> = {
  viewer: 'Viewer — can read, cannot change or send',
  responder: 'Responder — can read, reply and send as this mailbox',
  manager: 'Manager — responder, plus managing assignments',
};

export function SharePanel({ account, onClose }: { account: { id: number; email: string }; onClose: () => void }) {
  const [shares, setShares] = useState<Share[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [who, setWho] = useState('');
  const [role, setRole] = useState<Share['role']>('viewer');

  const load = async () => {
    setShares(await api.get<Share[]>(`/api/accounts/${account.id}/shares`));
    setPeople(await api.get<Person[]>('/api/shares/people'));
  };
  useEffect(() => { void load().catch(() => {}); }, [account.id]);

  const put = async (userId: number, r: Share['role']) => {
    try { await api.put(`/api/accounts/${account.id}/shares`, { userId, role: r }); await load(); toast('Sharing updated'); }
    catch (e: any) { toast(e?.message ?? 'Could not update sharing'); }
  };
  const revoke = async (s: Share) => {
    if (!window.confirm(`Stop sharing ${account.email} with ${s.name || s.email}? They lose access straight away.`)) return;
    await api.del(`/api/accounts/${account.id}/shares/${s.userId}`);
    await load(); toast('Access removed');
  };
  const free = people.filter((p) => !shares.some((s) => s.userId === p.id));

  return (
    <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>Share {account.email} with…</div>
      <p className="settings-desc">People you share with see this mailbox in their switcher under “Shared”. Labels stay personal: they cannot label shared mail.</p>
      {shares.map((s) => (
        <div key={s.userId} className="row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span style={{ flex: 1 }}>{s.name || s.email} <span className="dim">{s.email}</span></span>
          <select className="text-input" value={s.role} onChange={(e) => void put(s.userId, e.target.value as Share['role'])} title={ROLE_HELP[s.role]}>
            <option value="viewer">Viewer</option><option value="responder">Responder</option><option value="manager">Manager</option>
          </select>
          <button className="btn ghost danger" onClick={() => void revoke(s)}>Remove</button>
        </div>
      ))}
      {shares.length === 0 && <div className="dim">Not shared with anyone.</div>}
      <div className="row" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <select className="text-input" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
          <option value="">Pick a person…</option>
          {free.map((p) => <option key={p.id} value={p.id}>{p.name || p.email} ({p.email})</option>)}
        </select>
        <select className="text-input" value={role} onChange={(e) => setRole(e.target.value as Share['role'])} aria-label="Role">
          <option value="viewer">{ROLE_HELP.viewer}</option>
          <option value="responder">{ROLE_HELP.responder}</option>
          <option value="manager">{ROLE_HELP.manager}</option>
        </select>
        <button className="btn primary" disabled={!who} onClick={() => { void put(Number(who), role); setWho(''); }}>Share</button>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
