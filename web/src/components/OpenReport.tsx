/**
 * Open report (T1 F-15, /mail/msg/:id/opens): summary, a timeline, and every open —
 * recipient (per-recipient sends), time (Perth), client, location, proxied flag.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ApiOpenReport } from '@seamless/shared';
import { api } from '../api/client.ts';
import { navigate } from '../router.ts';
import { useMail } from '../state/mail.ts';
import { BackIcon, EyeIcon, RefreshIcon } from '../icons.tsx';

const TZ = 'Australia/Perth';
const fmt = (ms: number | null) => (ms ? new Date(ms).toLocaleString('en-AU', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) : '—');

function Timeline({ report }: { report: ApiOpenReport }) {
  const bars = useMemo(() => {
    const opens = report.opens;
    if (!opens.length) return null;
    const start = Math.min(report.sentAt ?? Infinity, ...opens.map((o) => o.ts));
    const end = Math.max(Date.now(), ...opens.map((o) => o.ts));
    const hourly = end - start <= 2 * 86_400_000;
    const step = hourly ? 3_600_000 : 86_400_000;
    const n = Math.min(60, Math.max(1, Math.ceil((end - start) / step)));
    const first = Math.floor(start / step) * step;
    const buckets = Array.from({ length: n }, (_, i) => ({ at: first + i * step, real: 0, auto: 0 }));
    for (const o of opens) {
      const i = Math.min(n - 1, Math.max(0, Math.floor((o.ts - first) / step)));
      if (o.proxied) buckets[i].auto++; else buckets[i].real++;
    }
    return { buckets, hourly, max: Math.max(1, ...buckets.map((b) => b.real + b.auto)) };
  }, [report]);
  if (!bars) return <div className="dim">No opens yet. They appear here as they happen.</div>;
  const W = 100 / bars.buckets.length;
  return (
    <figure className="timeline" aria-label="Opens over time">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img">
        {bars.buckets.map((b, i) => {
          const hr = (b.real / bars.max) * 36;
          const ha = (b.auto / bars.max) * 36;
          return (
            <g key={i}>
              <title>{`${new Date(b.at).toLocaleString('en-AU', { timeZone: TZ, ...(bars.hourly ? { hour: 'numeric', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short' }) })}: ${b.real} real, ${b.auto} automatic`}</title>
              <rect x={i * W + W * 0.15} width={W * 0.7} y={40 - hr} height={hr} className="bar-real" />
              <rect x={i * W + W * 0.15} width={W * 0.7} y={40 - hr - ha} height={ha} className="bar-auto" />
            </g>
          );
        })}
      </svg>
      <figcaption className="dim">
        <span className="legend real" /> real opens <span className="legend auto" /> probable automatic · per {bars.hourly ? 'hour' : 'day'}
      </figcaption>
    </figure>
  );
}

export default function OpenReport({ emailId }: { emailId: string }) {
  const [report, setReport] = useState<ApiOpenReport | null>(null);
  const [error, setError] = useState('');
  const [showAuto, setShowAuto] = useState(true);

  const load = async () => {
    try { setReport(await api.get<ApiOpenReport>(`/api/message/${emailId}/opens`)); setError(''); }
    catch (e: any) { setError(e?.message === 'not tracked' ? 'This message was sent without open tracking.' : (e?.message ?? 'Could not load the report')); }
  };
  useEffect(() => { void load(); }, [emailId]); // eslint-disable-line react-hooks/exhaustive-deps

  // live updates while the page is open
  const state = useMail((s) => s.mailboxes);
  useEffect(() => { void load(); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const back = () => (history.length > 1 ? history.back() : navigate({ page: 'mail', scope: 'unified', folder: 'sent' }));
  const opens = (report?.opens ?? []).filter((o) => showAuto || !o.proxied);

  return (
    <section className="page open-report">
      <div className="page-head">
        <button className="icon-btn" title="Back" onClick={back}><BackIcon /></button>
        <h1 className="page-title"><EyeIcon size={20} /> Open report</h1>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" title="Refresh" onClick={() => void load()}><RefreshIcon /></button>
        <button className="btn ghost" onClick={() => navigate(`/mail/msg/${emailId}`)}>View message</button>
      </div>
      {error && <div className="banner error">{error}</div>}
      {report && (
        <>
          <div className="report-subject">
            <strong>{report.subject || '(no subject)'}</strong>
            <span className="dim"> · sent {fmt(report.sentAt)} to {report.to.map((a) => a.name || a.email).join(', ') || '—'}</span>
          </div>
          <div className="stat-row">
            <div className="stat"><span className="stat-num">{report.summary.real}</span><span className="stat-label">Real opens</span></div>
            <div className="stat"><span className="stat-num">{report.summary.total}</span><span className="stat-label">All opens</span></div>
            <div className="stat"><span className="stat-num">{report.summary.uniqueDevices}</span><span className="stat-label">Devices</span></div>
            <div className="stat"><span className="stat-num small">{fmt(report.summary.firstAt)}</span><span className="stat-label">First open</span></div>
            <div className="stat"><span className="stat-num small">{fmt(report.summary.lastAt)}</span><span className="stat-label">Last open</span></div>
          </div>
          <Timeline report={report} />
          <div className="report-table-head">
            <h3>Every open</h3>
            <label className="checkbox-line"><input type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} /> Show probable automatic opens</label>
          </div>
          <div className="table-scroll">
            <table className="tbl">
              <thead><tr>
                {report.perRecipient && <th>Recipient</th>}
                <th>When (Perth)</th><th>Client</th><th>Location</th><th>IP</th><th>Kind</th>
              </tr></thead>
              <tbody>
                {opens.length === 0 && <tr><td colSpan={6} className="dim">No opens yet.</td></tr>}
                {opens.map((o, i) => (
                  <tr key={i} className={o.proxied ? 'muted-row' : ''}>
                    {report.perRecipient && <td>{o.recipient ?? '—'}</td>}
                    <td>{fmt(o.ts)}</td>
                    <td>{o.client}</td>
                    <td>{o.country ?? '—'}</td>
                    <td className="mono">{o.ip || '—'}</td>
                    <td>{o.proxied ? <span className="tag muted" title="Mail privacy proxy or security scanner, not a person">automatic</span> : <span className="tag ok">real</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">Apple Mail Privacy Protection, Gmail's image proxy and corporate scanners fetch the pixel without a person reading the message; those are kept out of the real-open count.</p>
        </>
      )}
    </section>
  );
}
