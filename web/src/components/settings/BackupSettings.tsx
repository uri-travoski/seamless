import { useEffect, useState } from 'react';
import type { ApiBackup, ApiBackupConfig, ApiBackupStatus, BackupFrequency } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

const FREQUENCIES: { id: BackupFrequency; name: string }[] = [
  { id: 'twice_daily', name: 'Twice a day' },
  { id: 'daily', name: 'Once a day' },
  { id: 'every_2_days', name: 'Every 2 days' },
  { id: 'twice_weekly', name: 'Twice a week' },
  { id: 'weekly', name: 'Once a week' },
];

const fmtBytes = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fmtWhen = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : 'never');

export default function BackupSettings() {
  const [config, setConfig] = useState<ApiBackupConfig | null>(null);
  const [status, setStatus] = useState<ApiBackupStatus | null>(null);
  const [backups, setBackups] = useState<ApiBackup[]>([]);
  const [storageError, setStorageError] = useState('');
  const [busy, setBusy] = useState('');

  const load = async () => {
    const res = await api.get<{ config: ApiBackupConfig; status: ApiBackupStatus; backups: ApiBackup[]; storageError?: string }>('/api/backup');
    setConfig(res.config);
    setStatus(res.status);
    setBackups(res.backups);
    setStorageError(res.storageError ?? '');
  };

  useEffect(() => { void load().catch((e) => toast(e?.message ?? 'Could not load backup settings', 'error')); }, []);

  const save = async (patch: Partial<ApiBackupConfig>) => {
    if (!config) return;
    setConfig({ ...config, ...patch });
    try {
      const res = await api.put<{ config: ApiBackupConfig; status: ApiBackupStatus }>('/api/backup', patch);
      // Take the server's value back for the saved keys only (it normalises, e.g. adds the
      // trailing slash to a prefix). Overwriting the whole object would wipe whatever the
      // user has already typed into another field but not yet blurred.
      const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, (res.config as any)[k]]));
      setConfig((prev) => (prev ? { ...prev, ...saved } : res.config));
      setStatus(res.status);
    } catch (e: any) {
      toast(e?.message ?? 'Save failed', 'error');
      await load();
    }
  };

  const runNow = async () => {
    setBusy('run');
    try {
      const res = await api.post<{ rows: number; bytes: number; status: ApiBackupStatus; backups: ApiBackup[] }>('/api/backup/run', {});
      setStatus(res.status);
      setBackups(res.backups);
      toast(`Backed up ${res.rows} rows (${fmtBytes(res.bytes)})`);
    } catch (e: any) {
      toast(e?.message ?? 'Backup failed', 'error');
      await load();
    } finally {
      setBusy('');
    }
  };

  const verify = async (key: string) => {
    setBusy(key);
    try {
      const res = await api.post<{ rows: number; tables: number }>('/api/backup/verify', { key });
      toast(`Verified: ${res.rows} rows across ${res.tables} tables read back cleanly`);
    } catch (e: any) {
      toast(e?.message ?? 'Verify failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const dismiss = async () => {
    await api.post('/api/backup/ack', {});
    await load();
  };

  if (!config || !status) return <div><h2>Backup</h2><p className="settings-desc">Loading…</p></div>;

  const failing = status.lastStatus === 'error' && !status.acknowledged;
  // mirrors alertRecipients() on the server, so the count shown is what will actually be mailed
  const recipients = (config.alertEmail ?? '')
    .split(/[,;\s]+/)
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim()));

  return (
    <div>
      <h2>Backup</h2>
      <p className="settings-desc">
        Your mail bodies already live in object storage as <code>.eml</code> files. Everything else — labels, threads,
        read state, rules, AI decisions and retention countdowns — lives only in Postgres. This backs that up to the
        same bucket, encrypted with <code>SEAMLESS_SECRET</code>, so a destroyed server is a restore rather than a loss.
      </p>

      {failing && (
        <div className="banner error">
          <div>
            <strong>Last backup failed</strong>
            <div>{status.lastError}</div>
            <div className="dim">{fmtWhen(status.lastAt)}</div>
          </div>
          <button className="btn" onClick={() => void dismiss()}>Dismiss</button>
        </div>
      )}

      {storageError && (
        <div className="banner error">
          <div>
            <strong>Cannot reach your storage bucket</strong>
            <div>{storageError}</div>
            <div className="dim">Check the <code>S3_*</code> settings in your environment. Existing backups are not listed until this is fixed.</div>
          </div>
        </div>
      )}

      <div className="field">
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={config.enabled} onChange={(e) => void save({ enabled: e.target.checked })} />
          Back up automatically
        </label>
      </div>

      <div className="field-row">
        <div className="field">
          <label>How often</label>
          <select className="text-input" value={config.frequency} disabled={!config.enabled}
            onChange={(e) => void save({ frequency: e.target.value as BackupFrequency })}>
            {FREQUENCIES.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>At (UTC)</label>
          <select className="text-input" value={config.hour} disabled={!config.enabled}
            onChange={(e) => void save({ hour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Keep last</label>
          <input className="text-input" type="number" min={1} max={365} value={config.keep} disabled={!config.enabled}
            onChange={(e) => void save({ keep: Number(e.target.value) })} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>Where it goes</label>
          <input className="text-input" value={config.prefix}
            onChange={(e) => setConfig({ ...config, prefix: e.target.value })}
            onBlur={(e) => void save({ prefix: e.target.value })} />
          <div className="hint">
            Always inside the <code>seamless/</code> app folder, so one bucket can hold several apps' backups.
            Anything you type is nested under it.
          </div>
        </div>
        <div className="field">
          <label>Email me if a backup fails</label>
          {/* type=text, not email: browsers reject a comma-separated list in an email input */}
          <input className="text-input" type="text" placeholder="you@example.com, ops@example.com"
            value={config.alertEmail}
            onChange={(e) => setConfig({ ...config, alertEmail: e.target.value })}
            onBlur={(e) => void save({ alertEmail: e.target.value })} />
          <div className="hint">
            {recipients.length > 1
              ? `${recipients.length} recipients will be alerted.`
              : 'Separate several addresses with commas.'}{' '}
            Sent through your first connected account. Failures also push-notify and land in Logs.
          </div>
        </div>
      </div>

      <div className="field" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button className="btn primary" disabled={!!busy} onClick={() => void runNow()}>
          {busy === 'run' ? 'Backing up…' : 'Back up now'}
        </button>
        <span className="dim">
          Last: {status.lastStatus === 'ok' ? `ok, ${status.lastRows} rows (${fmtBytes(status.lastBytes)})`
            : status.lastStatus === 'error' ? 'failed' : 'never run'} · {fmtWhen(status.lastAt)}
          {config.enabled && status.nextDueAt ? ` · next ${fmtWhen(status.nextDueAt)}` : ''}
        </span>
      </div>

      <h3>Backups in storage</h3>
      {!backups.length ? (
        <p className="settings-desc">Nothing yet. Run one now, or turn on the schedule.</p>
      ) : (
        <table className="tbl">
          <thead><tr><th>When</th><th>Rows</th><th>Size</th><th /></tr></thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.key}>
                <td>{new Date(b.createdAt).toLocaleString()}</td>
                <td>{b.rows}</td>
                <td>{fmtBytes(b.bytes)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn" disabled={!!busy} onClick={() => void verify(b.key)}>
                    {busy === b.key ? 'Verifying…' : 'Verify'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Restoring</h3>
      <p className="settings-desc">
        There is deliberately no restore button here: a restore replaces every table, and the case that needs it is a
        server that no longer exists. On a rebuilt box, point it at the same bucket with the same{' '}
        <code>SEAMLESS_SECRET</code> and either pick a backup on the setup screen, or run:
      </p>
      <pre className="code-block">npm run restore -- --list{'\n'}npm run restore -- --latest</pre>
      <p className="settings-desc">
        Keep <code>SEAMLESS_SECRET</code> somewhere other than the server. Without it these backups cannot be read.
      </p>
    </div>
  );
}
