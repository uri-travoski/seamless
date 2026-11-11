/** Settings → Storage → "Move to another bucket" (T3 F-27): wizard, progress, retry, switch back, clean up. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { formatBytes } from '../Sidebar.tsx';

type Role = 'mail' | 'backup';
interface Target { id: number; role: string; bucket: string; provider: string; active: boolean }
interface Migration {
  id: number; role: Role; kind: 'forward' | 'rollback'; mode: string; status: string; sourceBucket: string; destBucket: string;
  totalItems: number; totalBytes: number; copiedItems: number; copiedBytes: number; verifiedItems: number;
  bytesPerSecond: number; etaMs: number | null; error: string | null; retainUntil: number | null;
  canRollback: boolean; canCleanup: boolean; cleanedAt: number | null; failures?: { key: string; error: string | null }[];
}

const LABEL: Record<string, string> = {
  planning: 'Making a list…', copying: 'Copying', verifying: 'Checking the copy', switching: 'Switching over', completed: 'Finished',
  failed: 'Stopped — some objects could not be copied', failed_verify: 'Stopped — the check found a problem (nothing was switched)',
  cancelled: 'Cancelled', rolled_back: 'Switched back',
};
const running = (s: string) => ['planning', 'copying', 'verifying', 'switching'].includes(s);
const dur = (ms: number | null) => (ms == null ? '' : ms < 90_000 ? `${Math.ceil(ms / 1000)} s` : `${Math.ceil(ms / 60_000)} min`);

export default function StorageMigration({ targets, onChanged }: { targets: Target[]; onChanged: () => void }) {
  const [list, setList] = useState<Migration[]>([]);
  const [open, setOpen] = useState<Migration | null>(null);
  const [role, setRole] = useState<Role>('mail');
  const [dest, setDest] = useState<number | ''>('');
  const [strict, setStrict] = useState(false);
  const [plan, setPlan] = useState<{ objects: number; bytes: number; etaMs: number } | null>(null);
  const [typed, setTyped] = useState('');
  const [wizard, setWizard] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ migrations: Migration[] }>('/api/storage/migrations');
      setList(r.migrations);
      const focus = r.migrations.find((m) => running(m.status)) ?? r.migrations[0];
      if (focus) setOpen(await api.get<Migration>(`/api/storage/migrations/${focus.id}`));
    } catch { /* admin-only page; errors already toasted elsewhere */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // poll while something is running
  useEffect(() => {
    if (!open || !running(open.status)) return;
    const t = setInterval(() => { void load().then(onChanged); }, 2000);
    return () => clearInterval(t);
  }, [open, load, onChanged]);

  const candidates = targets.filter((t) => t.role === role && !t.active);
  useEffect(() => { setDest(candidates[0]?.id ?? ''); setPlan(null); }, [role, targets.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (wizard) api.get<typeof plan>(`/api/storage/migrations/plan?role=${role}`).then(setPlan).catch(() => setPlan(null)); }, [wizard, role]);

  const call = async (path: string, body?: unknown, ok?: string) => {
    setBusy(true);
    try { await api.post(path, body ?? {}); if (ok) toast(ok); await load(); onChanged(); }
    catch (e: any) { toast(e?.message ?? 'That did not work', 'error'); }
    setBusy(false);
  };

  const start = async () => {
    if (dest === '') return;
    await call('/api/storage/migrations', { role, toTargetId: dest, mode: strict ? 'strict' : 'sample' }, 'Migration started');
    setWizard(false);
  };

  const pct = open && open.totalItems ? Math.round(((open.status === 'verifying' ? open.verifiedItems : open.copiedItems) / open.totalItems) * 100) : 0;

  return (
    <section className="health-card ok" style={{ marginTop: 12 }}>
      <h3>Moving to another bucket</h3>
      <p className="hint">
        Copies everything to the new bucket, checks the copy, then switches over. Your old bucket is kept untouched for 14 days so you
        can switch back. Nothing is ever deleted automatically.
      </p>

      {open && (
        <div style={{ margin: '8px 0' }}>
          <strong>{open.kind === 'rollback' ? 'Switch back' : 'Migration'}: <code>{open.sourceBucket}</code> → <code>{open.destBucket}</code></strong>
          <div>{LABEL[open.status] ?? open.status}</div>
          {(running(open.status) || open.status === 'completed') && (
            <>
              <div className="progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
                style={{ height: 8, borderRadius: 4, background: 'var(--md-border)', margin: '6px 0', overflow: 'hidden' }}>
                <div style={{ width: `${open.status === 'completed' ? 100 : pct}%`, height: '100%', background: 'var(--color-success)' }} />
              </div>
              <div className="hint">
                {open.copiedItems.toLocaleString()} of {open.totalItems.toLocaleString()} objects · {formatBytes(open.copiedBytes)} of {formatBytes(open.totalBytes)}
                {open.bytesPerSecond > 0 && running(open.status) && <> · {formatBytes(open.bytesPerSecond)}/s{open.etaMs ? ` · about ${dur(open.etaMs)} left` : ''}</>}
              </div>
            </>
          )}
          {open.error && <div className="health-note">{open.error}</div>}
          {!!open.failures?.length && (
            <ul className="health-list">{open.failures.slice(0, 5).map((f) => <li key={f.key}><code>{f.key}</code> — {f.error}</li>)}</ul>
          )}
          <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {['failed', 'failed_verify'].includes(open.status) && <button className="btn small" disabled={busy} onClick={() => void call(`/api/storage/migrations/${open.id}/retry`, {}, 'Retrying')}>Retry failed objects</button>}
            {(running(open.status) && open.status !== 'switching' || ['failed', 'failed_verify'].includes(open.status)) && <button className="btn ghost small" disabled={busy} onClick={() => void call(`/api/storage/migrations/${open.id}/cancel`, {}, 'Cancelled — nothing was changed')}>Cancel</button>}
            {open.canRollback && <button className="btn ghost small" disabled={busy} onClick={() => { if (confirm('Switch back to the old bucket? New mail is copied back first.')) void call(`/api/storage/migrations/${open.id}/rollback`, {}, 'Switching back'); }}>Switch back to {open.sourceBucket}</button>}
          </div>
          {open.status === 'completed' && open.kind === 'forward' && open.retainUntil && !open.cleanedAt && (
            <div className="hint" style={{ marginTop: 8 }}>
              The old bucket <code>{open.sourceBucket}</code> is kept until {new Date(open.retainUntil).toLocaleDateString()}.
              {open.canCleanup && (
                <div style={{ marginTop: 6 }}>
                  To delete its copies, type the bucket name: <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={open.sourceBucket} />{' '}
                  <button className="btn small" disabled={busy || typed !== open.sourceBucket} onClick={() => void call(`/api/storage/migrations/${open.id}/cleanup`, { bucket: typed }, 'Old storage cleaned up')}>Clean up old storage</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {!wizard && !(open && running(open.status)) && <button className="btn small" onClick={() => setWizard(true)}>Move to another bucket…</button>}
      {wizard && (
        <div style={{ marginTop: 8 }}>
          <label>What to move{' '}
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="mail">Mail</option><option value="backup">Backups</option>
            </select>
          </label>
          <div style={{ margin: '6px 0' }}>
            {candidates.length === 0
              ? <p className="dim">Add the new {role === 'mail' ? 'mail' : 'backup'} storage below first (it is tested when you save it), then come back.</p>
              : <label>Move to{' '}<select value={dest} onChange={(e) => setDest(Number(e.target.value))}>{candidates.map((t) => <option key={t.id} value={t.id}>{t.bucket} ({t.provider})</option>)}</select></label>}
          </div>
          {plan && <p className="hint">{plan.objects.toLocaleString()} objects{plan.bytes ? `, about ${formatBytes(plan.bytes)}` : ''} · roughly {dur(plan.etaMs)}</p>}
          <label className="hint"><input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} /> Check every object byte by byte (slower, safest)</label>
          <div style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={busy || dest === ''} onClick={() => void start()}>Start</button>{' '}
            <button className="btn ghost" onClick={() => setWizard(false)}>Cancel</button>
          </div>
        </div>
      )}
      {list.length > 1 && <details style={{ marginTop: 8 }}><summary className="hint">History</summary>
        <ul className="health-list">{list.map((m) => <li key={m.id}>{m.kind === 'rollback' ? 'Switch back' : 'Move'} {m.sourceBucket} → {m.destBucket}: {LABEL[m.status] ?? m.status}</li>)}</ul></details>}
    </section>
  );
}
