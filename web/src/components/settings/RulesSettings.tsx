import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { useMail } from '../../state/mail.ts';
import { toast } from '../../toast.ts';
import type { ApiRule, ApiPreference, ApiRuleSuggestion } from '@seamless/shared';

const FIELDS: [string, string][] = [
  ['from', 'From (exact)'], ['from_domain', 'From domain'], ['to', 'To'],
  ['delivered_to', 'Delivered-To (base address)'], ['subject_contains', 'Subject contains'],
  ['body_contains', 'Body contains'], ['header', 'Header (name:value)'], ['list_id', 'List-Id'],
  ['category', 'Category (promotions)'],
];

interface EditingRule {
  id?: number; enabled: boolean; ord: number; matchField: string; matchValue: string;
  excludeContains: string; action: 'label' | 'ai'; labelId: number | null; stop: boolean; note: string;
}

export default function RulesSettings() {
  const labels = useMail((s) => s.labels);
  const [rules, setRules] = useState<ApiRule[]>([]);
  const [prefs, setPrefs] = useState<ApiPreference[]>([]);
  const [suggestions, setSuggestions] = useState<ApiRuleSuggestion[]>([]);
  const [editing, setEditing] = useState<EditingRule | null>(null);
  const [newPref, setNewPref] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setRules(await api.get<ApiRule[]>('/api/rules'));
    setPrefs(await api.get<ApiPreference[]>('/api/preferences'));
    setSuggestions(await api.get<ApiRuleSuggestion[]>('/api/suggestions'));
  };
  useEffect(() => { void refresh(); }, []);

  const labelName = (id: number | null) => labels.find((l) => l.id === id)?.name ?? '?';

  const saveRule = async () => {
    if (!editing) return;
    try {
      if (editing.id) await api.put(`/api/rules/${editing.id}`, editing);
      else await api.post('/api/rules', editing);
      setEditing(null);
      await refresh();
    } catch (e: any) { toast(e?.message ?? 'Rule save failed', 'error'); }
  };

  const toggleRule = async (r: ApiRule) => {
    await api.put(`/api/rules/${r.id}`, { ...r, enabled: !r.enabled });
    await refresh();
  };

  const removeRule = async (id: number) => {
    await api.del(`/api/rules/${id}`);
    await refresh();
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ queued: number }>('/api/classify/run');
      toast(`Re-classifying ${res.queued} messages in the background`, 'info');
    } finally { setBusy(false); }
  };

  const addPref = async () => {
    if (!newPref.trim()) return;
    await api.post('/api/preferences', { guidance: newPref.trim() });
    setNewPref('');
    await refresh();
  };

  return (
    <div>
      <h2>Rules</h2>
      <p className="settings-desc">
        Deterministic rules run first on every incoming message, in order — free and instant. A rule set to
        <b> AI</b> hands the message to the AI classifier instead of a fixed label. Import your spreadsheet
        (Import &amp; Retention tab) to seed these.
      </p>
      <button className="btn primary" disabled={busy} onClick={() => void runNow()}>Re-run rules on existing mail</button>

      {suggestions.length > 0 && (
        <div style={{ border: '1px solid #cfe0cd', background: '#f2f8f1', borderRadius: 8, padding: 12, marginTop: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Suggested rules from your corrections</div>
          {suggestions.map((s) => (
            <div key={s.id} className="cond-row" style={{ margin: 0, padding: '4px 0' }}>
              <span style={{ flex: 1, fontSize: 12.5 }}>
                Mail from <b>{s.matchValue}</b> → {labelName(s.labelId)} <span style={{ color: 'var(--md-text-faint)' }}>(you did this {s.evidence}×)</span>
              </span>
              <button className="btn primary" onClick={async () => { await api.post(`/api/suggestions/${s.id}/accept`); await refresh(); toast('Rule created'); }}>Make it a rule</button>
              <button className="btn ghost" onClick={async () => { await api.post(`/api/suggestions/${s.id}/dismiss`); await refresh(); }}>Dismiss</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 14, maxHeight: 340, overflowY: 'auto', border: rules.length ? '1px solid var(--md-border)' : 'none', borderRadius: 8 }}>
        {rules.map((r) => (
          <div key={r.id} className="cond-row" style={{ opacity: r.enabled ? 1 : 0.45, margin: 0, padding: '6px 10px', borderBottom: '1px solid var(--md-border)' }}>
            <input type="checkbox" checked={r.enabled} title="Enabled" onChange={() => void toggleRule(r)} />
            <span style={{ width: 44, color: 'var(--md-text-faint)', fontSize: 11 }}>{r.ord}</span>
            <span style={{ width: 120, fontSize: 12, color: 'var(--md-text-soft)' }}>{FIELDS.find(([k]) => k === r.matchField)?.[1] ?? r.matchField}</span>
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.note}>{r.matchValue}</span>
            <span style={{ width: 150, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.action === 'ai' ? <b style={{ color: 'var(--md-blue)' }}>AI decides</b> : `→ ${labelName(r.labelId)}`}
            </span>
            <span style={{ width: 50, fontSize: 11, color: 'var(--md-text-faint)', textAlign: 'right' }} title="Times matched">{r.hitCount > 0 ? `${r.hitCount}×` : ''}</span>
            <button className="btn ghost" onClick={() => setEditing({
              id: r.id, enabled: r.enabled, ord: r.ord, matchField: r.matchField, matchValue: r.matchValue,
              excludeContains: r.excludeContains, action: r.action, labelId: r.labelId, stop: r.stop, note: r.note,
            })}>Edit</button>
            <button className="btn ghost danger" onClick={() => void removeRule(r.id)}>Delete</button>
          </div>
        ))}
        {rules.length === 0 && <p style={{ color: 'var(--md-text-faint)', fontSize: 13 }}>No rules yet — add one below or import your spreadsheet.</p>}
      </div>

      {editing ? (
        <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 14, marginTop: 14 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: '0 0 90px' }}><label>Order</label>
              <input className="text-input" type="number" value={editing.ord} onChange={(e) => setEditing({ ...editing, ord: Number(e.target.value) })} /></div>
            <div className="field" style={{ flex: '0 0 200px' }}><label>Match field</label>
              <select className="text-input" value={editing.matchField} onChange={(e) => setEditing({ ...editing, matchField: e.target.value })}>
                {FIELDS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}
              </select></div>
            <div className="field" style={{ flex: 1 }}><label>Match value</label>
              <input className="text-input" value={editing.matchValue} onChange={(e) => setEditing({ ...editing, matchValue: e.target.value })} /></div>
          </div>
          <div className="field"><label>Exclude if contains (comma-separated)</label>
            <input className="text-input" value={editing.excludeContains} onChange={(e) => setEditing({ ...editing, excludeContains: e.target.value })} /></div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: '0 0 160px' }}><label>Action</label>
              <select className="text-input" value={editing.action} onChange={(e) => setEditing({ ...editing, action: e.target.value as 'label' | 'ai' })}>
                <option value="label">Apply label</option>
                <option value="ai">AI decides</option>
              </select></div>
            {editing.action === 'label' && (
              <div className="field" style={{ flex: 1 }}><label>Label</label>
                <select className="text-input" value={editing.labelId ?? ''} onChange={(e) => setEditing({ ...editing, labelId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Choose…</option>
                  {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select></div>
            )}
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, paddingBottom: 10 }}>
              <input type="checkbox" checked={editing.stop} onChange={(e) => setEditing({ ...editing, stop: e.target.checked })} />
              Stop after match
            </label>
          </div>
          <div className="field"><label>Note</label>
            <input className="text-input" value={editing.note} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={!editing.matchValue.trim() || (editing.action === 'label' && !editing.labelId)} onClick={() => void saveRule()}>Save rule</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn primary" style={{ marginTop: 12 }}
          onClick={() => setEditing({ enabled: true, ord: (rules.at(-1)?.ord ?? 0) + 10, matchField: 'from_domain', matchValue: '', excludeContains: '', action: 'label', labelId: null, stop: true, note: '' })}>
          Add rule
        </button>
      )}

      <h3 style={{ fontSize: 14, marginTop: 26 }}>AI preferences (plain English)</h3>
      <p className="settings-desc">Injected into every AI classification once the AI tier is enabled. Editing bumps the version so decisions stay auditable.</p>
      {prefs.map((p) => (
        <div key={p.id} className="cond-row">
          <span style={{ flex: 1, fontSize: 12.5 }}>{p.guidance}</span>
          <span style={{ color: 'var(--md-text-faint)', fontSize: 11 }}>v{p.version}</span>
          <button className="btn ghost danger" onClick={async () => { await api.del(`/api/preferences/${p.id}`); await refresh(); }}>Delete</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input className="text-input" style={{ flex: 1 }} placeholder='e.g. "Shipping and parcel-tracking updates -> To Delete"'
          value={newPref} onChange={(e) => setNewPref(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addPref()} />
        <button className="btn primary" disabled={!newPref.trim()} onClick={() => void addPref()}>Add</button>
      </div>
    </div>
  );
}
