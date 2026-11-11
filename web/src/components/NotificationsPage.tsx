/**
 * Notifications page (T1 F-14): sticky filters (read state, types, mailbox/category,
 * date range, text), paginated list with 25/50/100 per page and the total, multi-select
 * mark read/unread/delete. Filters live in the URL so a view can be bookmarked.
 */
import { useEffect, useMemo, useState } from 'react';
import { NOTIFICATION_GROUPS, type ApiNotificationPage } from '@seamless/shared';
import { api } from '../api/client.ts';
import { navigate } from '../router.ts';
import { useMail } from '../state/mail.ts';
import { useNotifs } from '../state/notifications.ts';
import { NotifRow, openNotification } from './header/NotificationBell.tsx';
import { toast } from '../toast.ts';
import { NO_AUTOFILL } from '../state/ui.ts';
import { ChecksIcon, EnvelopeIcon, TrashIcon, SettingsIcon, CaretLeftIcon, CaretRightIcon } from '../icons.tsx';

const DAY = 86_400_000;
const PRESETS: [string, string][] = [['', 'Any time'], ['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['custom', 'Custom…']];

function rangeFor(p: Record<string, string>): { from?: number; to?: number } {
  const now = Date.now();
  if (p.range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return { from: d.getTime() }; }
  if (p.range === '7d') return { from: now - 7 * DAY };
  if (p.range === '30d') return { from: now - 30 * DAY };
  if (p.range === 'custom') {
    return {
      from: p.from ? new Date(`${p.from}T00:00:00`).getTime() : undefined,
      to: p.to ? new Date(`${p.to}T23:59:59.999`).getTime() : undefined,
    };
  }
  return {};
}

export default function NotificationsPage({ params }: { params: Record<string, string> }) {
  const overview = useMail((s) => s.overview);
  const [data, setData] = useState<ApiNotificationPage | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [text, setText] = useState(params.q ?? '');
  const [loading, setLoading] = useState(false);

  const status = params.status ?? 'all';
  const groups = (params.types ?? '').split(',').filter(Boolean);
  const per = [25, 50, 100].includes(Number(params.per)) ? Number(params.per) : 25;
  const page = Math.max(1, Number(params.page) || 1);
  const set = (patch: Record<string, string | undefined>, keepPage = false) => {
    const next: Record<string, string> = { ...params };
    for (const [k, v] of Object.entries(patch)) { if (v === undefined || v === '') delete next[k]; else next[k] = v; }
    if (!keepPage) delete next.page;
    navigate({ page: 'notifications', params: next }, { replace: true });
  };

  const query = useMemo(() => {
    const types = groups.flatMap((g) => NOTIFICATION_GROUPS.find((x) => x.id === g)?.types ?? []);
    const { from, to } = rangeFor(params);
    const qs = new URLSearchParams();
    qs.set('status', status);
    if (types.length) qs.set('types', types.join(','));
    if (from) qs.set('from', String(from));
    if (to) qs.set('to', String(to));
    if (params.mailbox?.startsWith('account:')) qs.set('accountId', params.mailbox.slice(8));
    if (params.mailbox?.startsWith('category:')) qs.set('categoryId', params.mailbox.slice(9));
    if (params.q) qs.set('q', params.q);
    qs.set('limit', String(per));
    qs.set('offset', String((page - 1) * per));
    return qs.toString();
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    setLoading(true);
    try { setData(await api.get<ApiNotificationPage>(`/api/notifications?${query}`)); } catch { toast('Could not load notifications', 'error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); setChecked(new Set()); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  // live: the bell's store changes on every WS "notifications" message
  const unread = useNotifs((s) => s.unread);
  useEffect(() => { void load(); }, [unread]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(() => { if (text !== (params.q ?? '')) set({ q: text }); }, 350);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const bulk = async (op: 'read' | 'unread' | 'delete') => {
    const ids = [...checked];
    if (!ids.length) return;
    if (op === 'delete') await api.post('/api/notifications/delete', { ids });
    else await api.post(`/api/notifications/${op}`, { ids });
    setChecked(new Set());
    await load();
    void useNotifs.getState().refresh();
  };

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / per));
  const items = data?.items ?? [];
  const allChecked = items.length > 0 && items.every((n) => checked.has(n.id));
  const firstIdx = total ? (page - 1) * per + 1 : 0;
  const lastIdx = Math.min(total, page * per);

  return (
    <section className="page notif-page">
      <div className="page-head">
        <h1 className="page-title">Notifications</h1>
        <span className="page-sub">{data ? `${data.unread} unread` : ''}</span>
        <div style={{ flex: 1 }} />
        <button className="btn" disabled={!data?.unread} onClick={async () => { await useNotifs.getState().markRead('all'); await load(); }}><ChecksIcon size={15} /> Mark all read</button>
        <button className="btn ghost" onClick={() => navigate({ page: 'settings', tab: 'notifications' })}><SettingsIcon size={15} /> Settings</button>
      </div>

      <div className="filter-bar">
        <div className="seg" role="group" aria-label="Read status">
          {(['all', 'unread', 'read'] as const).map((s) => (
            <button key={s} className={`seg-btn ${status === s ? 'on' : ''}`} onClick={() => set({ status: s === 'all' ? undefined : s })}>{s[0].toUpperCase() + s.slice(1)}</button>
          ))}
        </div>
        <select className="text-input compact" value={params.mailbox ?? ''} onChange={(e) => set({ mailbox: e.target.value })} aria-label="Mailbox or category">
          <option value="">All mailboxes</option>
          {overview?.categories.length ? <optgroup label="Categories">
            {overview.categories.map((c) => <option key={c.id} value={`category:${c.id}`}>{c.name}</option>)}
          </optgroup> : null}
          {overview?.mailboxes.length ? <optgroup label="Mailboxes">
            {overview.mailboxes.map((m) => <option key={m.id} value={`account:${m.id}`}>{m.name || m.email}</option>)}
          </optgroup> : null}
        </select>
        <select className="text-input compact" value={params.range ?? ''} onChange={(e) => set({ range: e.target.value, from: undefined, to: undefined })} aria-label="Date range">
          {PRESETS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        </select>
        {params.range === 'custom' && (
          <span className="date-range">
            <input type="date" className="text-input compact" value={params.from ?? ''} onChange={(e) => set({ from: e.target.value })} aria-label="From" />
            <span>–</span>
            <input type="date" className="text-input compact" value={params.to ?? ''} onChange={(e) => set({ to: e.target.value })} aria-label="To" />
          </span>
        )}
        <input className="text-input compact grow" type="search" name="seamless-notification-search" {...NO_AUTOFILL} placeholder="Search notifications" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="type-chips" role="group" aria-label="Types">
        {NOTIFICATION_GROUPS.map((g) => {
          const on = groups.includes(g.id);
          return (
            <button key={g.id} className={`chip-choice ${on ? 'on' : ''}`}
              onClick={() => set({ types: (on ? groups.filter((x) => x !== g.id) : [...groups, g.id]).join(',') })}>{g.name}</button>
          );
        })}
        {groups.length > 0 && <button className="linklike" onClick={() => set({ types: undefined })}>Clear types</button>}
      </div>

      <div className="notif-table">
        <div className="notif-table-head">
          <input type="checkbox" className="row-check" checked={allChecked} aria-label="Select all on this page"
            onChange={(e) => setChecked(e.target.checked ? new Set(items.map((n) => n.id)) : new Set())} />
          {checked.size > 0 ? (
            <>
              <span className="bulk-count">{checked.size} selected</span>
              <button className="btn ghost small" onClick={() => void bulk('read')}><ChecksIcon size={14} /> Mark read</button>
              <button className="btn ghost small" onClick={() => void bulk('unread')}><EnvelopeIcon size={14} /> Mark unread</button>
              <button className="btn ghost small danger" onClick={() => void bulk('delete')}><TrashIcon size={14} /> Delete</button>
            </>
          ) : (
            <span className="dim">{loading ? 'Loading…' : total ? `${firstIdx}–${lastIdx} of ${total.toLocaleString()}` : 'No notifications match these filters.'}</span>
          )}
        </div>
        {items.map((n) => (
          <div key={n.id} className="notif-line">
            <input type="checkbox" className="row-check" checked={checked.has(n.id)} aria-label="Select"
              onChange={(e) => { const s = new Set(checked); if (e.target.checked) s.add(n.id); else s.delete(n.id); setChecked(s); }} />
            <NotifRow n={n} onOpen={() => openNotification(n)} />
            <span className="notif-date">{new Date(n.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
          </div>
        ))}
      </div>

      <div className="pager">
        <label className="dim">Per page{' '}
          <select className="text-input compact" value={per} onChange={(e) => set({ per: e.target.value })}>
            {[25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" disabled={page <= 1} onClick={() => set({ page: String(page - 1) }, true)} aria-label="Previous page"><CaretLeftIcon /></button>
        {Array.from({ length: pages }, (_, i) => i + 1)
          .filter((p) => p === 1 || p === pages || Math.abs(p - page) <= 2)
          .map((p, i, arr) => (
            <span key={p}>
              {i > 0 && arr[i - 1] !== p - 1 && <span className="dim"> … </span>}
              <button className={`page-btn ${p === page ? 'on' : ''}`} onClick={() => set({ page: String(p) }, true)}>{p}</button>
            </span>
          ))}
        <button className="icon-btn" disabled={page >= pages} onClick={() => set({ page: String(page + 1) }, true)} aria-label="Next page"><CaretRightIcon /></button>
      </div>
    </section>
  );
}
