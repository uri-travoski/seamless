import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

interface Sender { id: number; sender: string; choice: 'inbox' | 'read_later' | 'unsubscribed' }
interface Cfg { archiveAfterRead: boolean; retentionOn: boolean; retentionDays: number; unsubAction: 'trash' | 'archive' }
const LABEL = { inbox: 'Keep in Inbox', read_later: 'Read later', unsubscribed: 'Unsubscribed' } as const;

/** Newsletters (T6.3 F-40): Read later rules, unsubscribe behaviour and the per-sender choices. There is no digest. */
export default function NewsletterSettings() {
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const load = () => {
    void api.get<Cfg>('/api/newsletters/settings').then(setCfg).catch(() => {});
    void api.get<{ items: Sender[] }>('/api/newsletters/senders').then((r) => setSenders(r.items)).catch(() => {});
  };
  useEffect(load, []);
  const save = async (patch: Partial<Cfg>) => {
    try { setCfg(await api.put<Cfg>('/api/newsletters/settings', patch)); } catch (e: any) { toast(e?.message ?? 'Could not save'); }
  };
  if (!cfg) return null;
  return (
    <div className="settings-section">
      <h3>Newsletters</h3>
      <p className="hint">Newsletters you send to <strong>Read later</strong> skip the Inbox and wait in the Read later folder with their reading time.</p>
      <label className="check-row"><input type="checkbox" checked={cfg.archiveAfterRead} onChange={(e) => void save({ archiveAfterRead: e.target.checked })} /> Archive a Read later item once I have read it</label>
      <label className="check-row"><input type="checkbox" checked={cfg.retentionOn} onChange={(e) => void save({ retentionOn: e.target.checked })} />
        Delete Read later items after
        <input className="text-input" type="number" min={1} style={{ width: 70, margin: '0 6px' }} value={cfg.retentionDays}
          onChange={(e) => void save({ retentionDays: Number(e.target.value) || 30 })} /> days unless starred (follows the dry-run switch above)</label>
      <div className="field"><label>After unsubscribing, move the sender’s future mail to</label>
        <select className="text-input" value={cfg.unsubAction} onChange={(e) => void save({ unsubAction: e.target.value as Cfg['unsubAction'] })}>
          <option value="trash">Bin</option><option value="archive">Archive</option>
        </select></div>
      {senders.length > 0 && (
        <table className="plain-table"><tbody>
          {senders.map((s) => (
            <tr key={s.id}><td>{s.sender}</td><td>{LABEL[s.choice]}</td>
              <td><button className="btn ghost" onClick={() => void api.del(`/api/newsletters/senders/${s.id}`).then(load)}>Forget</button></td></tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}
