import { useEffect, useState } from 'react';
import type { ApiFilter, FilterCondition, FilterAction } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { useMail } from '../../state/mail.ts';
import { toast } from '../../toast.ts';
import { CloseIcon } from '../../icons.tsx';

const FIELDS: FilterCondition['field'][] = ['from', 'to', 'cc', 'subject', 'body', 'has_attachment', 'account'];
const OPS: FilterCondition['op'][] = ['contains', 'not_contains', 'equals', 'starts_with', 'ends_with'];
const MOVE_TARGETS = ['archive', 'trash', 'junk'];

type EditFilter = Omit<ApiFilter, 'id'> & { id?: number };

const BLANK: EditFilter = {
  name: '', enabled: true, sort: 0, match: 'all',
  conditions: [{ field: 'from', op: 'contains', value: '' }],
  actions: [{ type: 'markRead' }],
  stop: false,
};

export default function FilterSettings() {
  const labels = useMail((s) => s.labels);
  const [filters, setFilters] = useState<ApiFilter[]>([]);
  const [editing, setEditing] = useState<EditFilter | null>(null);

  const load = () => void api.get<ApiFilter[]>('/api/filters').then(setFilters).catch(() => {});
  useEffect(load, []);

  // "Create filter from this" (message menu) lands here with the sender + subject filled in
  useEffect(() => {
    const raw = sessionStorage.getItem('seamless-filter-prefill');
    if (!raw) return;
    sessionStorage.removeItem('seamless-filter-prefill');
    try {
      const p = JSON.parse(raw) as { name: string; from: string; subject: string };
      const conditions: FilterCondition[] = [{ field: 'from', op: 'contains', value: p.from }];
      if (p.subject) conditions.push({ field: 'subject', op: 'contains', value: p.subject.replace(/^(re|fwd?):\s*/i, '') });
      setEditing({ ...BLANK, name: p.name, conditions });
    } catch { /* ignore a bad prefill */ }
  }, []);

  const save = async () => {
    if (!editing?.name.trim()) { toast('Give the filter a name', 'error'); return; }
    if (editing.id) await api.put(`/api/filters/${editing.id}`, editing);
    else await api.post('/api/filters', editing);
    setEditing(null);
    load();
  };

  const run = async (id: number) => {
    const res = await api.post<{ applied: number }>(`/api/filters/${id}/run`);
    toast(`Filter applied to ${res.applied} existing message${res.applied === 1 ? '' : 's'}`);
    void useMail.getState().refreshCurrent();
  };

  const describeAction = (a: FilterAction): string => {
    switch (a.type) {
      case 'move': return `move to ${a.value}`;
      case 'label': return `label "${labels.find((l) => l.id === Number(a.value))?.name ?? a.value}"`;
      case 'markRead': return 'mark read';
      case 'star': return 'star';
      case 'delete': return 'delete';
    }
  };

  if (editing) {
    const e = editing;
    return (
      <div>
        <h2>{e.id ? 'Edit filter' : 'New filter'}</h2>
        <div className="field"><label>Name</label>
          <input className="text-input" value={e.name} autoFocus onChange={(ev) => setEditing({ ...e, name: ev.target.value })} /></div>

        <h3>When a new message matches
          <select className="text-input" style={{ width: 'auto', marginLeft: 8, display: 'inline-block' }} value={e.match}
            onChange={(ev) => setEditing({ ...e, match: ev.target.value as 'all' | 'any' })}>
            <option value="all">all</option><option value="any">any</option>
          </select> of:
        </h3>
        {e.conditions.map((c, i) => (
          <div key={i} className="cond-row">
            <select className="text-input" style={{ width: 130 }} value={c.field}
              onChange={(ev) => setEditing({ ...e, conditions: e.conditions.map((x, j) => j === i ? { ...x, field: ev.target.value as any } : x) })}>
              {FIELDS.map((f) => <option key={f} value={f}>{f.replace('_', ' ')}</option>)}
            </select>
            <select className="text-input" style={{ width: 130 }} value={c.op}
              onChange={(ev) => setEditing({ ...e, conditions: e.conditions.map((x, j) => j === i ? { ...x, op: ev.target.value as any } : x) })}>
              {OPS.map((o) => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}
            </select>
            <input className="text-input" style={{ flex: 1 }} value={c.value} placeholder={c.field === 'has_attachment' ? 'yes / no' : 'value'}
              onChange={(ev) => setEditing({ ...e, conditions: e.conditions.map((x, j) => j === i ? { ...x, value: ev.target.value } : x) })} />
            <button className="icon-btn" onClick={() => setEditing({ ...e, conditions: e.conditions.filter((_, j) => j !== i) })} aria-label="Remove condition"><CloseIcon size={14} /></button>
          </div>
        ))}
        <button className="btn ghost" onClick={() => setEditing({ ...e, conditions: [...e.conditions, { field: 'subject', op: 'contains', value: '' }] })}>+ condition</button>

        <h3>Do:</h3>
        {e.actions.map((a, i) => (
          <div key={i} className="cond-row">
            <select className="text-input" style={{ width: 150 }} value={a.type}
              onChange={(ev) => setEditing({ ...e, actions: e.actions.map((x, j) => j === i ? { type: ev.target.value as any, value: undefined } : x) })}>
              <option value="markRead">mark as read</option>
              <option value="star">star</option>
              <option value="label">add label</option>
              <option value="move">move to</option>
              <option value="delete">move to trash</option>
            </select>
            {a.type === 'label' && (
              <select className="text-input" style={{ width: 180 }} value={a.value ?? ''}
                onChange={(ev) => setEditing({ ...e, actions: e.actions.map((x, j) => j === i ? { ...x, value: ev.target.value } : x) })}>
                <option value="">choose label…</option>
                {labels.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
              </select>
            )}
            {a.type === 'move' && (
              <select className="text-input" style={{ width: 180 }} value={a.value ?? ''}
                onChange={(ev) => setEditing({ ...e, actions: e.actions.map((x, j) => j === i ? { ...x, value: ev.target.value } : x) })}>
                <option value="">choose folder…</option>
                {MOVE_TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
            <button className="icon-btn" onClick={() => setEditing({ ...e, actions: e.actions.filter((_, j) => j !== i) })} aria-label="Remove action"><CloseIcon size={14} /></button>
          </div>
        ))}
        <button className="btn ghost" onClick={() => setEditing({ ...e, actions: [...e.actions, { type: 'markRead' }] })}>+ action</button>

        <div style={{ marginTop: 10 }}>
          <label className="checkbox-line">
            <input type="checkbox" checked={e.stop} onChange={(ev) => setEditing({ ...e, stop: ev.target.checked })} />
            Stop processing further filters when this one matches
          </label>
          <label className="checkbox-line">
            <input type="checkbox" checked={e.enabled} onChange={(ev) => setEditing({ ...e, enabled: ev.target.checked })} />
            Enabled
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn primary" onClick={() => void save()}>Save filter</button>
          <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2>Filters</h2>
      <p className="settings-desc">Applied in order to new incoming inbox mail, across all accounts. "Run now" applies a filter to mail already in your inboxes.</p>
      {filters.map((flt) => (
        <div key={flt.id} className="cond-row" style={{ opacity: flt.enabled ? 1 : 0.5 }}>
          <span style={{ width: 170, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flt.name}</span>
          <span style={{ flex: 1, fontSize: 12.5, color: 'var(--md-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {flt.match === 'all' ? 'all of' : 'any of'} {flt.conditions.map((c) => `${c.field} ${c.op.replace('_', ' ')} "${c.value}"`).join(', ')}
            {' → '}{flt.actions.map(describeAction).join(', ')}
          </span>
          <button className="btn ghost" onClick={() => void run(flt.id)}>Run now</button>
          <button className="btn ghost" onClick={() => setEditing(flt)}>Edit</button>
          <button className="btn ghost danger" onClick={async () => { await api.del(`/api/filters/${flt.id}`); load(); }}>Delete</button>
        </div>
      ))}
      {filters.length === 0 && <p style={{ color: 'var(--md-text-faint)', fontSize: 13 }}>No filters yet.</p>}
      <button className="btn primary" style={{ marginTop: 14 }} onClick={() => setEditing({ ...BLANK, conditions: [...BLANK.conditions], actions: [...BLANK.actions] })}>Add filter</button>
    </div>
  );
}
