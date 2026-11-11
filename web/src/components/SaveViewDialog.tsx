/** "Save this search" / edit a smart view (T4 F-34): name, icon, colour, pin, count, notify. */
import { useState, useEffect } from 'react';
import { useViews, VIEW_ICONS, type ViewDraft } from '../state/views.ts';
import { ViewGlyph } from './viewIcons.tsx';
import { toast } from '../toast.ts';

export default function SaveViewDialog() {
  const editing = useViews((s) => s.editing);
  const [d, setD] = useState<ViewDraft | null>(null);
  useEffect(() => setD(editing), [editing]);
  if (!editing || !d) return null;
  const { save, remove, close } = useViews.getState();
  const set = (p: Partial<ViewDraft>) => setD({ ...d, ...p });
  const submit = async () => {
    if (!d.name.trim() || !d.query.trim()) return;
    try { await save({ ...d, name: d.name.trim(), query: d.query.trim() }); toast(d.id ? 'View updated' : 'Search saved as a smart view'); }
    catch (e: any) { toast(e?.message ?? 'Could not save'); }
  };
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal small" role="dialog" aria-label={d.id ? 'Edit smart view' : 'Save this search'}>
        <div className="modal-title">{d.id ? 'Edit smart view' : 'Save this search'}</div>
        <form className="modal-body" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="field"><label>Name</label>
            <input className="text-input" autoFocus value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Big attachments" /></div>
          <div className="field"><label>Search</label>
            <input className="text-input" value={d.query} onChange={(e) => set({ query: e.target.value })} /></div>
          <div className="field"><label>Icon</label>
            <div className="view-icons">
              {VIEW_ICONS.map((i) => (
                <button type="button" key={i} className={`icon-btn ${d.icon === i ? 'on' : ''}`} aria-label={i} aria-pressed={d.icon === i} onClick={() => set({ icon: i })}>
                  <ViewGlyph icon={i} />
                </button>
              ))}
            </div></div>
          <div className="field"><label>Colour</label>
            <div className="view-colour">
              <input type="color" value={d.color ?? '#5f6368'} onChange={(e) => set({ color: e.target.value })} aria-label="Colour" />
              {d.color && <button type="button" className="btn" onClick={() => set({ color: null })}>No colour</button>}
            </div></div>
          <label className="check"><input type="checkbox" checked={d.pinned} onChange={(e) => set({ pinned: e.target.checked })} /> Show in the sidebar</label>
          <label className="check"><input type="checkbox" checked={d.showCount} onChange={(e) => set({ showCount: e.target.checked })} /> Show how many messages match</label>
          <label className="check"><input type="checkbox" checked={d.notify} onChange={(e) => set({ notify: e.target.checked })} /> Notify me when new mail matches</label>
          <div className="modal-actions">
            {d.id && <button type="button" className="btn danger" onClick={() => void remove(d.id!)}>Delete</button>}
            <span className="spacer" />
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!d.name.trim() || !d.query.trim()}>{d.id ? 'Save' : 'Save view'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
