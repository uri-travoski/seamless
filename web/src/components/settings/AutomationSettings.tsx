import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import NewsletterSettings from './NewsletterSettings.tsx';

interface ImportPreview {
  labels: { name: string; create: boolean }[];
  rules: { create: boolean }[];
  preferences: { create: boolean }[];
  routes: { create: boolean }[];
  settings: Record<string, string>;
  warnings: string[];
}

interface RetentionSettings { dryRun: boolean; trashDays: number; logRetentionDays: number }

export default function AutomationSettings() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<RetentionSettings | null>(null);
  const [sweepResult, setSweepResult] = useState<string>('');

  useEffect(() => { void api.get<RetentionSettings>('/api/retention/settings').then(setSettings); }, []);

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

  const saveSettings = async (patch: Partial<RetentionSettings>) => {
    const next = { ...settings!, ...patch };
    setSettings(next);
    await api.put('/api/retention/settings', next);
  };

  const sweepNow = async () => {
    setBusy(true);
    try {
      const stats = await api.post<{ trashed: number; purged: number; dryRun: number }>('/api/retention/sweep');
      setSweepResult(settings?.dryRun
        ? `Dry run: ${stats.dryRun} actions logged (nothing moved). See Logs.`
        : `Swept: ${stats.trashed} to Trash, ${stats.purged} purged.`);
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
      <h2>Import &amp; Retention</h2>

      <h3 style={{ fontSize: 14 }}>Import config spreadsheet</h3>
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

      <h3 style={{ fontSize: 14, marginTop: 26 }}>Retention sweep</h3>
      <p className="settings-desc">
        Runs hourly: mail whose label countdown expired moves to Trash (recoverable), and swept Trash older than the
        grace window is purged. Protected labels, starred/unread-by-you mail and anything you restored are never touched.
      </p>
      {settings && (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, fontWeight: 600 }}>
            <input type="checkbox" checked={settings.dryRun} onChange={(e) => void saveSettings({ dryRun: e.target.checked })} />
            Dry run — only log what would be deleted (recommended until the logs look right)
          </label>
          {!settings.dryRun && (
            <p style={{ color: '#c62828', fontSize: 12.5, margin: '6px 0 0' }}>
              Live mode: the sweep really moves mail to Trash and purges old swept Trash.
            </p>
          )}
          <div style={{ display: 'flex', gap: 18, marginTop: 12 }}>
            <div className="field"><label>Trash grace (days before purge)</label>
              <input className="text-input" type="number" min={1} style={{ width: 90 }} value={settings.trashDays}
                onChange={(e) => void saveSettings({ trashDays: Number(e.target.value) || 30 })} /></div>
            <div className="field"><label>Auto-clear logs after (days)</label>
              <input className="text-input" type="number" min={1} style={{ width: 90 }} value={settings.logRetentionDays}
                onChange={(e) => void saveSettings({ logRetentionDays: Number(e.target.value) || 90 })} /></div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn primary" disabled={busy} onClick={() => void sweepNow()}>Run sweep now</button>
            <span style={{ fontSize: 12.5, color: 'var(--md-text-soft)' }}>{sweepResult}</span>
          </div>
        </>
      )}
      <NewsletterSettings />
    </div>
  );
}
