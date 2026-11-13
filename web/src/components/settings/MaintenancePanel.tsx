/** Settings → Storage → Database maintenance (T10.3, admin): automatic cleanups, previews, manual buttons and the log. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { formatBytes } from '../Sidebar.tsx';

interface Log {
  id: number; task: string; trigger: 'auto' | 'manual'; userName: string | null; dryRun: boolean; status: 'ok' | 'failed' | 'skipped';
  rowsRemoved: number; bytesFreed: number; durationMs: number; details: any; error: string | null; startedAt: number;
}
interface Task {
  id: string; name: string; removes: string; scheduleText: string; manualOnly: boolean; safe: boolean; retentionLabel: string | null;
  enabled: boolean; intervalHours: number; retentionDays: number | null; autoDelete: boolean; lastRun: Log | null; nextRunAt: number | null;
}
interface Overview {
  database: { sizeBytes: number; tables: { name: string; sizeBytes: number; rows: number; deadPct: number }[]; fullVacuumOffered: string[] };
  tasks: Task[]; bloatedIndexes: { name: string; table: string; sizeBytes: number; bloatPct: number }[]; fullVacuumTables: { name: string; deadPct: number }[];
}
interface Orphans { found: number; scanned: number; items: { kind: string; key: string; size: number }[]; truncated: boolean }

const INTERVALS: [number, string][] = [[6, 'every 6 hours'], [24, 'daily'], [168, 'weekly'], [720, 'monthly'], [2160, 'quarterly']];
const when = (t: number | null | undefined) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const summary = (l: Log | null) => (!l ? 'never' : l.status === 'ok' ? `${when(l.startedAt)} · ${l.rowsRemoved.toLocaleString()} rows${l.bytesFreed ? ` · ${formatBytes(l.bytesFreed)}` : ''}` : `${when(l.startedAt)} · ${l.status}${l.error ? `: ${l.error}` : ''}`);
const cell = { padding: '6px 10px', verticalAlign: 'top' } as const;

export default function MaintenancePanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [note, setNote] = useState<Record<string, string>>({});
  const [orphans, setOrphans] = useState<Orphans | null>(null);
  const [log, setLog] = useState<{ items: Log[]; total: number } | null>(null);
  const [f, setF] = useState({ task: '', trigger: '', status: '', from: '', to: '' });
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    try { setData(await api.get<Overview>('/api/maintenance')); } catch (e: any) { toast(e?.message ?? 'Could not load maintenance', 'error'); }
  }, []);
  const logQs = useCallback((extra = '') => {
    const p = new URLSearchParams();
    if (f.task) p.set('task', f.task); if (f.trigger) p.set('trigger', f.trigger); if (f.status) p.set('status', f.status);
    if (f.from) p.set('from', String(new Date(f.from).getTime())); if (f.to) p.set('to', String(new Date(f.to).getTime() + 86_399_999));
    return p.toString() + extra;
  }, [f]);
  const loadLog = useCallback(async () => {
    try { setLog(await api.get(`/api/maintenance/log?${logQs(`&limit=20&offset=${page * 20}`)}`)); } catch { /* shown empty */ }
  }, [logQs, page]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadLog(); }, [loadLog]);

  if (!data) return <section className="settings-section" id="database-maintenance" style={{ marginTop: 28 }}><h3 style={{ fontSize: 16 }}>Database maintenance</h3><p className="dim">Loading…</p></section>;

  const refresh = async () => { await load(); await loadLog(); };
  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); await refresh(); } catch (e: any) { toast(e?.message ?? 'That did not work', 'error'); }
    setBusy('');
  };
  const line = (l: Log) => (l.status === 'skipped' ? `Skipped: ${l.error ?? 'busy'}` : l.status === 'failed' ? `Failed: ${l.error}` : `${l.dryRun ? 'Would remove' : 'Removed'} ${l.rowsRemoved.toLocaleString()} rows${l.bytesFreed ? ` (about ${formatBytes(l.bytesFreed)})` : ''}`);
  const preview = (t: Task) => act(`p:${t.id}`, async () => { const l = await api.post<Log>(`/api/maintenance/tasks/${t.id}/preview`, {}); setNote((n) => ({ ...n, [t.id]: `Preview — ${line(l)}` })); });
  const runNow = (t: Task, body: object = {}) => act(`r:${t.id}`, async () => { const l = await api.post<Log>(`/api/maintenance/tasks/${t.id}/run`, body); setNote((n) => ({ ...n, [t.id]: line(l) })); toast(line(l), l.status === 'ok' ? undefined : 'error'); });
  const save = (t: Task, patch: object) => act(`s:${t.id}`, async () => { await api.put(`/api/maintenance/tasks/${t.id}`, patch); });
  const task = (id: string) => data.tasks.find((t) => t.id === id)!;

  const runAll = () => act('all', async () => {
    const r = await api.post<{ rows: number; bytes: number; results: Log[] }>('/api/maintenance/run-safe', {});
    const bad = r.results.filter((l) => l.status !== 'ok').length;
    toast(`Cleanups finished: ${r.rows.toLocaleString()} rows removed${bad ? `, ${bad} skipped or failed (see the log)` : ''}`);
  });
  const findOrphans = () => act('orphans', async () => {
    const l = await api.post<Log>('/api/maintenance/tasks/orphan_files/preview', {});
    if (l.status !== 'ok') throw new Error(l.error ?? 'Could not scan');
    setOrphans({ found: l.details.found, scanned: l.details.scanned, items: l.details.items, truncated: l.details.truncated });
  });
  const deleteOrphans = () => act('orphans-del', async () => {
    if (!orphans || !window.confirm(`Delete ${orphans.found.toLocaleString()} unreferenced file(s)? This cannot be undone.`)) return;
    const l = await api.post<Log>('/api/maintenance/tasks/orphan_files/run', { confirm: true, keys: orphans.truncated ? undefined : orphans.items.map((i) => i.key) });
    toast(l.status === 'ok' ? `Deleted ${l.rowsRemoved} file(s), ${formatBytes(l.bytesFreed)}` : (l.error ?? 'Not deleted'), l.status === 'ok' ? undefined : 'error');
    setOrphans(null);
  });
  const full = data.fullVacuumTables;
  const vacuumFull = () => act('full', async () => {
    const list = full.map((t) => t.name);
    if (!window.confirm('VACUUM FULL rewrites tables and locks each one while it runs. Mail will be unavailable for those seconds or minutes. Do this at a quiet time. Continue?')) return;
    const l = await api.post<Log>('/api/maintenance/tasks/vacuum_full/run', { confirm: true, tables: list.length ? list : undefined });
    toast(line(l), l.status === 'ok' ? undefined : 'error');
  });
  const pages = Math.max(1, Math.ceil((log?.total ?? 0) / 20));

  return (
    <section className="settings-section" id="database-maintenance" style={{ marginTop: 28 }}>
      <h3 style={{ fontSize: 16 }}>Database maintenance</h3>
      <p className="settings-desc">
        Seamless cleans up after itself: old logs, finished jobs, expired tokens and orphaned rows. Nothing here ever touches your mail, contacts, labels or rules.
        Each task runs on its schedule; <strong>Preview</strong> shows what it would remove without removing anything.
      </p>

      <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Database size: {formatBytes(data.database.sizeBytes)}</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--md-text-soft)' }}><th style={cell}>Biggest tables</th><th style={cell}>Size</th><th style={cell}>Rows</th><th style={cell}>Dead rows</th></tr></thead>
          <tbody>{data.database.tables.map((t) => (
            <tr key={t.name}><td style={cell}>{t.name}</td><td style={cell}>{formatBytes(t.sizeBytes)}</td><td style={cell}>{t.rows.toLocaleString()}</td><td style={cell}>{t.deadPct}%</td></tr>
          ))}</tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn" disabled={!!busy} onClick={() => void runAll()}>{busy === 'all' ? 'Running…' : 'Run all safe cleanups'}</button>
        <button className="btn ghost" disabled={!!busy} onClick={() => void runNow(task('analyze'))}>Analyze now</button>
        <button className="btn ghost" disabled={!!busy} onClick={() => void runNow(task('vacuum'))}>Vacuum now</button>
        <button className="btn ghost" disabled={!!busy} onClick={() => void findOrphans()}>Find orphaned files</button>
        <button className="btn ghost" disabled={!!busy} onClick={() => void runNow(task('reindex'))} title={data.bloatedIndexes.length ? `${data.bloatedIndexes.length} index(es) over 40% bloat` : 'No index is bloated'}>Rebuild bloated indexes{data.bloatedIndexes.length ? ` (${data.bloatedIndexes.length})` : ''}</button>
        <button className="btn ghost" disabled={!!busy} onClick={() => void vacuumFull()} style={full.length ? { borderColor: 'var(--md-danger, currentColor)' } : undefined}>Reclaim disk (VACUUM FULL){full.length ? ` — ${full.length} table(s) over 30% bloat` : ''}</button>
      </div>
      <p className="dim" style={{ fontSize: 12, marginTop: -4 }}>Reclaim disk locks each table while it rewrites it. It only runs when you press the button, ideally at a quiet time.</p>

      {orphans && (
        <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>{orphans.found === 0 ? `No orphaned files (${orphans.scanned.toLocaleString()} checked).` : `${orphans.found.toLocaleString()} file(s) that no message references, older than 7 days (${formatBytes(orphans.items.reduce((s, i) => s + i.size, 0))}${orphans.truncated ? '+' : ''}):`}</div>
          {orphans.found > 0 && <ul style={{ maxHeight: 180, overflow: 'auto', fontSize: 12, margin: '6px 0' }}>{orphans.items.slice(0, 100).map((i) => <li key={i.key}>{i.key} <span className="dim">{formatBytes(i.size)}</span></li>)}</ul>}
          <div style={{ display: 'flex', gap: 8 }}>
            {orphans.found > 0 && <button className="btn" disabled={!!busy} onClick={() => void deleteOrphans()}>Delete these</button>}
            <button className="btn ghost" onClick={() => setOrphans(null)}>Close</button>
          </div>
        </div>
      )}

      <div style={{ overflowX: 'auto', border: '1px solid var(--md-border)', borderRadius: 8, fontSize: 12.5 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--md-text-soft)' }}>
            <th style={cell}>Task</th><th style={cell}>Schedule</th><th style={cell}>Keep</th><th style={cell}>Last run</th><th style={cell}>Next run</th><th style={cell} />
          </tr></thead>
          <tbody>{data.tasks.map((t) => (
            <tr key={t.id} style={{ borderTop: '1px solid var(--md-border)' }}>
              <td style={cell}><strong>{t.name}</strong><div className="dim">{t.removes}</div>{note[t.id] && <div style={{ marginTop: 4 }}>{note[t.id]}</div>}</td>
              <td style={cell}>
                {t.manualOnly ? <span className="dim">manual only</span> : (
                  <>
                    <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={t.enabled} aria-label={`${t.name} enabled`} onChange={(e) => void save(t, { enabled: e.target.checked })} /> on</label>
                    <select className="text-input" aria-label={`${t.name} schedule`} value={t.intervalHours} onChange={(e) => void save(t, { intervalHours: Number(e.target.value) })}>
                      {!INTERVALS.some(([h]) => h === t.intervalHours) && <option value={t.intervalHours}>every {t.intervalHours} h</option>}
                      {INTERVALS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}
                    </select>
                  </>
                )}
              </td>
              <td style={cell}>
                {t.retentionDays != null ? (
                  <input className="text-input" type="number" min={1} style={{ width: 70 }} aria-label={`${t.name} days`} defaultValue={t.retentionDays}
                    onBlur={(e) => { const v = Number(e.target.value); if (v >= 1 && v !== t.retentionDays) void save(t, { retentionDays: v }); }} />
                ) : <span className="dim">—</span>}
                {t.retentionLabel && <div className="dim">{t.retentionLabel}</div>}
                {t.id === 'orphan_files' && <label style={{ display: 'flex', gap: 4, marginTop: 4 }}><input type="checkbox" checked={t.autoDelete} onChange={(e) => void save(t, { autoDelete: e.target.checked })} /> delete automatically</label>}
              </td>
              <td style={cell}>{summary(t.lastRun)}</td>
              <td style={cell}>{t.manualOnly ? '—' : t.enabled ? when(t.nextRunAt) : 'off'}</td>
              <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                <button className="btn ghost" disabled={!!busy} onClick={() => void preview(t)}>Preview</button>{' '}
                {t.id !== 'orphan_files' && t.id !== 'vacuum_full' && <button className="btn ghost" disabled={!!busy} onClick={() => void runNow(t)}>Run now</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      <h4 style={{ margin: '18px 0 6px' }}>Maintenance log</h4>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        <select className="text-input" aria-label="Task" value={f.task} onChange={(e) => { setF({ ...f, task: e.target.value }); setPage(0); }}>
          <option value="">All tasks</option>{data.tasks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select className="text-input" aria-label="Auto or manual" value={f.trigger} onChange={(e) => { setF({ ...f, trigger: e.target.value }); setPage(0); }}>
          <option value="">Auto + manual</option><option value="auto">Automatic</option><option value="manual">Manual</option>
        </select>
        <select className="text-input" aria-label="Status" value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setPage(0); }}>
          <option value="">Any status</option><option value="ok">OK</option><option value="failed">Failed</option><option value="skipped">Skipped</option>
        </select>
        <label className="dim">From <input className="text-input" type="date" value={f.from} onChange={(e) => { setF({ ...f, from: e.target.value }); setPage(0); }} /></label>
        <label className="dim">To <input className="text-input" type="date" value={f.to} onChange={(e) => { setF({ ...f, to: e.target.value }); setPage(0); }} /></label>
        <a className="btn ghost" href={`/api/maintenance/log.csv?${logQs()}`} download="maintenance-log.csv">Export CSV</a>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid var(--md-border)', borderRadius: 8, fontSize: 12.5 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--md-text-soft)' }}><th style={cell}>When</th><th style={cell}>Task</th><th style={cell}>Run by</th><th style={cell}>Result</th><th style={cell}>Rows</th><th style={cell}>Freed</th><th style={cell}>Time</th></tr></thead>
          <tbody>{log?.items.map((l) => (
            <tr key={l.id} style={{ borderTop: '1px solid var(--md-border)' }}>
              <td style={cell}>{when(l.startedAt)}</td>
              <td style={cell}>{data.tasks.find((t) => t.id === l.task)?.name ?? l.task}{l.dryRun ? ' (preview)' : ''}</td>
              <td style={cell}>{l.trigger === 'auto' ? 'automatic' : l.userName ?? 'manual'}</td>
              <td style={cell}>{l.status}{l.error ? `: ${l.error}` : ''}</td>
              <td style={cell}>{l.rowsRemoved.toLocaleString()}</td>
              <td style={cell}>{l.bytesFreed ? formatBytes(l.bytesFreed) : '—'}</td>
              <td style={cell}>{l.durationMs < 1000 ? `${l.durationMs} ms` : `${(l.durationMs / 1000).toFixed(1)} s`}</td>
            </tr>
          ))}</tbody>
        </table>
        {log && log.items.length === 0 && <p className="dim" style={{ padding: 12, margin: 0 }}>Nothing logged yet.</p>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="dim">Page {page + 1} of {pages} · {log?.total ?? 0} entries</span>
        <button className="btn ghost" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </section>
  );
}
