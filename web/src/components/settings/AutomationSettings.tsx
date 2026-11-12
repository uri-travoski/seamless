import { useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

interface ImportPreview {
  labels: { name: string; create: boolean }[];
  rules: { create: boolean }[];
  preferences: { create: boolean }[];
  routes: { create: boolean }[];
  settings: Record<string, string>;
  warnings: string[];
}

export default function AutomationSettings() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (commit: boolean) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/import/xlsx${commit ? '?commit=1' : ''}`, { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json()).error ?? 'import failed');
      const p = (await res.json()) as ImportPreview;
      setPreview(p);
      if (commit) toast('Spreadsheet imported — re-classifying existing mail', 'info');
    } catch (e: any) {
      toast(e?.message ?? 'Import failed', 'error');
    } finally { setBusy(false); }
  };

  const counts = preview ? {
    labels: preview.labels.filter((l) => l.create).length,
    rules: preview.rules.filter((r) => r.create).length,
    prefs: preview.preferences.filter((p) => p.create).length,
    routes: preview.routes.filter((r) => r.create).length,
  } : null;

  return (
    <div>
      <h2>Import config spreadsheet</h2>
      <p className="settings-desc">
        Reads your rules sheet (tabs: Labels, Rules, Settings, Preferences, Forwarding Accounts, Forwarding Out)
        and seeds labels with retention, rules, and AI preferences. Preview first — nothing is written until you apply.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input ref={fileRef} type="file" accept=".xlsx" style={{ fontSize: 13 }}
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />
        <button className="btn primary" disabled={!file || busy} onClick={() => void upload(false)}>Preview</button>
        {preview && counts && (counts.labels + counts.rules + counts.prefs + counts.routes > 0) && (
          <button className="btn primary" disabled={busy} onClick={() => void upload(true)}>
            Apply ({counts.labels} labels, {counts.rules} rules, {counts.prefs} preferences)
          </button>
        )}
      </div>
      {preview && (
        <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 12, marginTop: 12, fontSize: 13 }}>
          <div><b>{preview.labels.length}</b> labels ({counts!.labels} new) · <b>{preview.rules.length}</b> rules ({counts!.rules} new) · <b>{preview.preferences.length}</b> preferences ({counts!.prefs} new) · <b>{preview.routes.length}</b> forward routes ({counts!.routes} new)</div>
          {Object.keys(preview.settings).length > 0 && (
            <div style={{ marginTop: 6, color: 'var(--md-text-soft)' }}>Settings: {Object.entries(preview.settings).map(([k, v]) => `${k}=${v}`).join(', ')}</div>
          )}
          {preview.warnings.length > 0 && (
            <div style={{ marginTop: 6, color: '#b26a00' }}>{preview.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}</div>
          )}
        </div>
      )}

    </div>
  );
}
