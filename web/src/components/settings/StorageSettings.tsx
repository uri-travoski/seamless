/** Settings → Storage (T3 F-26, admin): where mail, backups and the inbound spool live. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { formatBytes } from '../Sidebar.tsx';
import RetentionPanel from './RetentionPanel.tsx';
import { useSession } from '../../state/session.ts';
import StorageMigration from './StorageMigration.tsx';
import StorageForm, { TestSteps, emptyForm, PROVIDERS, type FormValue, type Role, type TestResult } from './StorageForm.tsx';

interface Target {
  id: number; role: Role; provider: string; endpoint: string; region: string; bucket: string; prefix: string;
  forcePathStyle: boolean; active: boolean; acceptSameBucket: boolean; verifiedAt: number | null; accessKeyHint: string; lastTest: TestResult | null;
}
interface Listing { targets: Target[]; envOverride: { mail: boolean; backup: boolean }; current: { mail: { endpoint: string; bucket: string } } }

const ROLE_NAME: Record<Role, string> = { mail: 'Mail', backup: 'Backups', spool: 'Inbound spool (optional)' };
const when = (t: number | null) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

function StorageAdmin() {
  const [data, setData] = useState<Listing | null>(null);
  const [usage, setUsage] = useState<{ objects: number; bytes: number } | null>(null);
  const [adding, setAdding] = useState<Role | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [form, setForm] = useState<FormValue>(emptyForm('mail'));
  const [testing, setTesting] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, TestResult>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Listing>('/api/storage/targets'));
      setUsage(await api.get('/api/storage/targets/usage'));
    } catch (e: any) { toast(e?.message ?? 'Could not load storage settings', 'error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (!data) return <div><h2>Storage</h2><p className="dim">Loading…</p></div>;

  const testAgain = async (id: number) => {
    setTesting(id);
    try { const r = await api.post<TestResult>(`/api/storage/targets/${id}/test`); setResults((x) => ({ ...x, [id]: r })); await load(); }
    catch (e: any) { toast(e?.message ?? 'Test failed', 'error'); }
    setTesting(null);
  };

  const startAdd = (role: Role) => { setEditing(null); setAdding(role); setForm(emptyForm(role)); };
  const startEdit = (t: Target) => {
    setAdding(null); setEditing(t.id);
    setForm({ provider: t.provider, endpoint: t.endpoint, region: t.region, bucket: t.bucket, prefix: t.prefix, forcePathStyle: t.forcePathStyle, accessKey: '', secretKey: '', acceptSameBucket: t.acceptSameBucket });
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = editing
        ? await api.put<{ note?: string }>(`/api/storage/targets/${editing}`, form)
        : await api.post<{ note?: string; overriddenByEnv?: boolean }>('/api/storage/targets', { role: adding, ...form });
      toast(res.note || (editing ? 'Saved (connection re-tested)' : 'Storage saved'));
      setAdding(null); setEditing(null); await load();
    } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
    setBusy(false);
  };

  const editRole: Role | null = adding ?? data.targets.find((t) => t.id === editing)?.role ?? null;

  return (
    <div className="storage-page">
      <h2>Storage</h2>
      <p className="settings-desc">
        Where Seamless keeps your raw mail, your database backups and (optionally) the inbound spool. Every connection is
        tested before it is saved. Credentials are stored encrypted and are never shown again.
      </p>

      <section className="health-card ok">
        <h3>Mail storage now</h3>
        <ul className="health-list">
          <li>Bucket <code>{data.current.mail.bucket}</code> at <code>{data.current.mail.endpoint}</code></li>
          {usage && <li>{usage.objects.toLocaleString()} messages · about {formatBytes(usage.bytes)}</li>}
        </ul>
        {data.envOverride.mail && <div className="health-note">This server has <code>S3_*</code> set in its environment, which takes priority over anything saved here. Remove those variables to use a bucket chosen in this page.</div>}
      </section>

      <StorageMigration targets={data.targets} onChanged={() => void load()} />

      {(['mail', 'backup', 'spool'] as Role[]).map((role) => {
        const rows = data.targets.filter((t) => t.role === role);
        return (
          <section key={role} className="health-card ok" style={{ marginTop: 12 }}>
            <h3>{ROLE_NAME[role]}</h3>
            {role === 'backup' && data.envOverride.backup && <div className="health-note">Backup storage is set by the environment on this server and wins over what is saved here.</div>}
            {rows.length === 0 && <p className="dim">{role === 'mail' ? 'Using the server’s own settings.' : role === 'backup' ? 'Using the server’s own settings (a separate bucket is strongly recommended).' : 'Not set up.'}</p>}
            {rows.map((t) => (
              <div key={t.id} style={{ marginBottom: 10 }}>
                <strong>{PROVIDERS[t.provider]?.name ?? t.provider}</strong> · <code>{t.bucket}</code> {t.active ? '· in use' : '· saved, not in use'}
                <div className="hint">{t.endpoint} · key {t.accessKeyHint || 'stored'} · last verified {when(t.verifiedAt)}</div>
                {(results[t.id] ?? t.lastTest) && <TestSteps result={(results[t.id] ?? t.lastTest)!} />}
                <button className="btn ghost small" disabled={testing === t.id} onClick={() => void testAgain(t.id)}>{testing === t.id ? 'Testing…' : 'Test again'}</button>{' '}
                <button className="btn ghost small" onClick={() => startEdit(t)}>Edit credentials</button>
              </div>
            ))}
            {rows.length === 0 && <button className="btn small" onClick={() => startAdd(role)}>Set up {ROLE_NAME[role].toLowerCase().replace(' (optional)', '')}…</button>}
          </section>
        );
      })}

      {editRole && (
        <section className="health-card ok" style={{ marginTop: 12 }}>
          <h3>{editing ? 'Edit' : 'New'} {ROLE_NAME[editRole].toLowerCase()} storage</h3>
          <StorageForm role={editRole} value={form} onChange={setForm} editing={!!editing} />
          <p className="hint">Saving runs the test again; nothing is saved if it fails.</p>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>{' '}
          <button className="btn ghost" onClick={() => { setAdding(null); setEditing(null); }}>Cancel</button>
        </section>
      )}
    </div>
  );
}

/** Storage tab: buckets (admins) + Trash & retention (everyone). */
export default function StorageSettings() {
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  return (
    <div>
      {isAdmin ? <StorageAdmin /> : <h2>Storage</h2>}
      <RetentionPanel />
    </div>
  );
}
