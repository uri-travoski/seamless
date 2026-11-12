/** Settings → Archives (T8.6, admin): attach a bucket that holds archives, see what is in it, import old mail + app data to browse. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { formatBytes } from '../Sidebar.tsx';
import { navigate } from '../../router.ts';
import StorageForm, { emptyForm, TestSteps, type FormValue, type TestResult } from './StorageForm.tsx';

interface Source { id: number; bucket: string; prefix: string; endpoint: string; provider: string; lastTest: TestResult | null }
interface Found {
  kind: 'archive'; path: string; name: string; createdAt: number | null; rule: { olderThanDays?: number; mode?: string } | null; accounts: { key: string; email: string }[];
  messages: number; bytes: number; appVersion: string; supported: boolean; reason: string | null;
}
interface FoundBackup { kind: 'backup'; path: string; createdAt: number | null; appVersion: string; rows: number; bytes: number; note: string }
interface Scan { archives: Found[]; backups: FoundBackup[]; uploadId?: string }
interface Imp {
  id: number; name: string; status: string; total: number | null; imported: number; skipped: number; failed: number; progress: number; error: string | null;
  configResult: Record<string, { created: number; skipped: number }> | null;
}
type Src = { kind: 'bucket'; targetId: number } | { kind: 'zip'; uploadId: string } | { kind: 'folder'; folder: string };

const CATS: [string, string][] = [
  ['labels', 'Labels'], ['rules', 'Rules'], ['filters', 'Filters'], ['views', 'Saved views'], ['templates', 'Templates & quick replies'], ['contacts', 'Contacts'],
  ['businesses', 'Businesses & identities'], ['senders', 'VIP & trusted senders'], ['notes', 'Notes'], ['appearance', 'Appearance'],
];
const when = (t: number | null) => (t ? new Date(t).toLocaleDateString([], { dateStyle: 'medium' }) : '—');
const STATUS: Record<string, string> = { queued: 'Waiting to start', running: 'Importing', paused: 'Paused', done: 'Finished', failed: 'Failed' };

export default function ArchivesSettings() {
  const [sources, setSources] = useState<Source[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<FormValue>(emptyForm('archive_source', 'minio'));
  const [saveErr, setSaveErr] = useState('');
  const [saveTest, setSaveTest] = useState<TestResult | null>(null);
  const [src, setSrc] = useState<Src | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [scanErr, setScanErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [accounts, setAccounts] = useState<'all' | Set<string>>('all');
  const [cats, setCats] = useState<Record<string, boolean>>(Object.fromEntries(CATS.map(([k]) => [k, true])));
  const [folder, setFolder] = useState('');
  const [imports, setImports] = useState<Imp[]>([]);
  const [detail, setDetail] = useState<{ id: number; failures: { key: string; error: string }[] } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [s, i] = await Promise.all([api.get<{ sources: Source[] }>('/api/archives/sources'), api.get<{ imports: Imp[] }>('/api/archives/imports')]);
    setSources(s.sources); setImports(i.imports);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!imports.some((i) => i.status === 'queued' || i.status === 'running')) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [imports, load]);

  const attach = async () => {
    setBusy(true); setSaveErr(''); setSaveTest(null);
    try { await api.post('/api/archives/sources', { role: 'archive_source', ...form }); setAdding(false); setForm(emptyForm('archive_source', 'minio')); await load(); toast('Bucket attached'); }
    catch (e: any) { setSaveErr(e?.message ?? 'Could not attach'); try { setSaveTest((await api.post<TestResult>('/api/archives/sources/test', form))); } catch { /* shown above */ } }
    setBusy(false);
  };
  const detach = async (s: Source) => {
    if (!window.confirm(`Detach ${s.bucket}? Mail that was already imported stays.`)) return;
    try { await api.del(`/api/archives/sources/${s.id}`); if (src?.kind === 'bucket' && src.targetId === s.id) { setSrc(null); setScan(null); } await load(); } catch (e: any) { toast(e?.message ?? 'Failed'); }
  };
  const open = async (s: Src) => {
    setBusy(true); setScanErr(''); setScan(null); setSrc(s); setPicked(new Set());
    try { const r = await api.post<Scan>('/api/archives/sources/scan', s); setScan(r); setPicked(new Set(r.archives.filter((a) => a.supported).map((a) => a.path))); }
    catch (e: any) { setScanErr(e?.message ?? 'Could not read that location'); }
    setBusy(false);
  };
  const upload = async (f: File) => {
    setBusy(true); setScanErr(''); setScan(null);
    try {
      const fd = new FormData(); fd.append('file', f);
      const res = await fetch('/api/archives/imports/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'Upload failed');
      setSrc({ kind: 'zip', uploadId: j.uploadId }); setScan(j); setPicked(new Set((j.archives as Found[]).filter((a) => a.supported).map((a) => a.path)));
    } catch (e: any) { setScanErr(e?.message ?? 'Upload failed'); }
    setBusy(false);
  };
  const start = async () => {
    if (!src || !picked.size) return;
    setBusy(true);
    try {
      await api.post('/api/archives/imports', { ...src, archives: [...picked], accounts: accounts === 'all' ? 'all' : [...accounts], categories: cats });
      toast('Import started: you can leave this page'); setScan(null); setSrc(null); await load();
    } catch (e: any) { setScanErr(e?.message ?? 'Could not start'); }
    setBusy(false);
  };
  const act = async (id: number, verb: 'pause' | 'resume' | 'retry') => { try { await api.post(`/api/archives/imports/${id}/${verb}`); await load(); } catch (e: any) { toast(e?.message ?? 'Failed'); } };
  const remove = async (i: Imp) => {
    if (!window.confirm(`Remove the imported mail from “${i.name}”? Only the ${i.imported.toLocaleString()} messages that came from this archive are deleted from this app.`)) return;
    try { await api.del(`/api/archives/imports/${i.id}`); await load(); toast('Imported mail removed'); } catch (e: any) { toast(e?.message ?? 'Failed'); }
  };
  const showFailures = async (id: number) => { const d = await api.get<{ failures: { key: string; error: string }[] }>(`/api/archives/imports/${id}`); setDetail({ id, failures: d.failures }); };

  const allAccounts = scan ? [...new Map(scan.archives.filter((a) => picked.has(a.path)).flatMap((a) => a.accounts).map((a) => [a.key + a.email, a])).values()] : [];

  return (
    <div>
      <h2>Archives</h2>
      <p className="settings-desc">Open an archive made by another copy of this app, or by this one, to browse and search old mail. Archives are only ever read: nothing is written to the bucket. The <strong>?</strong> beside the title opens the manual page “Viewing old mail”.</p>

      <h3>Where the archives are</h3>
      {sources.length === 0 && <p className="dim">No bucket attached yet.</p>}
      <ul className="health-list">
        {sources.map((s) => (
          <li key={s.id} className="health-note">
            <strong>{s.bucket}</strong>{s.prefix ? ` / ${s.prefix}` : ''} <span className="dim">{s.endpoint}</span>{' '}
            <button className="btn" disabled={busy} onClick={() => void open({ kind: 'bucket', targetId: s.id })}>Find archives</button>{' '}
            <button className="btn" onClick={() => void detach(s)}>Detach</button>
          </li>
        ))}
      </ul>
      {!adding && <button className="btn" onClick={() => setAdding(true)}>Attach a bucket</button>}
      {adding && (
        <div>
          <p className="hint">A <strong>read-only key is enough</strong>. Enter the bucket and the folder (prefix) that holds the archives.</p>
          <StorageForm role="archive_source" value={form} onChange={setForm} testUrl="/api/archives/sources/test" />
          {saveErr && <div className="health-note red">{saveErr}</div>}
          {saveTest && !saveTest.ok && <TestSteps result={saveTest} />}
          <div style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={busy || !form.endpoint || !form.bucket || !form.accessKey || !form.secretKey} onClick={() => void attach()}>Test and attach</button>{' '}
            <button className="btn" onClick={() => { setAdding(false); setSaveErr(''); }}>Cancel</button>
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 20 }}>Or use a file</h3>
      <p className="hint">Downloaded an archive folder? Upload it as a <code>.zip</code>, or give the path of a folder on this server.</p>
      <input ref={file} type="file" accept=".zip,application/zip" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
      <button className="btn" disabled={busy} onClick={() => file.current?.click()}>Upload a .zip…</button>{' '}
      <input className="text-input" style={{ width: 260 }} placeholder="/path/to/archive-folder" value={folder} onChange={(e) => setFolder(e.target.value)} />{' '}
      <button className="btn" disabled={busy || !folder.trim()} onClick={() => void open({ kind: 'folder', folder: folder.trim() })}>Read folder</button>

      {busy && !scan && <p className="dim">Reading…</p>}
      {scanErr && <div className="health-note red">{scanErr}</div>}
      {scan && (
        <div style={{ marginTop: 16 }}>
          <h3>Archives found</h3>
          {scan.archives.length === 0 && <p className="dim">No archives here.</p>}
          {scan.archives.map((a) => (
            <label key={a.path} className={`check-row${a.supported ? '' : ' dim'}`} style={{ display: 'block', opacity: a.supported ? 1 : 0.55, margin: '6px 0' }}>
              <input type="checkbox" disabled={!a.supported} checked={picked.has(a.path)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(a.path); else n.delete(a.path); setPicked(n); }} />{' '}
              <strong>{a.name}</strong> · {when(a.createdAt)} · {a.messages.toLocaleString()} messages · {formatBytes(a.bytes)} · {a.accounts.map((x) => x.email).join(', ') || 'no mailboxes'}
              {a.rule?.olderThanDays ? ` · older than ${Math.round(a.rule.olderThanDays / 365 * 10) / 10} years (${a.rule.mode})` : ''} · app {a.appVersion}
              {!a.supported && <div className="health-note red">{a.reason}</div>}
            </label>
          ))}
          {scan.backups.map((b) => (
            <div key={b.path} className="health-note">Full backup · {when(b.createdAt)} · {b.rows.toLocaleString()} rows · app {b.appVersion}. {b.note}{' '}
              <button className="linklike" onClick={() => navigate({ page: 'settings', tab: 'backup' })}>Open Settings → Backup</button></div>
          ))}
          {picked.size > 0 && (
            <div>
              <h4>What to import</h4>
              {allAccounts.length > 1 && (
                <div className="field"><label>Mailboxes</label>
                  <label className="check"><input type="checkbox" checked={accounts === 'all'} onChange={(e) => setAccounts(e.target.checked ? 'all' : new Set())} /> All mailboxes</label>
                  {accounts !== 'all' && allAccounts.map((x) => (
                    <label key={x.key + x.email} className="check"><input type="checkbox" checked={accounts.has(x.key)} onChange={(e) => { const n = new Set(accounts); if (e.target.checked) n.add(x.key); else n.delete(x.key); setAccounts(n); }} /> {x.email}</label>
                  ))}
                </div>
              )}
              <div className="field"><label>Also bring over (existing items with the same name are kept, never overwritten)</label>
                {CATS.map(([k, n]) => <label key={k} className="check"><input type="checkbox" checked={cats[k]} onChange={(e) => setCats({ ...cats, [k]: e.target.checked })} /> {n}</label>)}
              </div>
              <button className="btn primary" disabled={busy || (accounts !== 'all' && accounts.size === 0)} onClick={() => void start()}>Import {picked.size} archive{picked.size === 1 ? '' : 's'}</button>
              <p className="hint">Imported mail is read-only, never deleted automatically, and is not sent to AI or notified about.</p>
            </div>
          )}
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>Imported archives</h3>
      {imports.length === 0 && <p className="dim">Nothing imported yet.</p>}
      {imports.map((i) => (
        <div key={i.id} className="health-note" style={{ margin: '8px 0' }}>
          <strong>{i.name}</strong> · {STATUS[i.status] ?? i.status}
          <div role="progressbar" aria-valuenow={Math.round(i.progress * 100)} style={{ height: 6, background: 'var(--border)', borderRadius: 3, margin: '4px 0' }}>
            <div style={{ width: `${Math.round(i.progress * 100)}%`, height: 6, background: 'var(--accent)', borderRadius: 3 }} />
          </div>
          <span className="dim">{i.imported.toLocaleString()} imported · {i.skipped.toLocaleString()} already here · {i.failed.toLocaleString()} failed{i.total != null ? ` · of ${i.total.toLocaleString()}` : ''}</span>
          {i.configResult && <div className="dim">{Object.entries(i.configResult).filter(([, v]) => v && typeof v === 'object' && 'created' in v).map(([k, v]) => `${k}: ${v.created} new, ${v.skipped} kept`).join(' · ')}</div>}
          {i.error && <div className="health-note red">{i.error}</div>}
          <div style={{ marginTop: 4 }}>
            {(i.status === 'running' || i.status === 'queued') && <button className="btn" onClick={() => void act(i.id, 'pause')}>Pause</button>}{' '}
            {(i.status === 'paused' || i.status === 'failed') && <button className="btn" onClick={() => void act(i.id, 'resume')}>Resume</button>}{' '}
            {i.failed > 0 && i.status === 'done' && <><button className="btn" onClick={() => void act(i.id, 'retry')}>Retry failed</button>{' '}<button className="btn" onClick={() => void showFailures(i.id)}>Show failed</button>{' '}</>}
            <button className="btn" onClick={() => void remove(i)}>Remove imported mail</button>
          </div>
          {detail?.id === i.id && <ul>{detail.failures.map((f) => <li key={f.key}><code>{f.key}</code> {f.error}</li>)}</ul>}
        </div>
      ))}
    </div>
  );
}
