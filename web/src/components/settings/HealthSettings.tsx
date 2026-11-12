/** Settings → Health (T2 F-21): one page for everything that can quietly go wrong. Refreshes every 30 s. */
import { NoChannelBanner } from '../AlertItems.tsx';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { navigate } from '../../router.ts';
import { formatBytes } from '../Sidebar.tsx';

type Light = 'ok' | 'warn' | 'red';
interface Report {
  generatedAt: number; isAdmin: boolean; overall: Light;
  mailboxes: { accountId: number; email: string; kind: string; enabled: boolean; state: string; lastSyncAt: number | null; lastError: string; failures: number; needsReconnect: boolean; newLast24h: number; status: Light; ignored: boolean }[];
  sending: { failed24h: number; failed7d: number; scheduled: number; holding: number; status: Light };
  jobs: { counts: Record<string, number>; oldestPendingAt: number | null; lateMs: number; failed: { id: number; kind: string; attempts: number; lastError: string; runAt: number }[]; status: Light };
  ai: { providers: number; status: Light; note: string };
  storage?: { reachable: boolean; latencyMs: number; error: string; checkedAt: number; bytes: number; messages: number; spool?: boolean; status: Light };
  backups?: { enabled: boolean; lastAt: number | null; lastStatus: string | null; lastError: string; nextDueAt: number | null; status: Light; note: string };
  archives?: { id: number; name: string; status: string; mode: string; messages: number }[];
  attachmentIndex?: { state: string; processed: number; total: number } | null;
  mode?: 'live' | 'viewing';
  system?: { version: string; uptimeSec: number; dbBytes: number; rssBytes: number; freeBytes: number | null; status: Light };
}

const WORD: Record<Light, string> = { ok: 'OK', warn: 'Needs a look', red: 'Problem' };
const when = (t: number | null) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const ago = (t: number | null) => {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129_600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const dur = (sec: number) => (sec < 3600 ? `${Math.round(sec / 60)} min` : sec < 172_800 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86400)} days`);

function Dot({ s }: { s: Light }) {
  return <span className={`health-dot ${s}`} role="img" aria-label={WORD[s]} title={WORD[s]} />;
}

function Card({ title, status, children }: { title: string; status: Light; children: React.ReactNode }) {
  return (
    <section className={`health-card ${status}`}>
      <h3><Dot s={status} /> {title}</h3>
      {children}
    </section>
  );
}

export default function HealthSettings() {
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(() => { api.get<Report>('/api/health').then((x) => { setR(x); setErr(false); }).catch(() => setErr(true)); }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  if (!r) return <div><h2>Health</h2><p className="dim">{err ? 'Could not load the health report.' : 'Loading…'}</p></div>;

  const resync = async (id: number) => { try { await api.post(`/api/accounts/${id}/resync`); toast('Re-sync started'); setTimeout(load, 1500); } catch { toast('Could not start', 'error'); } };
  const setIgnored = async (id: number, ignored: boolean) => { try { await api.post(`/api/accounts/${id}/health-ignore`, { ignored }); toast(ignored ? 'Ignored: no status colour or alerts for this mailbox' : 'No longer ignored'); load(); } catch { toast('Could not change that', 'error'); } };
  const jobOp = async (id: number, op: 'retry' | 'cancel') => { try { await api.post(`/api/jobs/${id}/${op}`); load(); } catch { toast('Could not do that', 'error'); } };
  const reingest = async () => { try { const x = await api.post<{ found: number; ingested: number; skipped: number; failed: number }>('/api/storage/spool/reingest'); toast(`Spool: ${x.found} found, ${x.ingested} imported, ${x.skipped} already there or unknown, ${x.failed} failed`); load(); } catch (e: any) { toast(e?.message ?? 'Could not re-ingest', 'error'); } };
  const checkStorage = async () => { try { await api.post('/api/health/storage-check'); load(); } catch { toast('Could not check', 'error'); } };

  return (
    <div className="health-page">
      <h2>Health <Dot s={r.overall} /></h2>
      <NoChannelBanner />
      <p className="settings-desc">
        {r.overall === 'ok' ? 'Everything is working.' : r.overall === 'warn' ? 'Some things need a look.' : 'Something needs fixing.'}
        {' '}Updated {ago(r.generatedAt)}; refreshes by itself. To watch from outside, point an uptime monitor at <code>/healthz</code>.
      </p>

      <div className="health-grid">
        <Card title="Mailboxes" status={r.mailboxes.length ? r.mailboxes.filter((m) => !m.ignored).reduce<Light>((a, m) => (m.status === 'red' || a === 'red' ? 'red' : m.status === 'warn' || a === 'warn' ? 'warn' : 'ok'), 'ok') : 'warn'}>
          {r.mailboxes.length === 0 && <p className="dim">No mailboxes connected.</p>}
          {r.mailboxes.map((m) => (
            <div key={m.accountId} className="health-row" style={m.ignored ? { opacity: 0.6 } : undefined}>
              <Dot s={m.ignored ? 'ok' : m.status} />
              <div className="grow">
                <strong>{m.email}</strong>{m.ignored && <span className="tag muted">ignored</span>}
                <div className="dim">
                  {m.state === 'paused' ? 'Paused' : m.state === 'error' ? 'Can’t connect' : 'Connected'} · last sync {ago(m.lastSyncAt)} · {m.newLast24h} new in 24 h
                </div>
                {m.needsReconnect && <div className="health-note red">Its sign-in no longer works. Reconnect it in Settings → Mailboxes.</div>}
                {m.state === 'error' && m.lastError && <div className="health-note">{m.lastError}</div>}
              </div>
              <button className="btn ghost small" title="Stop counting this mailbox in the status dot, this page's overall light and failure alerts" onClick={() => void setIgnored(m.accountId, !m.ignored)}>{m.ignored ? 'Stop ignoring' : 'Ignore'}</button>
              <button className="btn ghost small" onClick={() => void resync(m.accountId)}>Re-sync</button>
            </div>
          ))}
        </Card>

        <Card title="Sending" status={r.sending.status}>
          <ul className="health-list">
            <li>Failed sends: <strong>{r.sending.failed24h}</strong> in 24 h, <strong>{r.sending.failed7d}</strong> in 7 days</li>
            <li>Scheduled to send later: <strong>{r.sending.scheduled}</strong></li>
            <li>Held for Undo right now: <strong>{r.sending.holding}</strong></li>
          </ul>
        </Card>

        <Card title="Background tasks" status={r.jobs.status}>
          <ul className="health-list">
            <li>Waiting: <strong>{r.jobs.counts.pending ?? 0}</strong> · running: <strong>{r.jobs.counts.running ?? 0}</strong> · failed: <strong>{r.jobs.counts.failed ?? 0}</strong></li>
            {r.jobs.oldestPendingAt && <li>Oldest waiting task is due {when(r.jobs.oldestPendingAt)}{r.jobs.lateMs > 60_000 ? ` — ${dur(Math.round(r.jobs.lateMs / 1000))} late` : ''}</li>}
          </ul>
          {r.jobs.failed.map((j) => (
            <div key={j.id} className="health-row">
              <div className="grow"><strong>{j.kind}</strong> <span className="dim">after {j.attempts} tries</span><div className="health-note">{j.lastError || 'No details'}</div></div>
              <button className="btn small" onClick={() => void jobOp(j.id, 'retry')}>Retry</button>
              <button className="btn ghost small" onClick={() => void jobOp(j.id, 'cancel')}>Dismiss</button>
            </div>
          ))}
        </Card>

        {!!r.archives?.length && (
          <Card title="Archive running" status="ok">
            {r.archives.map((a) => (
              <p key={a.id}>{a.name}: {a.status === 'planned' ? 'waiting to start' : a.status === 'restoring' ? 'restoring' : a.mode === 'move' ? 'moving' : 'copying'} {a.messages.toLocaleString()} messages.</p>
            ))}
            <button className="btn small" onClick={() => navigate({ page: 'settings', tab: 'backup' })}>See progress</button>
          </Card>
        )}

        {r.isAdmin && r.attachmentIndex && (
          <Card title="Attachment search" status="ok">
            <p>{r.attachmentIndex.state === 'running'
              ? `Indexing attachments of existing mail… ${r.attachmentIndex.processed} of ${r.attachmentIndex.total} messages.`
              : r.attachmentIndex.state === 'done'
                ? `Existing mail is indexed (${r.attachmentIndex.total} messages with attachments).`
                : 'New mail is indexed as it arrives. Existing mail is not searchable by attachment content until you index it.'}</p>
            <button className="btn small" disabled={r.attachmentIndex.state === 'running'}
              onClick={async () => { try { await api.post('/api/health/attachment-index', {}); toast('Indexing started'); load(); } catch { toast('Could not start indexing', 'error'); } }}>
              Index attachments of existing mail
            </button>
          </Card>
        )}

        <Card title="AI" status={r.ai.status}>
          <p>{r.ai.providers} provider{r.ai.providers === 1 ? '' : 's'} set up. <span className="dim">{r.ai.note}</span></p>
        </Card>

        {r.storage && (
          <Card title="Mail storage" status={r.storage.status}>
            <ul className="health-list">
              <li>{r.storage.reachable ? `Reachable (${r.storage.latencyMs} ms)` : 'Not reachable'} · checked {ago(r.storage.checkedAt)}</li>
              <li>{r.storage.messages.toLocaleString()} messages · about {formatBytes(r.storage.bytes)}</li>
            </ul>
            {!r.storage.reachable && <div className="health-note red">{r.storage.error}</div>}
            <button className="btn ghost small" onClick={() => void checkStorage()}>Check now</button>
            {r.storage.spool && <> <button className="btn ghost small" onClick={() => void reingest()}>Re-ingest spool</button></>}
          </Card>
        )}

        {r.backups && (
          <Card title="Backups" status={r.backups.status}>
            <p>{r.backups.note}</p>
            <ul className="health-list">
              <li>Last backup: {when(r.backups.lastAt)}</li>
              {r.backups.nextDueAt && <li>Next due: {when(r.backups.nextDueAt)}</li>}
            </ul>
          </Card>
        )}

        {r.system && (
          <Card title="Server" status={r.system.status}>
            <ul className="health-list">
              <li>Version {r.system.version} · up {dur(r.system.uptimeSec)}</li>
              <li>Mode: {r.mode === 'viewing' ? 'Viewing only (mail is not sent or received)' : 'Live'}</li>
              <li>Database {formatBytes(r.system.dbBytes)} · memory {formatBytes(r.system.rssBytes)}</li>
              {r.system.freeBytes !== null && <li>Free disk space {formatBytes(r.system.freeBytes)}</li>}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
