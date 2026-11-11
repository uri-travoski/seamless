/** Settings → Sending (T3 F-22): outbound transports (SMTP relays and API providers). Secrets are write-only. */
import { useCallback, useEffect, useState } from 'react';
import type { ApiTransport, TransportKind, TransportTestResult } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

interface FieldDef { key: string; label: string; secret?: boolean; placeholder?: string; type?: 'select' | 'checkbox' | 'number'; options?: [string, string][] }
const KINDS: { kind: TransportKind; name: string; help: string; fields: FieldDef[] }[] = [
  { kind: 'smtp', name: 'SMTP relay', help: 'Any SMTP server or a preset (Brevo, SendGrid, SES, Mailgun SMTP…).', fields: [
    { key: 'preset', label: 'Preset', type: 'select', options: [['custom', 'Custom'], ['gmail', 'Gmail'], ['outlook', 'Outlook / 365'], ['icloud', 'iCloud'], ['zoho', 'Zoho'], ['fastmail', 'Fastmail'], ['brevo', 'Brevo SMTP'], ['sendgrid', 'SendGrid SMTP'], ['ses', 'Amazon SES SMTP'], ['mailgun', 'Mailgun SMTP']] },
    { key: 'host', label: 'Host (blank = preset)' }, { key: 'port', label: 'Port', type: 'number' }, { key: 'secure', label: 'Use TLS from the start (port 465)', type: 'checkbox' },
    { key: 'user', label: 'User name' }, { key: 'pass', label: 'Password', secret: true },
  ] },
  { kind: 'sendgrid', name: 'SendGrid', help: 'API key needs the "Mail Send" permission.', fields: [{ key: 'apiKey', label: 'API key', secret: true }] },
  { kind: 'brevo', name: 'Brevo', help: 'API key from Brevo → SMTP & API. The sender address must be verified in Brevo.', fields: [{ key: 'apiKey', label: 'API key', secret: true }] },
  { kind: 'ses', name: 'Amazon SES', help: 'IAM user with ses:SendEmail. The From address or domain must be verified.', fields: [
    { key: 'region', label: 'Region', placeholder: 'ap-southeast-2' }, { key: 'accessKeyId', label: 'Access key ID', secret: true },
    { key: 'secretAccessKey', label: 'Secret access key', secret: true }, { key: 'configurationSet', label: 'Configuration set (optional)' },
  ] },
  { kind: 'mailgun', name: 'Mailgun', help: 'Private API key and a verified sending domain.', fields: [
    { key: 'apiKey', label: 'API key', secret: true }, { key: 'domain', label: 'Sending domain', placeholder: 'mg.example.com' },
    { key: 'region', label: 'Region', type: 'select', options: [['us', 'US'], ['eu', 'EU']] },
  ] },
  { kind: 'postmark', name: 'Postmark', help: 'Server API token of the server that owns your sender signature.', fields: [
    { key: 'serverToken', label: 'Server token', secret: true }, { key: 'messageStream', label: 'Message stream', placeholder: 'outbound' },
  ] },
];

interface DnsRecord { id: string; name: string; type: string; expected: string; found: string[]; ok: boolean; informational: boolean; hint?: string }
const DNS_LABEL: Record<string, string> = { spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC', mx: 'MX', 'mta-sts': 'MTA-STS', 'tls-rpt': 'TLS-RPT' };

/** "Check DNS" for one provider: SPF/DKIM/DMARC pass or fail, MX/MTA-STS/TLS-RPT for information. */
function DnsCheck({ transportId }: { transportId: number }) {
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState('');
  const [selectors, setSelectors] = useState('');
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<DnsRecord[] | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const qs = new URLSearchParams({ domain: domain.trim(), transportId: String(transportId) });
      if (selectors.trim()) qs.set('selectors', selectors.trim());
      setRecords((await api.get<{ records: DnsRecord[] }>(`/api/dns-check?${qs}`)).records);
    } catch (e: any) { toast(e?.message ?? 'Could not check DNS', 'error'); }
    setBusy(false);
  };
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>Check DNS</button>;
  return (
    <div className="dns-panel" style={{ flexBasis: '100%' }}>
      <div className="field"><label>Your sending domain</label>
        <input className="text-input" value={domain} placeholder="example.com" onChange={(e) => setDomain(e.target.value)} /></div>
      <div className="field"><label>DKIM selectors (optional, comma separated)</label>
        <input className="text-input" value={selectors} placeholder="provider default" onChange={(e) => setSelectors(e.target.value)} /></div>
      <button className="btn primary" disabled={busy || !domain.trim()} onClick={() => void run()}>{busy ? 'Checking…' : 'Check'}</button>{' '}
      <button className="btn ghost" onClick={() => setOpen(false)}>Close</button>
      {records && records.map((r, i) => (
        <div key={i} className={`dns-row ${r.informational ? 'info' : r.ok ? 'ok' : 'bad'}`}>
          <span>{r.ok ? '✓' : r.informational ? '–' : '✗'}</span>
          <strong>{DNS_LABEL[r.id] ?? r.id}{r.informational ? ' (info)' : ''}</strong>
          <span><code>{r.name}</code> {r.type}
            {r.found.length > 0 ? <div className="dim">Found: <code>{r.found.join(' | ')}</code></div> : <div className="dim">Not found</div>}
            {!r.ok && !r.informational && <div className="dim">Expected: <code>{r.expected}</code>{r.hint ? ` — ${r.hint}` : ''}</div>}</span>
        </div>
      ))}
    </div>
  );
}

interface Draft { id?: number; kind: TransportKind; name: string; config: Record<string, any>; fallbackId: number | null; dailyLimit: string; hadSecret: boolean }

export default function SendingSettings() {
  const [list, setList] = useState<ApiTransport[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [results, setResults] = useState<Record<number, TransportTestResult | 'busy'>>({});
  const load = useCallback(() => { api.get<ApiTransport[]>('/api/transports').then(setList).catch(() => {}); }, []);
  useEffect(load, [load]);

  const test = async (id: number) => {
    setResults((r) => ({ ...r, [id]: 'busy' }));
    try { const res = await api.post<TransportTestResult>(`/api/transports/${id}/test`); setResults((r) => ({ ...r, [id]: res })); }
    catch { setResults((r) => ({ ...r, [id]: { ok: false, steps: [{ name: 'Request', ok: false, detail: 'Could not reach the server' }] } })); }
  };
  const remove = async (t: ApiTransport) => {
    if (!window.confirm(`Delete “${t.name}”? Mailboxes using it go back to their own SMTP.`)) return;
    await api.del(`/api/transports/${t.id}`); load();
  };
  const save = async () => {
    if (!draft) return;
    const body = { kind: draft.kind, name: draft.name, config: draft.config, fallbackId: draft.fallbackId, dailyLimit: draft.dailyLimit ? Number(draft.dailyLimit) : null };
    try {
      if (draft.id) await api.put(`/api/transports/${draft.id}`, body); else await api.post('/api/transports', body);
      setDraft(null); load(); toast('Saved');
    } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
  };

  if (draft) {
    const def = KINDS.find((k) => k.kind === draft.kind)!;
    const setCfg = (k: string, v: unknown) => setDraft({ ...draft, config: { ...draft.config, [k]: v } });
    return (
      <div>
        <h2>{draft.id ? 'Edit' : 'Add'} sending provider</h2>
        <p className="settings-desc">{def.help}</p>
        {!draft.id && (
          <div className="field"><label>Type</label>
            <select className="text-input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as TransportKind, config: {} })}>
              {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.name}</option>)}
            </select></div>
        )}
        <div className="field"><label>Name</label>
          <input className="text-input" value={draft.name} placeholder={def.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
        {def.fields.map((fd) => (
          <div className="field" key={fd.key}>
            {fd.type === 'checkbox'
              ? <label className="checkbox-line"><input type="checkbox" checked={!!draft.config[fd.key]} onChange={(e) => setCfg(fd.key, e.target.checked)} /> {fd.label}</label>
              : <>
                <label>{fd.label}</label>
                {fd.type === 'select'
                  ? <select className="text-input" value={draft.config[fd.key] ?? fd.options![0][0]} onChange={(e) => setCfg(fd.key, e.target.value)}>
                    {fd.options!.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
                  : <input className="text-input" type={fd.secret ? 'password' : fd.type === 'number' ? 'number' : 'text'} autoComplete="off"
                    value={draft.config[fd.key] ?? ''} placeholder={fd.secret && draft.hadSecret ? '•••••• (leave blank to keep)' : fd.placeholder}
                    onChange={(e) => setCfg(fd.key, fd.type === 'number' ? Number(e.target.value) || '' : e.target.value)} />}
              </>}
          </div>
        ))}
        <div className="field"><label>If this fails (rate limit, outage), try</label>
          <select className="text-input" value={draft.fallbackId ?? ''} onChange={(e) => setDraft({ ...draft, fallbackId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Nothing — report the failure</option>
            {list.filter((t) => t.id !== draft.id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></div>
        <div className="field"><label>Daily limit (optional, messages per day)</label>
          <input className="text-input" type="number" min={0} value={draft.dailyLimit} onChange={(e) => setDraft({ ...draft, dailyLimit: e.target.value })} /></div>
        <div className="wizard-foot">
          <button className="btn ghost" onClick={() => setDraft(null)}>Cancel</button>
          <div style={{ flex: 1 }} />
          <button className="btn primary" disabled={!draft.name.trim()} onClick={() => void save()}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2>Sending</h2>
      <p className="settings-desc">
        By default each mailbox sends through its own SMTP server. Add a provider here (SendGrid, Brevo, Amazon SES, Mailgun, Postmark or an SMTP relay),
        then pick it for a mailbox under Settings → Mailboxes → Edit → “Send through”. A fallback is tried once if the first one is down or rate-limited.
      </p>
      {list.length === 0 && <p className="dim">No providers yet.</p>}
      <div className="mbx-cards">
        {list.map((t) => {
          const res = results[t.id];
          return (
            <div key={t.id} className="mbx-card">
              <div className="mbx-main">
                <strong>{t.name}</strong> <span className="dim">{KINDS.find((k) => k.kind === t.kind)?.name ?? t.kind}</span>
                {t.fallbackId && <div className="dim">Fallback: {list.find((x) => x.id === t.fallbackId)?.name ?? '—'}</div>}
                {t.dailyLimit && <div className="dim">Limit: {t.dailyLimit} per day</div>}
                {res && res !== 'busy' && (
                  <ul className="test-steps">
                    {res.steps.map((s, i) => <li key={i} className={s.ok ? 'ok' : 'bad'}>{s.ok ? '✓' : '✗'} {s.name}{s.detail ? ` — ${s.detail}` : ''}</li>)}
                  </ul>
                )}
              </div>
              <div className="mbx-actions">
                <DnsCheck transportId={t.id} />
                <button className="btn" disabled={res === 'busy'} onClick={() => void test(t.id)}>{res === 'busy' ? 'Testing…' : 'Test'}</button>
                <button className="btn" onClick={() => setDraft({ id: t.id, kind: t.kind, name: t.name, config: { ...t.config }, fallbackId: t.fallbackId, dailyLimit: t.dailyLimit ? String(t.dailyLimit) : '', hadSecret: t.hasApiKey })}>Edit</button>
                <button className="btn ghost" onClick={() => void remove(t)}>Delete</button>
              </div>
            </div>
          );
        })}
      </div>
      <button className="btn primary" onClick={() => setDraft({ kind: 'sendgrid', name: '', config: {}, fallbackId: null, dailyLimit: '', hadSecret: false })}>Add provider</button>
    </div>
  );
}
