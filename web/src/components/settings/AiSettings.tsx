import { useEffect, useState } from 'react';
import type { AiTask } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

interface Provider { id: number; name: string; baseUrl: string; model: string; hasKey: boolean }
interface TaskRow { task: AiTask; provider_id: number | null; model: string; enabled: number }

const TASKS: { task: AiTask; label: string; desc: string }[] = [
  { task: 'categorize', label: 'Categorize', desc: 'Auto-label incoming mail (enable per account under Accounts)' },
  { task: 'summarize', label: 'Summarize', desc: 'Thread summary button in the reading pane' },
  { task: 'draft', label: 'Draft replies', desc: 'AI draft button in the compose window' },
];

export default function AiSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [form, setForm] = useState<{ id?: number; name: string; baseUrl: string; apiKey: string; model: string } | null>(null);
  const [testMsg, setTestMsg] = useState<Record<number, string>>({});

  const load = async () => {
    const [p, t] = await Promise.all([
      api.get<Provider[]>('/api/ai/providers'),
      api.get<TaskRow[]>('/api/ai/tasks'),
    ]);
    setProviders(p);
    setTasks(TASKS.map(({ task }) => t.find((x) => x.task === task) ?? { task, provider_id: null, model: '', enabled: 0 }));
  };
  useEffect(() => { void load(); }, []);

  const saveProvider = async () => {
    if (!form) return;
    if (form.id) await api.put(`/api/ai/providers/${form.id}`, form);
    else await api.post('/api/ai/providers', form);
    setForm(null);
    void load();
  };

  const testProvider = async (id: number) => {
    setTestMsg({ ...testMsg, [id]: '…' });
    try {
      const res = await api.post<{ reply: string }>(`/api/ai/test/${id}`);
      setTestMsg({ ...testMsg, [id]: `✓ "${res.reply}"` });
    } catch (e: any) {
      setTestMsg({ ...testMsg, [id]: `✗ ${e?.message}` });
    }
  };

  const patchTask = (task: AiTask, patch: Partial<TaskRow>) => {
    const next = tasks.map((t) => (t.task === task ? { ...t, ...patch } : t));
    setTasks(next);
    void api.put('/api/ai/tasks', next.map((t) => ({ task: t.task, providerId: t.provider_id, model: t.model, enabled: !!t.enabled })))
      .then(() => toast('AI task mapping saved'))
      .catch(() => toast('Could not save AI tasks', 'error'));
  };

  return (
    <div>
      <h2>AI</h2>
      <p className="settings-desc">Any OpenAI-compatible endpoint works (OpenAI, OpenRouter, Ollama, LM Studio, vLLM…). Each feature can use a different provider.</p>

      <h3>Providers</h3>
      {providers.map((p) => (
        <div key={p.id} className="cond-row">
          <span style={{ width: 120, fontWeight: 600 }}>{p.name}</span>
          <span style={{ flex: 1, fontSize: 12.5, color: 'var(--md-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.baseUrl} · {p.model || 'no default model'}</span>
          <span style={{ fontSize: 12 }}>{testMsg[p.id] ?? ''}</span>
          <button className="btn ghost" onClick={() => void testProvider(p.id)}>Test</button>
          <button className="btn ghost" onClick={() => setForm({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: '', model: p.model })}>Edit</button>
          <button className="btn ghost danger" onClick={async () => { await api.del(`/api/ai/providers/${p.id}`); void load(); }}>Delete</button>
        </div>
      ))}

      {form ? (
        <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 14, margin: '10px 0' }}>
          <div className="field-row">
            <div className="field"><label>Name</label>
              <input className="text-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="OpenRouter" /></div>
            <div className="field"><label>Default model</label>
              <input className="text-input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="gpt-4.1-mini" /></div>
          </div>
          <div className="field"><label>Base URL (ending in /v1)</label>
            <input className="text-input" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" /></div>
          <div className="field"><label>API key {form.id ? '(blank = keep current)' : ''}</label>
            <input className="text-input" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => void saveProvider()}>Save provider</button>
            <button className="btn ghost" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn" style={{ margin: '8px 0' }} onClick={() => setForm({ name: '', baseUrl: '', apiKey: '', model: '' })}>Add provider</button>
      )}

      <h3>Feature mapping</h3>
      <table className="tbl">
        <thead><tr><th>Feature</th><th>Provider</th><th>Model override</th><th>On</th></tr></thead>
        <tbody>
          {tasks.map((t) => {
            const meta = TASKS.find((x) => x.task === t.task)!;
            return (
              <tr key={t.task}>
                <td><strong>{meta.label}</strong><div style={{ fontSize: 11.5, color: 'var(--md-text-faint)' }}>{meta.desc}</div></td>
                <td>
                  <select className="text-input" value={t.provider_id ?? ''} onChange={(e) => patchTask(t.task, { provider_id: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">—</option>
                    {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </td>
                <td><input className="text-input" value={t.model} placeholder="(provider default)" onChange={(e) => patchTask(t.task, { model: e.target.value })} /></td>
                <td><input type="checkbox" checked={!!t.enabled} onChange={(e) => patchTask(t.task, { enabled: e.target.checked ? 1 : 0 })} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
