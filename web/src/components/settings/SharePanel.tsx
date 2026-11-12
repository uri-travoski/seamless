/** Settings → Mailboxes → "Share with…": give other users viewer / responder / manager access (T4 F-32). */
import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

interface Share { userId: number; email: string; name: string; role: 'viewer' | 'responder' | 'manager'; labelsShared?: boolean; labelsStatus?: 'none' | 'pending' | 'accepted' | 'rejected'; labelIds?: number[] }
interface MyLabel { id: number; name: string; color: string; shared?: boolean }
const LABEL_STATUS = { none: '', pending: 'waiting for their answer', accepted: 'accepted', rejected: 'rejected' } as const;
interface Team { allowSnooze: boolean; autoAssign: 'off' | 'round_robin'; members: { userId: number; name: string; email: string; role: string; inPool: boolean; away: boolean }[] }
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
  const [shareLabels, setShareLabels] = useState(false);
  const [myLabels, setMyLabels] = useState<MyLabel[]>([]);
  const [picking, setPicking] = useState<number | null>(null);
  const [team, setTeam] = useState<Team | null>(null);
  const saveTeam = async (patch: { allowSnooze?: boolean; autoAssign?: string; pool?: number[] }) => {
    try { setTeam(await api.put<Team>(`/api/accounts/${account.id}/team`, patch)); toast('Team settings saved'); }
    catch (e: any) { toast(e?.message ?? 'Could not save team settings'); }
  };

  const load = async () => {
    setShares(await api.get<Share[]>(`/api/accounts/${account.id}/shares`));
    setPeople(await api.get<Person[]>('/api/shares/people'));
    setTeam(await api.get<Team>(`/api/accounts/${account.id}/team`).catch(() => null));
    setMyLabels((await api.get<MyLabel[]>('/api/labels')).filter((l) => !l.shared));
  };
  useEffect(() => { void load().catch(() => {}); }, [account.id]);

  const put = async (userId: number, r: Share['role'], extra: Record<string, unknown> = {}) => {
    try { await api.put(`/api/accounts/${account.id}/shares`, { userId, role: r, ...extra }); await load(); toast('Sharing updated'); }
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
      <p className="settings-desc">People you share with see this mailbox in their switcher under “Shared”. Tick “Also share my labels” to offer your labels too: the person can accept or reject them.</p>
      {shares.map((s) => (
        <div key={s.userId} className="row" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <span style={{ flex: 1 }}>{s.name || s.email} <span className="dim">{s.email}</span></span>
          <select className="text-input" value={s.role} onChange={(e) => void put(s.userId, e.target.value as Share['role'])} title={ROLE_HELP[s.role]}>
            <option value="viewer">Viewer</option><option value="responder">Responder</option><option value="manager">Manager</option>
          </select>
          <button className="btn ghost danger" onClick={() => void revoke(s)}>Remove</button>
          <div style={{ flexBasis: '100%', fontSize: 12.5 }}>
            <label><input type="checkbox" checked={!!s.labelsShared} onChange={(e) => void put(s.userId, s.role, { shareLabels: e.target.checked })} /> Also share my labels with this person</label>
            {s.labelsShared && <> <span className="dim">({LABEL_STATUS[s.labelsStatus ?? 'none']}; {s.labelIds?.length ? `${s.labelIds.length} picked` : 'all labels'})</span>{' '}
              <button className="btn ghost small" onClick={() => setPicking(picking === s.userId ? null : s.userId)}>Pick labels</button>
              {s.labelsStatus === 'rejected' && <button className="btn ghost small" onClick={() => void put(s.userId, s.role, { shareLabels: true, reoffer: true })}>Offer again</button>}</>}
            {picking === s.userId && (
              <div style={{ margin: '6px 0 0 20px' }}>
                {myLabels.length === 0 && <span className="dim">You have no labels yet.</span>}
                {myLabels.map((l) => {
                  const ids = s.labelIds ?? [];
                  const on = ids.includes(l.id);
                  return <label key={l.id} style={{ display: 'block' }}><input type="checkbox" checked={on}
                    onChange={() => void put(s.userId, s.role, { shareLabels: true, labelIds: on ? ids.filter((x) => x !== l.id) : [...ids, l.id] })} /> {l.name}</label>;
                })}
                <div className="dim">Nothing ticked = all your labels.</div>
              </div>
            )}
          </div>
        </div>
      ))}
      {shares.length === 0 && <div className="dim">Not shared with anyone.</div>}
      {team && (
        <div style={{ borderTop: '1px solid var(--md-border)', marginTop: 10, paddingTop: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Team settings</div>
          <label style={{ display: 'block', fontSize: 12.5, marginTop: 4 }}><input type="checkbox" checked={team.allowSnooze} onChange={(e) => void saveTeam({ allowSnooze: e.target.checked })} /> Allow snoozing: a snooze hides the thread for everyone on this mailbox. Follow-up reminders stay with the owner.</label>
          <label style={{ display: 'block', fontSize: 12.5, marginTop: 4 }}><input type="checkbox" checked={team.autoAssign === 'round_robin'} onChange={(e) => void saveTeam({ autoAssign: e.target.checked ? 'round_robin' : 'off' })} /> Hand out new threads in turn (round robin). Only new mail that arrives live; replies and old mail are left alone.</label>
          {team.autoAssign === 'round_robin' && (
            <div style={{ margin: '4px 0 0 20px', fontSize: 12.5 }}>
              {team.members.map((m) => (
                <label key={m.userId} style={{ display: 'block' }}><input type="checkbox" checked={m.inPool}
                  onChange={() => void saveTeam({ pool: team.members.filter((x) => (x.userId === m.userId ? !x.inPool : x.inPool)).map((x) => x.userId) })} /> {m.name} <span className="dim">({m.role}){m.away ? ' · away' : ''}</span> takes part in round robin</label>
              ))}
              <div className="dim">Each person can switch themselves “away” in Settings → Mailboxes; they are skipped until they are back. If nobody is available the thread stays unassigned.</div>
            </div>
          )}
        </div>
      )}
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
        <label style={{ alignSelf: 'center', fontSize: 12.5 }}><input type="checkbox" checked={shareLabels} onChange={(e) => setShareLabels(e.target.checked)} /> Also share my labels with this person</label>
        <button className="btn primary" disabled={!who} onClick={() => { void put(Number(who), role, shareLabels ? { shareLabels: true } : {}); setWho(''); setShareLabels(false); }}>Share</button>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
