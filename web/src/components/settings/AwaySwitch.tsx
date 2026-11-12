/** "I'm away" for the shared mailboxes whose round robin I take part in (T8.3). */
import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

interface Pool { accountId: number; email: string; away: boolean }

export function AwaySwitch() {
  const [pools, setPools] = useState<Pool[]>([]);
  const load = () => api.get<Pool[]>('/api/team/pools').then(setPools).catch(() => {});
  useEffect(() => { void load(); }, []);
  if (!pools.length) return null;
  const set = async (p: Pool, away: boolean) => {
    try { await api.put(`/api/accounts/${p.accountId}/team/away`, { away }); await load(); toast(away ? 'You are away: new threads skip you' : 'You are back in the round robin'); }
    catch (e: any) { toast(e?.message ?? 'Could not change that'); }
  };
  return (
    <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 12, marginTop: 12 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>Round robin</div>
      <p className="settings-desc">New threads on these shared mailboxes are handed out in turn. Switch yourself away and you are skipped until you are back.</p>
      {pools.map((p) => (
        <label key={p.accountId} style={{ display: 'block', fontSize: 13 }}>
          <input type="checkbox" checked={p.away} onChange={(e) => void set(p, e.target.checked)} /> I’m away from {p.email}
        </label>
      ))}
    </div>
  );
}
