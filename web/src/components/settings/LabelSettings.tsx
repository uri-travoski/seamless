import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { useMail } from '../../state/mail.ts';
import { toast } from '../../toast.ts';
import LabelColorPicker, { LABEL_COLORS, DEFAULT_LABEL_COLOR } from '../LabelColorPicker.tsx';

interface Editing {
  id?: number; name: string; color: string; description: string;
  retentionDays: number | null; keepDefault: boolean; protected: boolean; autoMarkRead: boolean;
}

function retentionSummary(l: { retentionDays?: number | null; keepDefault?: boolean; protected?: boolean; autoMarkRead?: boolean }): string {
  if (l.protected) return 'protected';
  if (l.keepDefault) return 'keep';
  if (l.retentionDays) return `delete after ${l.retentionDays}d${l.autoMarkRead ? ', auto-read' : ''}`;
  return '';
}

export default function LabelSettings({ autoAdd }: { autoAdd?: boolean }) {
  const labels = useMail((s) => s.labels);
  const refreshLabels = useMail((s) => s.refreshLabels);
  const [editing, setEditing] = useState<Editing | null>(null);

  useEffect(() => {
    if (autoAdd) setEditing({ name: '', color: DEFAULT_LABEL_COLOR, description: '', retentionDays: null, keepDefault: false, protected: false, autoMarkRead: false });
  }, [autoAdd]);

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
      <p className="settings-desc">
        Colored labels work across all accounts, and each label carries its retention: protected labels are never
        auto-deleted, keep-labels keep forever, and a delete-after sets the countdown the retention sweep enforces.
      </p>

      {editing ? (
        <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 14, marginBottom: 14 }}>
          <div className="field"><label>Name</label>
            <input className="text-input" value={editing.name} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
          <div className="field"><label>Description (used by AI categorization)</label>
            <input className="text-input" value={editing.description} placeholder="e.g. Invoices, receipts and payment notifications"
              onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>
          <div className="field"><label>Color</label>
            <div className="swatches palette">
              {LABEL_COLORS.map((c) => (
                <button key={c} className={`swatch ${editing.color === c ? 'on' : ''}`} style={{ background: c }}
                  onClick={() => setEditing({ ...editing, color: c })} aria-label={c} />
              ))}
            </div>
          </div>
          <div className="field"><label>Retention</label>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={editing.protected}
                  onChange={(e) => setEditing({ ...editing, protected: e.target.checked })} />
                Protected (never auto-deleted)
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={editing.keepDefault}
                  onChange={(e) => setEditing({ ...editing, keepDefault: e.target.checked })} />
                Keep forever
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                Delete after
                <input className="text-input" type="number" min={0} style={{ width: 70 }}
                  value={editing.retentionDays ?? ''} placeholder="—"
                  onChange={(e) => setEditing({ ...editing, retentionDays: e.target.value === '' ? null : Number(e.target.value) })} />
                days
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={editing.autoMarkRead}
                  onChange={(e) => setEditing({ ...editing, autoMarkRead: e.target.checked })} />
                Mark read on arrival
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => void save()}>Save label</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn primary" style={{ marginBottom: 14 }}
          onClick={() => setEditing({ name: '', color: DEFAULT_LABEL_COLOR, description: '', retentionDays: null, keepDefault: false, protected: false, autoMarkRead: false })}>Add label</button>
      )}

      {labels.map((l) => (
        <div key={l.id} className="cond-row">
          <LabelColorPicker label={l} dotSize={14} />
          <span style={{ width: 200, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.name}>{l.name}</span>
          <span style={{ width: 150, color: 'var(--md-text-soft)', fontSize: 12 }}>{retentionSummary(l)}</span>
          <span style={{ flex: 1, color: 'var(--md-text-faint)', fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.description}</span>
          <button className="btn ghost" onClick={() => setEditing({
            id: l.id, name: l.name, color: l.color, description: l.description,
            retentionDays: l.retentionDays ?? null, keepDefault: !!l.keepDefault, protected: !!l.protected, autoMarkRead: !!l.autoMarkRead,
          })}>Edit</button>
          <button className="btn ghost danger" onClick={() => void remove(l.id)}>Delete</button>
        </div>
      ))}
    </div>
  );
}
