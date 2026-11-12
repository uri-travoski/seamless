import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import type { ApiProcessingLog } from '@seamless/shared';

const KINDS = ['', 'classify', 'retention', 'import', 'sync', 'send'];

export default function LogsSettings() {
  const [logs, setLogs] = useState<ApiProcessingLog[]>([]);
  const [kind, setKind] = useState('');

  const refresh = async (k = kind) => {
    setLogs(await api.get<ApiProcessingLog[]>(`/api/logs${k ? `?kind=${k}` : ''}`));
  };
  useEffect(() => { void refresh(); }, [kind]);

  const clear = async () => {
    if (!window.confirm('Clear all processing logs?')) return;
    await api.del('/api/logs');
    await refresh();
  };

  return (
    <div>
      <h2>Processing logs</h2>
      <p className="settings-desc">
        Everything the classifier and retention sweep did (or would do, in dry-run). Logs auto-clear after the
        period set in Storage → Trash &amp; retention.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <select className="text-input" style={{ width: 160 }} value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map((k) => <option key={k} value={k}>{k === '' ? 'All kinds' : k}</option>)}
        </select>
        <button className="btn ghost" onClick={() => void refresh()}>Refresh</button>
        <span style={{ flex: 1 }} />
        <button className="btn ghost danger" onClick={() => void clear()}>Clear logs</button>
      </div>
      <div style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid var(--md-border)', borderRadius: 8, fontSize: 12.5 }}>
        {logs.map((l) => (
          <div key={l.id} style={{ display: 'flex', gap: 10, padding: '5px 10px', borderBottom: '1px solid var(--md-border)', alignItems: 'baseline' }}>
            <span style={{ flex: '0 0 130px', color: 'var(--md-text-faint)', fontSize: 11 }}>{new Date(l.createdAt).toLocaleString()}</span>
            <span style={{ flex: '0 0 70px', fontWeight: 600, color: l.level === 'error' ? '#c62828' : 'var(--md-text-soft)' }}>{l.kind}</span>
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{l.message}</span>
          </div>
        ))}
        {logs.length === 0 && <p style={{ color: 'var(--md-text-faint)', padding: 12, margin: 0 }}>No log entries.</p>}
      </div>
    </div>
  );
}
