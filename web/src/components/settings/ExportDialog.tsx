import { useState } from 'react';
import { downloadExport, uploadImport } from '../../api/client.ts';
import { toast } from '../../toast.ts';

const MIN = 12;

/** Settings → Backup → "Export everything": one password-protected file that imports on any Seamless server. */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [includeMail, setIncludeMail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ok = password.length >= MIN && password === again;

  const go = async () => {
    setBusy(true); setErr('');
    try {
      const name = await downloadExport(password, includeMail);
      toast(`Saved ${name}`);
      onClose();
    } catch (e: any) { setErr(e?.message ?? 'Export failed'); } finally { setBusy(false); }
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal small" role="dialog" aria-label="Export everything">
        <div className="modal-title">Export everything</div>
        <p className="hint">
          One file with every account, label, rule, template and setting, encrypted with the password below. It imports on a
          server with a different <code>SEAMLESS_SECRET</code>. Keep the password: it cannot be recovered.
        </p>
        <div className="field"><label>Password (at least {MIN} characters)</label>
          <input className="text-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        <div className="field"><label>Repeat password</label>
          <input className="text-input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></div>
        <label className="check">
          <input type="checkbox" checked={includeMail} onChange={(e) => setIncludeMail(e.target.checked)} /> Include the mail itself (can be large)
        </label>
        {again && password !== again && <div className="login-err">The passwords do not match.</div>}
        {err && <div className="login-err">{err}</div>}
        <div className="modal-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok || busy} onClick={() => void go()}>{busy ? 'Exporting…' : 'Export'}</button>
        </div>
      </div>
    </div>
  );
}

/** Pick an export file + password and import it. `full` is the first-run screen; `settings` merges into the current user. */
export function ImportForm({ mode, onDone }: { mode: 'full' | 'settings'; onDone: (summary: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const go = async () => {
    if (!file) return;
    setBusy(true); setErr('');
    try {
      const r = await uploadImport<{ rows?: number; added?: Record<string, number>; skipped?: Record<string, number> }>(file, password, mode);
      if (mode === 'full') onDone(`Imported ${r.rows} rows. Sign in with your existing account.`);
      else {
        const sum = (m?: Record<string, number>) => Object.values(m ?? {}).reduce((a, b) => a + b, 0);
        onDone(`Added ${sum(r.added)} item${sum(r.added) === 1 ? '' : 's'}, skipped ${sum(r.skipped)} that already existed.`);
      }
    } catch (e: any) { setErr(e?.message ?? 'Import failed'); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="field"><label>Export file</label>
        <input type="file" accept=".seamless-export,application/octet-stream" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
      <div className="field"><label>Export password</label>
        <input className="text-input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
      {err && <div className="login-err">{err}</div>}
      <button className="btn" disabled={!file || !password || busy} onClick={() => void go()}>
        {busy ? 'Importing…' : mode === 'full' ? 'Import everything' : 'Import settings'}
      </button>
    </div>
  );
}
