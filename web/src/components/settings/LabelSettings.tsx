/**
 * Settings → Labels (T1 F-11): table of labels (colour, name, parent, count, sidebar
 * visibility, retention), merge and bulk delete, sidebar sort, and the sidebar layout.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ApiLabel } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { useMail } from '../../state/mail.ts';
import { useSession, DEFAULT_SIDEBAR, SIDEBAR_FOLDERS, normaliseSidebar } from '../../state/session.ts';
import { FOLDER_TITLE } from '../../router.ts';
import { toast } from '../../toast.ts';
import { labelTree } from '../Sidebar.tsx';
import LabelColorPicker, { LABEL_COLORS, DEFAULT_LABEL_COLOR } from '../LabelColorPicker.tsx';
import { CaretUpIcon, CaretDownIcon } from '../../icons.tsx';

interface Editing {
  id?: number; name: string; color: string; description: string; parentId: number | null;
  sidebarVisibility: 'always' | 'unread' | 'hidden';
  retentionDays: number | null; keepDefault: boolean; protected: boolean; autoMarkRead: boolean;
}

const NEW: Editing = { name: '', color: DEFAULT_LABEL_COLOR, description: '', parentId: null, sidebarVisibility: 'always', retentionDays: null, keepDefault: false, protected: false, autoMarkRead: false };

function retentionSummary(l: ApiLabel): string {
  if (l.protected) return 'protected';
  if (l.keepDefault) return 'keep';
  if (l.retentionDays) return `delete after ${l.retentionDays}d${l.autoMarkRead ? ', auto-read' : ''}`;
  return '—';
}

function SidebarLayout() {
  const sidebar = normaliseSidebar(useSession((s) => s.settings.sidebar));
  const save = useSession((s) => s.saveSettings);
  const all = [...sidebar.order, ...sidebar.more, ...SIDEBAR_FOLDERS.filter((f) => !sidebar.order.includes(f) && !sidebar.more.includes(f))];
  const set = (order: string[], more: string[]) => save({ sidebar: { order, more } });
  const move = (f: string, dir: -1 | 1) => {
    const order = [...sidebar.order];
    const i = order.indexOf(f);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    set(order, sidebar.more);
  };
  return (
    <div>
      <p className="settings-desc">The order of folders in the sidebar. Anything under “More” is one click away.</p>
      <div className="sidebar-layout">
        {all.map((f) => {
          const inMain = sidebar.order.includes(f);
          return (
            <div key={f} className="sl-row">
              <span className="sl-name">{FOLDER_TITLE[f] ?? f}</span>
              {inMain && <>
                <button className="icon-btn" title="Up" onClick={() => move(f, -1)}><CaretUpIcon size={14} /></button>
                <button className="icon-btn" title="Down" onClick={() => move(f, 1)}><CaretDownIcon size={14} /></button>
              </>}
              <button className="btn ghost small" disabled={f === 'inbox'}
                onClick={() => (inMain ? set(sidebar.order.filter((x) => x !== f), [...sidebar.more, f]) : set([...sidebar.order, f], sidebar.more.filter((x) => x !== f)))}>
                {inMain ? 'Move to More' : 'Show in sidebar'}
              </button>
            </div>
          );
        })}
      </div>
      <button className="linklike" onClick={() => set(DEFAULT_SIDEBAR.order, DEFAULT_SIDEBAR.more)}>Reset to default</button>
    </div>
  );
}

export default function LabelSettings() {
  const labels = useMail((s) => s.labels);
  const refreshLabels = useMail((s) => s.refreshLabels);
  const labelSort = useSession((s) => s.settings.labelSort) ?? 'az';
  const save = useSession((s) => s.saveSettings);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [merge, setMerge] = useState<{ sourceId: number; targetId: number } | null>(null);

  useEffect(() => {
    if (sessionStorage.getItem('seamless-new-label')) { sessionStorage.removeItem('seamless-new-label'); setEditing({ ...NEW }); }
    void refreshLabels();
  }, [refreshLabels]);

  // flattened tree so children sit under their parent
  const rows = useMemo(() => {
    const out: { label: ApiLabel; depth: number }[] = [];
    const walk = (nodes: ReturnType<typeof labelTree>, depth: number) => { for (const n of nodes) { out.push({ label: n.label, depth }); walk(n.children, depth + 1); } };
    walk(labelTree(labels, labelSort, false), 0);
    return out;
  }, [labels, labelSort]);

  const submit = async () => {
    if (!editing?.name.trim()) return;
    try {
      if (editing.id) await api.put(`/api/labels/${editing.id}`, editing);
      else await api.post('/api/labels', editing);
      setEditing(null);
      await refreshLabels();
    } catch (e: any) { toast(e?.message ?? 'Label save failed', 'error'); }
  };

  const quick = async (l: ApiLabel, patch: Partial<Editing>) => {
    try { await api.put(`/api/labels/${l.id}`, patch); await refreshLabels(); } catch (e: any) { toast(e?.message ?? 'Failed', 'error'); }
  };

  const bulkDelete = async () => {
    if (!window.confirm(`Delete ${checked.size} label${checked.size === 1 ? '' : 's'}? They're removed from every message.`)) return;
    await api.post('/api/labels/delete', { ids: [...checked] });
    setChecked(new Set());
    await refreshLabels();
  };

  const doMerge = async () => {
    if (!merge) return;
    try {
      const r = await api.post<{ moved: number }>('/api/labels/merge', merge);
      toast(`Merged — ${r.moved} message${r.moved === 1 ? '' : 's'} moved`);
      setMerge(null); setChecked(new Set());
      await refreshLabels();
    } catch (e: any) { toast(e?.message ?? 'Merge failed', 'error'); }
  };

  const moveManual = async (l: ApiLabel, dir: -1 | 1) => {
    const siblings = labels.filter((x) => (x.parentId ?? null) === (l.parentId ?? null)).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
    const i = siblings.findIndex((x) => x.id === l.id);
    const j = i + dir;
    if (j < 0 || j >= siblings.length) return;
    [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
    await api.put('/api/labels/order', { ids: siblings.map((x) => x.id) });
    await refreshLabels();
  };

  const checkedList = [...checked];

  return (
    <div>
      <h2>Labels</h2>
      <p className="settings-desc">
        Labels work across every mailbox. Nest them under a parent, choose when they show in the sidebar, and give each a
        retention: protected labels are never auto-deleted, keep-labels keep forever, delete-after starts a countdown.
      </p>

      {editing && (
        <div className="edit-card">
          <div className="field-row">
            <div className="field"><label>Name</label>
              <input className="text-input" value={editing.name} autoFocus onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
            <div className="field"><label>Inside</label>
              <select className="text-input" value={editing.parentId ?? ''} onChange={(e) => setEditing({ ...editing, parentId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">— top level —</option>
                {labels.filter((l) => l.id !== editing.id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select></div>
            <div className="field"><label>Show in sidebar</label>
              <select className="text-input" value={editing.sidebarVisibility} onChange={(e) => setEditing({ ...editing, sidebarVisibility: e.target.value as Editing['sidebarVisibility'] })}>
                <option value="always">Always</option><option value="unread">Only if unread</option><option value="hidden">Hidden</option>
              </select></div>
          </div>
          <div className="field"><label>Description (used by AI categorisation)</label>
            <input className="text-input" value={editing.description} placeholder="e.g. Invoices, receipts and payment notifications"
              onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></div>
          <div className="field"><label>Colour</label>
            <div className="swatches palette">
              {LABEL_COLORS.map((c) => (
                <button key={c} className={`swatch ${editing.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setEditing({ ...editing, color: c })} aria-label={c} />
              ))}
            </div>
            <div className="custom-color">
              <input type="color" value={editing.color} aria-label="Custom colour" onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
              <span>Custom colour</span><code className={LABEL_COLORS.includes(editing.color) ? '' : 'on'}>{editing.color}</code>
            </div>
          </div>
          <div className="field"><label>Retention</label>
            <div className="inline-checks">
              <label><input type="checkbox" checked={editing.protected} onChange={(e) => setEditing({ ...editing, protected: e.target.checked })} /> Protected (never auto-deleted)</label>
              <label><input type="checkbox" checked={editing.keepDefault} onChange={(e) => setEditing({ ...editing, keepDefault: e.target.checked })} /> Keep forever</label>
              <label>Delete after
                <input className="text-input compact inline" type="number" min={0} style={{ width: 70 }} value={editing.retentionDays ?? ''} placeholder="—"
                  onChange={(e) => setEditing({ ...editing, retentionDays: e.target.value === '' ? null : Number(e.target.value) })} /> days</label>
              <label><input type="checkbox" checked={editing.autoMarkRead} onChange={(e) => setEditing({ ...editing, autoMarkRead: e.target.checked })} /> Mark read on arrival</label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => void submit()}>Save label</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="label-toolbar">
        {!editing && <button className="btn primary" onClick={() => setEditing({ ...NEW })}>New label</button>}
        <label className="dim">Sidebar order{' '}
          <select className="text-input compact" value={labelSort} onChange={(e) => save({ labelSort: e.target.value as any })}>
            <option value="az">A–Z</option><option value="manual">Manual</option><option value="count">Most messages first</option>
          </select>
        </label>
        <div style={{ flex: 1 }} />
        {checked.size === 2 && <button className="btn" onClick={() => setMerge({ sourceId: checkedList[0], targetId: checkedList[1] })}>Merge…</button>}
        {checked.size > 0 && <button className="btn danger" onClick={() => void bulkDelete()}>Delete {checked.size}</button>}
      </div>

      {merge && (
        <div className="edit-card">
          <p>Merge <b>{labels.find((l) => l.id === merge.sourceId)?.name}</b> into{' '}
            <select className="text-input compact inline" value={merge.targetId} onChange={(e) => setMerge({ ...merge, targetId: Number(e.target.value) })}>
              {labels.filter((l) => l.id !== merge.sourceId).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>?
          </p>
          <p className="hint">Every message, rule, filter and AI memory using the first label moves to the second; the first is deleted.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => void doMerge()}>Merge</button>
            <button className="btn ghost" onClick={() => setMerge({ sourceId: merge.targetId, targetId: merge.sourceId })}>Swap</button>
            <button className="btn ghost" onClick={() => setMerge(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="table-scroll">
        <table className="tbl label-table">
          <thead><tr><th style={{ width: 28 }}></th><th>Label</th><th>Messages</th><th>Sidebar</th><th>Retention</th><th></th></tr></thead>
          <tbody>
            {rows.map(({ label: l, depth }) => (
              <tr key={l.id}>
                <td><input type="checkbox" className="row-check" checked={checked.has(l.id)} aria-label={`Select ${l.name}`}
                  onChange={(e) => { const s = new Set(checked); if (e.target.checked) s.add(l.id); else s.delete(l.id); setChecked(s); }} /></td>
                <td>
                  <span className="label-cell" style={{ paddingLeft: depth * 18 }}>
                    <LabelColorPicker label={l} dotSize={13} />
                    <span className="label-cell-name" title={l.description || l.name}>{l.name}</span>
                  </span>
                </td>
                <td className="num">{(l.total ?? 0).toLocaleString()}{(l.unread ?? 0) > 0 && <span className="dim"> · {l.unread} unread</span>}</td>
                <td>
                  <select className="text-input compact" value={l.sidebarVisibility ?? 'always'} onChange={(e) => void quick(l, { sidebarVisibility: e.target.value as any })} aria-label="Sidebar visibility">
                    <option value="always">Always</option><option value="unread">If unread</option><option value="hidden">Hidden</option>
                  </select>
                </td>
                <td className="dim">{retentionSummary(l)}</td>
                <td className="row-btns">
                  {labelSort === 'manual' && <>
                    <button className="icon-btn" title="Up" onClick={() => void moveManual(l, -1)}><CaretUpIcon size={14} /></button>
                    <button className="icon-btn" title="Down" onClick={() => void moveManual(l, 1)}><CaretDownIcon size={14} /></button>
                  </>}
                  <button className="btn ghost small" onClick={() => setEditing({
                    id: l.id, name: l.name, color: l.color, description: l.description, parentId: l.parentId ?? null,
                    sidebarVisibility: l.sidebarVisibility ?? 'always', retentionDays: l.retentionDays ?? null,
                    keepDefault: !!l.keepDefault, protected: !!l.protected, autoMarkRead: !!l.autoMarkRead,
                  })}>Edit</button>
                </td>
              </tr>
            ))}
            {labels.length === 0 && <tr><td colSpan={6} className="dim">No labels yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <h3>Sidebar</h3>
      <SidebarLayout />
    </div>
  );
}
