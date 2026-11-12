/** Settings → Audit log (T6 F-42): who did what. Admins see everyone, members see their own. Append-only on the server. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { useSession } from '../../state/session.ts';

interface Row {
  id: number; actorUserId: number | null; actorEmail: string | null; actorKind: 'user' | 'api_token' | 'system';
  actorTokenId: number | null; action: string; targetType: string | null; targetId: string | null;
  ip: string | null; userAgent: string | null; details: unknown; createdAt: number;
}
interface Listing { items: Row[]; total: number; scope: 'all' | 'own'; retentionDays: number }
interface UserLite { id: number; email: string }

const PAGE = 50;
const TZ = 'Australia/Perth';
const fmt = (ms: number) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(ms));
// the date inputs are calendar days in the user's zone (Perth has no DST: UTC+8)
const dayStart = (d: string) => (d ? Date.parse(`${d}T00:00:00+08:00`) : undefined);
const dayEnd = (d: string) => (d ? Date.parse(`${d}T00:00:00+08:00`) + 86_400_000 : undefined);

export default function AuditSettings() {
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const [listing, setListing] = useState<Listing | null>(null);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [target, setTarget] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [days, setDays] = useState('');
  const [err, setErr] = useState('');

  const qs = useCallback((extra: Record<string, string | number | undefined> = {}) => {
    const p = new URLSearchParams();
    const all: Record<string, string | number | undefined> = {
      actor, action, target, from: dayStart(from), to: dayEnd(to), ...extra,
    };
    for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== '') p.set(k, String(v));
    return p.toString();
  }, [actor, action, target, from, to]);

  const load = useCallback(async () => {
    try {
      setErr('');
      const r = await api.get<Listing>(`/api/audit?${qs({ limit: PAGE, offset: page * PAGE })}`);
      setListing(r); setDays((d) => d || String(r.retentionDays));
    } catch (e: any) { setErr(e?.message ?? 'Could not load the audit log'); }
  }, [qs, page]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (isAdmin) void api.get<UserLite[]>('/api/users').then(setUsers).catch(() => {}); }, [isAdmin]);

  const pages = listing ? Math.max(1, Math.ceil(listing.total / PAGE)) : 1;
  const filtered = () => setPage(0);

  const saveDays = async () => {
    try { await api.put('/api/audit/retention', { days: Number(days) }); await load(); }
    catch (e: any) { setErr(e?.message ?? 'Could not save'); }
  };

  return (
    <div className="audit-settings">
      <h2>Audit log</h2>
      <p className="settings-desc">
        {isAdmin ? 'Every sign-in, security change and sensitive action by anyone on this server.' : 'Your own sign-ins, security changes and sensitive actions.'}
        {' '}Entries can’t be edited or deleted; they are removed automatically after {listing?.retentionDays ?? 730} days.
      </p>

      <div className="audit-filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {isAdmin && (
          <select className="text-input" style={{ width: 170 }} value={actor} aria-label="Actor" onChange={(e) => { setActor(e.target.value); filtered(); }}>
            <option value="">Everyone</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
          </select>
        )}
        <input className="text-input" style={{ width: 150 }} placeholder="Action, e.g. login" aria-label="Action" value={action} onChange={(e) => { setAction(e.target.value); filtered(); }} />
        <input className="text-input" style={{ width: 150 }} placeholder="Target, e.g. account:3" aria-label="Target" value={target} onChange={(e) => { setTarget(e.target.value); filtered(); }} />
        <label className="dim">From <input className="text-input" type="date" value={from} onChange={(e) => { setFrom(e.target.value); filtered(); }} /></label>
        <label className="dim">To <input className="text-input" type="date" value={to} onChange={(e) => { setTo(e.target.value); filtered(); }} /></label>
        <span style={{ flex: 1 }} />
        <a className="btn ghost" href={`/api/audit/export.csv?${qs()}`} download="audit-log.csv" onClick={() => setTimeout(() => void load(), 800)}>Export CSV</a>
      </div>

      {err && <p className="error">{err}</p>}
      <div style={{ overflowX: 'auto', border: '1px solid var(--md-border)', borderRadius: 8, fontSize: 12.5 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--md-text-soft)' }}>
              <th style={{ padding: '6px 10px' }}>When</th>
              {isAdmin && <th style={{ padding: '6px 10px' }}>Who</th>}
              <th style={{ padding: '6px 10px' }}>Action</th>
              <th style={{ padding: '6px 10px' }}>Target</th>
              <th style={{ padding: '6px 10px' }}>IP</th>
            </tr>
          </thead>
          <tbody>
            {listing?.items.map((r) => (
              <FragmentRow key={r.id} r={r} admin={isAdmin} open={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)} />
            ))}
          </tbody>
        </table>
        {listing && listing.items.length === 0 && <p className="dim" style={{ padding: 12, margin: 0 }}>No entries match.</p>}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
        <button className="btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="dim">Page {page + 1} of {pages} · {listing?.total ?? 0} entries</span>
        <button className="btn ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </div>

      {isAdmin && (
        <div style={{ marginTop: 18 }}>
          <h3>Retention</h3>
          <label className="dim">Keep entries for{' '}
            <input className="text-input" type="number" min={1} style={{ width: 90 }} value={days} onChange={(e) => setDays(e.target.value)} /> days
          </label>{' '}
          <button className="btn" onClick={() => void saveDays()}>Save</button>
        </div>
      )}
    </div>
  );
}

function FragmentRow({ r, admin, open, toggle }: { r: Row; admin: boolean; open: boolean; toggle: () => void }) {
  const who = r.actorKind === 'system' ? 'system' : (r.actorEmail ?? `user ${r.actorUserId}`) + (r.actorKind === 'api_token' ? ` (token #${r.actorTokenId})` : '');
  const cell = { padding: '5px 10px', borderTop: '1px solid var(--md-border)', verticalAlign: 'top' } as const;
  return (
    <>
      <tr onClick={toggle} style={{ cursor: 'pointer' }}>
        <td style={{ ...cell, whiteSpace: 'nowrap' }}>{fmt(r.createdAt)}</td>
        {admin && <td style={cell}>{who}</td>}
        <td style={{ ...cell, fontWeight: 600 }}>{r.action}</td>
        <td style={{ ...cell, wordBreak: 'break-word' }}>{r.targetType ? `${r.targetType}${r.targetId ? `:${r.targetId}` : ''}` : r.targetId ?? ''}</td>
        <td style={cell}>{r.ip ?? ''}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={admin ? 5 : 4} style={{ ...cell, background: 'var(--md-surface-2, transparent)' }}>
            <div className="dim" style={{ marginBottom: 4 }}>{r.userAgent ?? 'no user agent'}{!admin && ` · ${who}`}</div>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(r.details, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}
