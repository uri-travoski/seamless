import { useState } from 'react';
import { api } from '../../api/client.ts';
import { useMail } from '../../state/mail.ts';
import { toast } from '../../toast.ts';

const LABEL_COLORS = [
  '#e05656', '#e88b3a', '#c9a13a', '#4d9e53', '#3a9e9e',
  '#2f7ed8', '#7a5fd0', '#d05f8e', '#8a939c', '#5b6570',
];

export default function LabelSettings() {
  const labels = useMail((s) => s.labels);
  const refreshLabels = useMail((s) => s.refreshLabels);
  const [editing, setEditing] = useState<{ id?: number; name: string; color: string; description: string } | null>(null);

  const save = async () => {
    if (!editing?.name.trim()) return;
    try {
      if (editing.id) await api.put(`/api/labels/${editing.id}`, editing);
      else await api.post('/api/labels', editing);
      setEditing(null);
      await refreshLabels();
    } catch (e: any) {
      toast(e?.message ?? 'Label save failed', 'error');
    }
  };

  const remove = async (id: number) => {
    if (!window.confirm('Delete this label? It is removed from all messages.')) return;
    await api.del(`/api/labels/${id}`);
    await refreshLabels();
  };

  return (
    <div>
      <h2>Labels</h2>
      <p className="settings-desc">Colored labels work across all accounts. The description helps the AI categorizer pick the right one.</p>

      {labels.map((l) => (
        <div key={l.id} className="cond-row">
          <span className="label-dot" style={{ background: l.color, width: 14, height: 14 }} />
          <span style={{ width: 160, fontWeight: 600 }}>{l.name}</span>
          <span style={{ flex: 1, color: 'var(--md-text-faint)', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description}</span>
          <button className="btn ghost" onClick={() => setEditing({ id: l.id, name: l.name, color: l.color, description: l.description })}>Edit</button>
          <button className="btn ghost danger" onClick={() => void remove(l.id)}>Delete</button>
        </div>
      ))}

      {editing ? (
        <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 14, marginTop: 14 }}>
          <div className="field"><label>Name</label>
            <input className="text-input" value={editing.name} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
          <div className="field"><label>Description (used by AI categorization)</label>
            <input className="text-input" value={editing.description} placeholder="e.g. Invoices, receipts and payment notifications"
              onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>
          <div className="field"><label>Color</label>
            <div className="swatches">
              {LABEL_COLORS.map((c) => (
                <button key={c} className={`swatch ${editing.color === c ? 'on' : ''}`} style={{ background: c }}
                  onClick={() => setEditing({ ...editing, color: c })} aria-label={c} />
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => void save()}>Save label</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn primary" style={{ marginTop: 14 }}
          onClick={() => setEditing({ name: '', color: LABEL_COLORS[0], description: '' })}>Add label</button>
      )}
    </div>
  );
}
