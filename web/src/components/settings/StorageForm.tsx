/** One storage-target form (provider prefill + the 7-step test), shared by Settings → Storage and the first-run setup. */
import { useState } from 'react';
import { api } from '../../api/client.ts';

export interface Provider { name: string; endpoint: string; region: string; pathStyle: boolean }
export interface TestStep { id: string; name: string; status: 'ok' | 'warn' | 'fail' | 'skipped'; ms: number; detail: string }
export interface TestResult { ok: boolean; warnings: number; steps: TestStep[]; latencyMs: number }
export type Role = 'mail' | 'backup' | 'spool' | 'archive_source';

export const PROVIDERS: Record<string, Provider> = {
  r2: { name: 'Cloudflare R2', endpoint: 'https://<accountid>.r2.cloudflarestorage.com', region: 'auto', pathStyle: false },
  b2: { name: 'Backblaze B2', endpoint: 'https://s3.<region>.backblazeb2.com', region: 'us-west-004', pathStyle: false },
  s3: { name: 'Amazon S3', endpoint: 'https://s3.<region>.amazonaws.com', region: 'us-east-1', pathStyle: false },
  wasabi: { name: 'Wasabi', endpoint: 'https://s3.<region>.wasabisys.com', region: 'us-east-1', pathStyle: false },
  spaces: { name: 'DigitalOcean Spaces', endpoint: 'https://<region>.digitaloceanspaces.com', region: 'nyc3', pathStyle: false },
  hetzner: { name: 'Hetzner Object Storage', endpoint: 'https://<region>.your-objectstorage.com', region: 'fsn1', pathStyle: false },
  minio: { name: 'MinIO', endpoint: 'http://localhost:9000', region: 'us-east-1', pathStyle: true },
  other: { name: 'Other S3-compatible', endpoint: '', region: 'us-east-1', pathStyle: true },
};

export interface FormValue {
  provider: string; endpoint: string; region: string; bucket: string; prefix: string;
  forcePathStyle: boolean; accessKey: string; secretKey: string; acceptSameBucket: boolean;
}

export const emptyForm = (role: Role, provider = 'r2'): FormValue => ({
  provider, endpoint: '', region: PROVIDERS[provider].region, bucket: '', prefix: role === 'spool' || role === 'archive_source' ? '' : 'seamless/',
  forcePathStyle: PROVIDERS[provider].pathStyle, accessKey: '', secretKey: '', acceptSameBucket: false,
});

const ICON: Record<TestStep['status'], string> = { ok: '✓', warn: '!', fail: '✗', skipped: '–' };

export function TestSteps({ result }: { result: TestResult }) {
  return (
    <ul className="health-list" aria-label="Storage test results">
      {result.steps.map((s) => (
        <li key={s.id} className={s.status === 'fail' ? 'health-note red' : 'health-note'}>
          <strong>{ICON[s.status]}</strong> {s.name}{s.status !== 'skipped' && s.ms ? ` · ${s.ms} ms` : ''}{s.detail ? ` — ${s.detail}` : ''}
        </li>
      ))}
    </ul>
  );
}

export default function StorageForm({ role, value, onChange, editing, testUrl = '/api/storage/targets/test' }: {
  role: Role; value: FormValue; onChange: (v: FormValue) => void; editing?: boolean; testUrl?: string;
}) {
  const [result, setResult] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (p: Partial<FormValue>) => onChange({ ...value, ...p });
  const pickProvider = (provider: string) => set({ provider, region: PROVIDERS[provider].region, forcePathStyle: PROVIDERS[provider].pathStyle, endpoint: '' });
  const hint = PROVIDERS[value.provider].endpoint;

  const test = async () => {
    setBusy(true); setErr(''); setResult(null);
    try { setResult(await api.post<TestResult>(testUrl, { role, ...value })); }
    catch (e: any) { setErr(e?.message ?? 'Test failed'); }
    setBusy(false);
  };

  return (
    <div className="dns-panel">
      <div className="field"><label>Provider</label>
        <select value={value.provider} onChange={(e) => pickProvider(e.target.value)} disabled={editing}>
          {Object.entries(PROVIDERS).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
        </select></div>
      <div className="field"><label>Endpoint</label>
        <input className="text-input" value={value.endpoint} placeholder={hint} onChange={(e) => set({ endpoint: e.target.value })} />
        {hint && <div className="hint">Looks like <code>{hint}</code></div>}</div>
      <div className="field-row">
        <div className="field"><label>Region</label><input className="text-input" value={value.region} onChange={(e) => set({ region: e.target.value })} /></div>
        <div className="field"><label>Bucket</label><input className="text-input" value={value.bucket} onChange={(e) => set({ bucket: e.target.value })} disabled={editing} /></div>
      </div>
      <div className="field"><label>Folder (prefix){role === 'spool' ? ' — leave empty for the Worker default' : ''}</label>
        <input className="text-input" value={value.prefix} onChange={(e) => set({ prefix: e.target.value })} /></div>
      <div className="field-row">
        <div className="field"><label>Access key{editing ? ' (blank = keep)' : ''}</label>
          <input className="text-input" autoComplete="off" value={value.accessKey} onChange={(e) => set({ accessKey: e.target.value })} /></div>
        <div className="field"><label>Secret key{editing ? ' (blank = keep)' : ''}</label>
          <input className="text-input" type="password" autoComplete="new-password" value={value.secretKey} onChange={(e) => set({ secretKey: e.target.value })} /></div>
      </div>
      <label className="check"><input type="checkbox" checked={value.forcePathStyle} onChange={(e) => set({ forcePathStyle: e.target.checked })} /> Path-style URLs (MinIO and some others)</label>
      {role === 'backup' && (
        <label className="check"><input type="checkbox" checked={value.acceptSameBucket} onChange={(e) => set({ acceptSameBucket: e.target.checked })} />
          {' '}I accept using the same bucket as my mail (a backup in the same place is lost with it)</label>
      )}
      <div style={{ marginTop: 8 }}>
        <button className="btn" disabled={busy || !value.endpoint || !value.bucket || (!editing && (!value.accessKey || !value.secretKey))} onClick={() => void test()}>
          {busy ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {err && <div className="health-note red">{err}</div>}
      {result && <TestSteps result={result} />}
      {result && !result.ok && <div className="health-note red">Fix the failed step, then test again.</div>}
    </div>
  );
}
