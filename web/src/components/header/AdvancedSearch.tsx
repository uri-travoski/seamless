/** Gmail-style "show search options" panel: builds a search, or turns the same boxes into a filter. */
import { useState } from 'react';
import type { FilterAction, FilterCondition } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { useMail } from '../../state/mail.ts';

const WITHIN = [['', 'Any time'], ['1d', '1 day'], ['3d', '3 days'], ['1w', '1 week'], ['2w', '2 weeks'], ['1m', '1 month'], ['2m', '2 months'], ['6m', '6 months'], ['1y', '1 year']] as const;
const quote = (v: string) => (/\s/.test(v) ? `"${v.replace(/"/g, '')}"` : v);

interface Form { from: string; to: string; subject: string; words: string; sizeOp: '>' | '<'; sizeNum: string; sizeUnit: 'kb' | 'mb'; within: string; hasAttachment: boolean; unread: boolean }
const EMPTY: Form = { from: '', to: '', subject: '', words: '', sizeOp: '>', sizeNum: '', sizeUnit: 'mb', within: '', hasAttachment: false, unread: false };

export function buildQuery(f: Form): string {
  const p: string[] = [];
  if (f.from.trim()) p.push(`from:${quote(f.from.trim())}`);
  if (f.to.trim()) p.push(`to:${quote(f.to.trim())}`);
  if (f.subject.trim()) p.push(`subject:${quote(f.subject.trim())}`);
  if (f.words.trim()) p.push(f.words.trim());
  if (f.hasAttachment) p.push('has:attachment');
  if (f.unread) p.push('is:unread');
  if (Number(f.sizeNum) > 0) p.push(`size${f.sizeOp}${Number(f.sizeNum)}${f.sizeUnit}`);
  if (f.within) p.push(`newer_than:${f.within}`);
  return p.join(' ');
}

/** Conditions for a filter. Size and date can't be filter conditions (a filter runs on arrival), so they are left out. */
export function buildConditions(f: Form): FilterCondition[] {
  const c: FilterCondition[] = [];
  if (f.from.trim()) c.push({ field: 'from', op: 'contains', value: f.from.trim() });
  if (f.to.trim()) c.push({ field: 'to', op: 'contains', value: f.to.trim() });
  if (f.subject.trim()) c.push({ field: 'subject', op: 'contains', value: f.subject.trim() });
  if (f.words.trim()) c.push({ field: 'body', op: 'contains', value: f.words.trim() });
  if (f.hasAttachment) c.push({ field: 'has_attachment', op: 'equals', value: 'yes' });
  return c;
}

export default function AdvancedSearch({ initial, onSearch, onClose }: { initial?: string; onSearch: (q: string) => void; onClose: () => void }) {
  const labels = useMail((s) => s.labels);
  const [f, setF] = useState<Form>({ ...EMPTY, words: initial ?? '' });
  const [step, setStep] = useState<'search' | 'filter'>('search');
  const [skipInbox, setSkipInbox] = useState(false);
  const [markRead, setMarkRead] = useState(false);
  const [star, setStar] = useState(false);
  const [del, setDel] = useState(false);
  const [labelId, setLabelId] = useState('');
  const [applyExisting, setApplyExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const conditions = buildConditions(f);
  const query = buildQuery(f);
  const droppedForFilter = (Number(f.sizeNum) > 0 || !!f.within || f.unread);

  const actions: FilterAction[] = [];
  if (skipInbox) actions.push({ type: 'move', value: 'archive' });
  if (markRead) actions.push({ type: 'markRead' });
  if (star) actions.push({ type: 'star' });
  if (labelId) actions.push({ type: 'label', value: labelId });
  if (del) actions.push({ type: 'delete' });

  const createFilter = async () => {
    setBusy(true);
    try {
      const name = conditions.map((c) => `${c.field}: ${c.value}`).join(' · ').slice(0, 80) || 'New filter';
      const { id } = await api.post<{ id: number }>('/api/filters', { name, conditions, actions, match: 'all', stop: false });
      let n = 0;
      if (applyExisting) n = (await api.post<{ applied: number }>(`/api/filters/${id}/run`)).applied;
      toast(applyExisting ? `Filter created — ${n} existing message${n === 1 ? '' : 's'} in the Inbox updated` : 'Filter created');
      onClose();
    } catch (e: any) { toast(e?.message ?? 'Could not create the filter', 'error'); } finally { setBusy(false); }
  };

  const row = (label: string, el: React.ReactNode) => (<label className="adv-row"><span>{label}</span>{el}</label>);
  const txt = (k: 'from' | 'to' | 'subject' | 'words', ph = '') => (
    <input className="text-input" value={f[k]} placeholder={ph} onChange={(e) => set({ [k]: e.target.value } as any)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (query) onSearch(query); } }} />
  );

  return (
    <div className="adv-search" role="dialog" aria-label="Search options">
      {step === 'search' ? (
        <>
          {row('From', txt('from'))}
          {row('To', txt('to'))}
          {row('Subject', txt('subject'))}
          {row('Has the words', txt('words'))}
          {row('Size', (
            <span className="adv-inline">
              <select className="text-input" value={f.sizeOp} onChange={(e) => set({ sizeOp: e.target.value as any })}><option value=">">greater than</option><option value="<">less than</option></select>
              <input className="text-input" type="number" min={0} style={{ width: 80 }} value={f.sizeNum} onChange={(e) => set({ sizeNum: e.target.value })} />
              <select className="text-input" value={f.sizeUnit} onChange={(e) => set({ sizeUnit: e.target.value as any })}><option value="kb">KB</option><option value="mb">MB</option></select>
            </span>
          ))}
          {row('Date within', <select className="text-input" value={f.within} onChange={(e) => set({ within: e.target.value })}>{WITHIN.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>)}
          <div className="adv-checks">
            <label><input type="checkbox" checked={f.hasAttachment} onChange={(e) => set({ hasAttachment: e.target.checked })} /> Has attachment</label>
            <label><input type="checkbox" checked={f.unread} onChange={(e) => set({ unread: e.target.checked })} /> Unread only</label>
          </div>
          <div className="adv-foot">
            <button className="linklike" onClick={() => setF({ ...EMPTY })}>Reset</button>
            <span style={{ flex: 1 }} />
            <button className="btn ghost" disabled={conditions.length === 0} title={conditions.length === 0 ? 'Fill in at least one box first' : 'Make a filter from these boxes'} onClick={() => setStep('filter')}>Create filter</button>
            <button className="btn primary" disabled={!query} onClick={() => onSearch(query)}>Search</button>
          </div>
        </>
      ) : (
        <>
          <p className="adv-note">When a message <strong>arrives</strong> that matches
            {' '}{conditions.map((c) => `${c.field === 'has_attachment' ? 'has an attachment' : `${c.field} contains “${c.value}”`}`).join(' and ')}, then:</p>
          {droppedForFilter && <p className="adv-warn">Size, date and “unread only” can’t be used in a filter, so they are left out.</p>}
          <div className="adv-checks col">
            <label><input type="checkbox" checked={skipInbox} onChange={(e) => setSkipInbox(e.target.checked)} /> Skip the Inbox (Archive it)</label>
            <label><input type="checkbox" checked={markRead} onChange={(e) => setMarkRead(e.target.checked)} /> Mark it as read</label>
            <label><input type="checkbox" checked={star} onChange={(e) => setStar(e.target.checked)} /> Star it</label>
            <label>Apply the label{' '}
              <select className="text-input" value={labelId} onChange={(e) => setLabelId(e.target.value)}>
                <option value="">Choose label…</option>{labels.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
              </select></label>
            <label><input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} /> Delete it (move to Bin)</label>
            <label><input type="checkbox" checked={applyExisting} onChange={(e) => setApplyExisting(e.target.checked)} /> Also apply to matching mail already in the Inbox</label>
          </div>
          <div className="adv-foot">
            <button className="linklike" onClick={() => setStep('search')}>‹ Back</button>
            <span style={{ flex: 1 }} />
            <button className="btn primary" disabled={busy || actions.length === 0} onClick={() => void createFilter()}>Create filter</button>
          </div>
        </>
      )}
    </div>
  );
}
