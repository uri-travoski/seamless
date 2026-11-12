/** Trash, retention and automatic clean-up (lives in Settings → Storage). Per user; shown to everyone. */
import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';

interface RetentionSettings { dryRun: boolean; trashDays: number; logRetentionDays: number }

export default function RetentionPanel() {
  const [settings, setSettings] = useState<RetentionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [sweepResult, setSweepResult] = useState<string>('');
  useEffect(() => { void api.get<RetentionSettings>('/api/retention/settings').then(setSettings); }, []);

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

  return (
    <section className="settings-section" id="trash-retention" style={{ marginTop: 28 }}>
      <h3 style={{ fontSize: 16 }}>Trash &amp; retention</h3>
      <p className="settings-desc">
        Deleted mail, the Bin / Recycle Bin / Trash, and how long things are kept. Runs hourly: mail whose label countdown
        expired moves to Trash (recoverable), and swept Trash older than the grace window is purged. Protected labels,
        starred/unread-by-you mail and anything you restored are never touched.
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
            <div className="field"><label>Empty Trash after (days)</label>
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
    </section>
  );
}
