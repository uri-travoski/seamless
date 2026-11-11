/** Leads (T5.4 F-38): table with filters + inline status, detail drawer, and a Stats tab. Filters live in the URL. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { navigate } from '../router.ts';
import { toast } from '../toast.ts';
import { useCompose } from '../state/compose.ts';
import { useMail } from '../state/mail.ts';
import { NO_AUTOFILL } from '../state/ui.ts';

const STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost', 'spam'] as const;
export interface Lead {
  id: number; businessId: number | null; businessName: string | null; messageId: string | null; source: string; name: string | null; email: string | null;
  phone: string | null; suburb: string | null; service: string | null; details: string | null; fields: Record<string, unknown>; status: string;
  repeatCount: number; firstReplyAt: number | null; createdAt: number;
}
interface Stat { businessId: number | null; businessName: string | null; source: string; month: string; count: number; won: number; wonPct: number; medianFirstReplyMs: number | null; replied: number }
interface Biz { id: number; name: string }

const when = (ms: number) => new Date(ms).toLocaleString('en-AU', { timeZone: 'Australia/Perth', dateStyle: 'short', timeStyle: 'short' });
export function duration(ms: number | null): string {
  if (ms == null) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 1) return '< 1 min';
  if (m < 90) return `${m} min`;
  const h = ms / 3_600_000;
  return h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`;
}
const DAY = 86_400_000;

async function reply(lead: Lead) {
  try {
    const d = await api.get<{ to: { name: string; email: string }[]; subject: string; identityId: number | null; accountId: number | null }>(`/api/leads/${lead.id}/reply`);
    await useCompose.getState().openLead(d);
  } catch (e: any) { toast(e?.message ?? 'Could not start a reply', 'error'); }
}

function Drawer({ lead, onClose, onChange }: { lead: Lead; onClose: () => void; onChange: (l: Lead) => void }) {
  const extra = Object.entries(lead.fields ?? {});
  const setStatus = (status: string) => api.patch<Lead>(`/api/leads/${lead.id}`, { status }).then(onChange, (e) => toast(e?.message ?? 'Failed', 'error'));
  return (
    <aside className="lead-drawer" aria-label="Lead details">
      <div className="page-head">
        <h2 className="page-title">{lead.name || lead.email || 'Lead'}</h2>
        {lead.repeatCount > 0 && <span className="chip-choice on" title="Same email or phone enquired again within 30 days">Repeat enquiry ×{lead.repeatCount}</span>}
        <span className="grow" />
        <button className="btn ghost" onClick={onClose} aria-label="Close">Close</button>
      </div>
      <dl className="lead-dl">
        <dt>Business</dt><dd>{lead.businessName ?? '—'}</dd>
        <dt>Source</dt><dd>{lead.source}</dd>
        <dt>Received</dt><dd>{when(lead.createdAt)}</dd>
        <dt>Email</dt><dd>{lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : '—'}</dd>
        <dt>Phone</dt><dd>{lead.phone ? <a href={`tel:${lead.phone}`}>{lead.phone}</a> : '—'}</dd>
        <dt>Suburb</dt><dd>{lead.suburb ?? '—'}</dd>
        <dt>Service</dt><dd>{lead.service ?? '—'}</dd>
        <dt>First reply</dt><dd>{lead.firstReplyAt ? `${when(lead.firstReplyAt)} (${duration(lead.firstReplyAt - lead.createdAt)} after the enquiry)` : 'Not yet'}</dd>
        {extra.map(([k, v]) => <><dt key={`k${k}`}>{k}</dt><dd key={`v${k}`}>{typeof v === 'string' ? v : JSON.stringify(v)}</dd></>)}
      </dl>
      {lead.details && <><h3>Message</h3><p className="lead-details">{lead.details}</p></>}
      <div className="modal-actions">
        <select className="text-input compact" value={lead.status} onChange={(e) => void setStatus(e.target.value)} aria-label="Status">
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button className="btn primary" disabled={!lead.email} onClick={() => void reply(lead)}>Reply</button>
        {lead.messageId && <button className="btn" onClick={() => navigate(`/mail/msg/${lead.messageId}`)}>Open the form email</button>}
      </div>
    </aside>
  );
}

function Stats() {
  const [rows, setRows] = useState<Stat[] | null>(null);
  useEffect(() => { api.get<{ items: Stat[] }>('/api/leads/stats?months=12').then((r) => setRows(r.items), () => setRows([])); }, []);
  if (!rows) return <p className="dim">Loading…</p>;
  if (rows.length === 0) return <p className="dim">No leads in the last 12 months yet.</p>;
  return (
    <table className="tbl">
      <thead><tr><th>Month</th><th>Business</th><th>Source</th><th>Leads</th><th>Won</th><th>Won %</th><th>Median first reply</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.month}|${r.businessId}|${r.source}`}>
            <td>{r.month}</td><td>{r.businessName ?? '—'}</td><td>{r.source}</td><td>{r.count}</td><td>{r.won}</td><td>{r.wonPct}%</td>
            <td title={`${r.replied} of ${r.count} replied to`}>{duration(r.medianFirstReplyMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function LeadsPage({ params }: { params: Record<string, string> }) {
  const [data, setData] = useState<{ items: Lead[]; total: number; services: string[] } | null>(null);
  const [biz, setBiz] = useState<Biz[]>([]);
  const [text, setText] = useState(params.q ?? '');
  const tab = params.tab === 'stats' ? 'stats' : 'list';
  const selected = data?.items.find((l) => String(l.id) === params.lead) ?? null;
  const overview = useMail((s) => s.overview);
  const set = (patch: Record<string, string | undefined>) => {
    const next: Record<string, string> = { ...params };
    for (const [k, v] of Object.entries(patch)) { if (!v) delete next[k]; else next[k] = v; }
    navigate({ page: 'leads', params: next }, { replace: true });
  };
  useEffect(() => { api.get<Biz[]>('/api/businesses').then(setBiz, () => {}); }, []);

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    for (const k of ['business', 'status', 'service', 'q']) if (params[k]) qs.set(k, params[k]);
    const now = Date.now();
    if (params.range === '7d') qs.set('from', String(now - 7 * DAY));
    if (params.range === '30d') qs.set('from', String(now - 30 * DAY));
    if (params.range === '90d') qs.set('from', String(now - 90 * DAY));
    return api.get<{ items: Lead[]; total: number; services: string[] }>(`/api/leads?${qs}`).then(setData, () => setData({ items: [], total: 0, services: [] }));
  }, [params.business, params.status, params.service, params.q, params.range]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load, overview]);
  useEffect(() => { const t = setTimeout(() => { if ((params.q ?? '') !== text) set({ q: text || undefined }); }, 300); return () => clearTimeout(t); }, [text]);   // eslint-disable-line react-hooks/exhaustive-deps

  const changeStatus = async (l: Lead, status: string) => {
    try { await api.patch<Lead>(`/api/leads/${l.id}`, { status }); void load(); } catch (e: any) { toast(e?.message ?? 'Failed', 'error'); }
  };

  return (
    <section className="page leads-page">
      <div className="page-head">
        <h1 className="page-title">Leads</h1>
        <span className="page-sub">{data ? `${data.total} lead${data.total === 1 ? '' : 's'}` : ''}</span>
        <span className="grow" />
        <div className="seg" role="group" aria-label="View">
          <button className={`seg-btn ${tab === 'list' ? 'on' : ''}`} onClick={() => set({ tab: undefined })}>Leads</button>
          <button className={`seg-btn ${tab === 'stats' ? 'on' : ''}`} onClick={() => set({ tab: 'stats', lead: undefined })}>Stats</button>
        </div>
        <button className="btn ghost" onClick={() => navigate({ page: 'settings', tab: 'leads' })}>Lead sources</button>
      </div>
      {tab === 'stats' ? <Stats /> : (
        <>
          <div className="filter-bar">
            <select className="text-input compact" value={params.business ?? ''} onChange={(e) => set({ business: e.target.value })} aria-label="Business">
              <option value="">All businesses</option>{biz.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}<option value="none">No business</option>
            </select>
            <select className="text-input compact" value={params.status ?? ''} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
              <option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="text-input compact" value={params.service ?? ''} onChange={(e) => set({ service: e.target.value })} aria-label="Service">
              <option value="">Any service</option>{(data?.services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="text-input compact" value={params.range ?? ''} onChange={(e) => set({ range: e.target.value })} aria-label="Date">
              <option value="">Any time</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option>
            </select>
            <input className="text-input compact grow" type="search" name="seamless-lead-search" {...NO_AUTOFILL} placeholder="Search leads" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="leads-layout">
            <div className="leads-table-wrap">
              {data && data.items.length === 0 ? (
                <p className="dim">No leads yet. Add a lead source in Settings → Leads and form emails that match it will show up here.</p>
              ) : (
                <table className="tbl">
                  <thead><tr><th>Received</th><th>Name</th><th>Contact</th><th>Service</th><th>Business</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {(data?.items ?? []).map((l) => (
                      <tr key={l.id} className={String(l.id) === params.lead ? 'selected' : ''} onClick={() => set({ lead: String(l.id) })} style={{ cursor: 'pointer' }}>
                        <td>{when(l.createdAt)}</td>
                        <td>{l.name || '—'} {l.repeatCount > 0 && <span className="chip-choice on" title="Repeat enquiry">repeat ×{l.repeatCount}</span>}</td>
                        <td>{l.email ?? ''}{l.email && l.phone ? <br /> : null}{l.phone ?? ''}</td>
                        <td>{l.service ?? ''}{l.suburb ? <span className="dim"> · {l.suburb}</span> : null}</td>
                        <td>{l.businessName ?? '—'}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <select className="text-input compact" value={l.status} onChange={(e) => void changeStatus(l, e.target.value)} aria-label={`Status for ${l.name || l.email || 'lead'}`}>
                            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </td>
                        <td onClick={(e) => e.stopPropagation()}><button className="btn" disabled={!l.email} onClick={() => void reply(l)}>Reply</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {selected && <Drawer lead={selected} onClose={() => set({ lead: undefined })} onChange={() => void load()} />}
          </div>
        </>
      )}
    </section>
  );
}
