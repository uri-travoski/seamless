/** "Filed by AI · 92 % · why?" under the labels in the reading pane (T8.10), with "Wrong? Fix it". */
import { useEffect, useState } from 'react';
import type { ApiEmail } from '@seamless/shared';
import { api } from '../api/client.ts';
import { useMail } from '../state/mail.ts';
import { toast, undoToast } from '../toast.ts';

interface Why {
  visible: boolean; filedBy?: 'rule' | 'similar' | 'ai' | 'note'; corrected?: boolean; confidence?: number; reason?: string; model?: string; at?: number;
  rule?: { field: string; value: string } | null; similar?: { subject: string; from: string; corrected: boolean } | null;
  labels?: { id: number; name: string }[]; retention?: { disposition: string; deleteAt: number | null; keepReason: string | null };
  offerRule?: { suggestionId: number; matchValue: string; labelId: number; evidence: number } | null;
}

const WHO: Record<string, string> = { rule: 'Filed by a rule', similar: 'Filed by similar mail', ai: 'Filed by AI', note: 'Filed by your note' };

export function WhyLine({ email }: { email: ApiEmail }) {
  const labels = useMail((s) => s.labels);
  const [why, setWhy] = useState<Why | null>(null);
  const [open, setOpen] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [labelId, setLabelId] = useState<string>('');
  const [mode, setMode] = useState<'' | 'keep' | 'delete'>('');
  const [days, setDays] = useState('30');
  const [remember, setRemember] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.get<Why>(`/api/message/${email.id}/why`).then(setWhy, () => setWhy(null));
  useEffect(() => { void load(); }, [email.id, email.labelIds.join(',')]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!why?.visible) return null;

  const pct = why.confidence != null && why.filedBy !== 'rule' ? ` · ${Math.round(why.confidence * 100)} %` : '';
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ correctionId: number; remembered: boolean; offerRule: Why['offerRule'] }>(`/api/message/${email.id}/correct`, {
        labelId: labelId ? Number(labelId) : null, retention: mode ? (mode === 'keep' ? { mode } : { mode, days: Number(days) }) : null, remember, why: note.trim(),
      });
      setFixing(false); setNote('');
      undoToast(res.remembered ? 'Fixed — the AI will remember this' : 'Fixed', () => {
        void api.post(`/api/corrections/${res.correctionId}/undo`).then(() => { toast('Correction undone'); void load(); }, () => toast('Could not undo', 'error'));
      });
      if (res.offerRule) {
        const o = res.offerRule;
        undoToast(`You have fixed mail from ${o.matchValue} ${o.evidence} times. Make this a rule?`, () => {
          void api.post(`/api/suggestions/${o.suggestionId}/accept`).then(() => toast('Rule created'), () => toast('Could not create the rule', 'error'));
        });
      }
      await load();
    } catch (e: any) { toast(e?.message ?? 'Could not save the correction', 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="why-line" onClick={(e) => e.stopPropagation()}>
      <button className="details-toggle" style={{ fontSize: 11.5 }} onClick={() => setOpen((v) => !v)}>
        {why.corrected ? 'Fixed by you' : WHO[why.filedBy ?? 'ai']}{pct} · why?
      </button>
      {open && (
        <div className="why-box" style={{ fontSize: 12, color: 'var(--md-text-faint)', marginTop: 4 }}>
          {why.rule && <div>Rule: <b>{why.rule.field.replace(/_/g, ' ')}</b> “{why.rule.value}”</div>}
          {why.similar && <div>Similar {why.similar.corrected ? 'message you corrected' : 'example'}: “{why.similar.subject}” from {why.similar.from}</div>}
          {why.reason && <div>Reason: {why.reason}</div>}
          {why.model && <div>Model: {why.model}</div>}
          {why.at && <div>Decided {new Date(why.at).toLocaleString()}</div>}
          {why.retention?.keepReason && <div>{why.retention.keepReason}</div>}
          {!fixing && <button className="btn small" style={{ marginTop: 4 }} onClick={() => { setFixing(true); setLabelId(String(why.labels?.[0]?.id ?? '')); }}>Wrong? Fix it</button>}
          {fixing && (
            <div className="teach-box" style={{ padding: 8, marginTop: 6, borderRadius: 6, border: '1px solid var(--color-border)' }}>
              <label>Right label{' '}
                <select value={labelId} onChange={(e) => setLabelId(e.target.value)}>
                  <option value="">No label</option>
                  {labels.filter((l) => !l.shared).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
              <div style={{ marginTop: 4 }}>
                <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
                  <option value="">Keep / delete as the label says</option>
                  <option value="keep">Keep</option>
                  <option value="delete">Delete after N days</option>
                </select>
                {mode === 'delete' && <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 70, marginLeft: 6 }} />}
              </div>
              <label style={{ display: 'block', marginTop: 4 }}><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember this for similar mail</label>
              <input type="text" placeholder="Why? (optional, becomes guidance for the AI)" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <button className="btn primary small" disabled={busy} onClick={() => void submit()}>{busy ? 'Saving…' : 'Save correction'}</button>
                <button className="btn ghost small" onClick={() => setFixing(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
