import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { useMail } from '../../state/mail.ts';
import { useCompose } from '../../state/compose.ts';
import { useSession } from '../../state/session.ts';

/** Google / Microsoft connect buttons + (admin) the one-time OAuth app registration. */
function OauthSection({ onConnected }: { onConnected: () => void }) {
  const me = useSession((s) => s.user);
  const [apps, setApps] = useState<{ provider: string; clientId: string }[]>([]);
  const [editing, setEditing] = useState<'google' | 'microsoft' | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirect, setRedirect] = useState('');

  const load = () => { if (me?.role === 'admin') void api.get<any[]>('/api/oauth/apps').then(setApps).catch(() => {}); };
  useEffect(load, [me?.role]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.seamlessOauth) {
        toast(String(e.data.seamlessOauth), String(e.data.seamlessOauth).startsWith('Connected') ? 'info' : 'error');
        onConnected();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const connect = async (provider: 'google' | 'microsoft') => {
    try {
      const { url } = await api.get<{ url: string }>(`/api/oauth/${provider}/start`);
      window.open(url, 'seamless-oauth', 'width=560,height=720');
    } catch (e: any) {
      toast(e?.message ?? 'OAuth not configured', 'error');
    }
  };

  const saveApp = async () => {
    if (!editing) return;
    try {
      const res = await api.put<{ redirectUri: string }>(`/api/oauth/apps/${editing}`, { clientId, clientSecret });
      setRedirect(res.redirectUri);
      toast(`${editing} app saved`);
      setEditing(null); setClientId(''); setClientSecret('');
      load();
    } catch (e: any) { toast(e?.message ?? 'Save failed', 'error'); }
  };

  const configured = (p: string) => apps.some((a) => a.provider === p);

  return (
    <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 12, margin: '14px 0' }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Connect a provider account (OAuth)</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => void connect('google')}>Connect Gmail</button>
        <button className="btn" onClick={() => void connect('microsoft')}>Connect Microsoft / Outlook</button>
        {me?.role === 'admin' && (
          <>
            <button className="btn ghost" onClick={() => { setEditing('google'); setClientId(apps.find((a) => a.provider === 'google')?.clientId ?? ''); }}>
              {configured('google') ? 'Google app ✓' : 'Set up Google app'}
            </button>
            <button className="btn ghost" onClick={() => { setEditing('microsoft'); setClientId(apps.find((a) => a.provider === 'microsoft')?.clientId ?? ''); }}>
              {configured('microsoft') ? 'Microsoft app ✓' : 'Set up Microsoft app'}
            </button>
          </>
        )}
      </div>
      {editing && (
        <div style={{ marginTop: 10 }}>
          <p className="settings-desc" style={{ marginTop: 0 }}>
            {editing === 'google'
              ? 'Google Cloud Console → APIs & Services → Credentials → OAuth client (Web application). Enable the Gmail API. Add the redirect URI shown after saving.'
              : 'Azure Portal → App registrations → New (any org + personal accounts). Add a Web redirect URI (shown after saving). Under API permissions add IMAP.AccessAsUser.All and SMTP.Send (delegated). Create a client secret.'}
          </p>
          <div className="field-row">
            <div className="field" style={{ flex: 2 }}><label>Client ID</label>
              <input className="text-input" value={clientId} onChange={(e) => setClientId(e.target.value)} /></div>
            <div className="field" style={{ flex: 2 }}><label>Client secret</label>
              <input className="text-input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" disabled={!clientId || !clientSecret} onClick={() => void saveApp()}>Save {editing} app</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
      {redirect && <p style={{ fontSize: 12.5, marginTop: 8 }}>Redirect URI to register: <code>{redirect}</code></p>}
    </div>
  );
}

/** Per-account safe delete: origin cleanup after verified archive. */
function SafeDeletePanel({ account, onClose, onSaved }: { account: any; onClose: () => void; onSaved: () => void }) {
  const [enabled, setEnabled] = useState<boolean>(account.safeDeleteEnabled);
  const [mode, setMode] = useState<string>(account.safeDeleteMode ?? 'trash');
  const [graceDays, setGraceDays] = useState<number>(account.safeDeleteGraceDays ?? 30);
  const [preview, setPreview] = useState<{ count: number; oldest: string | null } | null>(null);

  useEffect(() => {
    void api.get<{ count: number; oldest: string | null }>(`/api/accounts/${account.id}/safe-delete/preview`).then(setPreview).catch(() => {});
  }, [account.id]);

  const save = async () => {
    if (enabled && !account.safeDeleteEnabled) {
      const ok = window.confirm(
        `Safe delete will REMOVE mail from ${account.email} at the provider once each message is verifiably archived in Seamless and older than ${graceDays} days.\n\n` +
        `${mode === 'trash' ? 'Messages go to the provider Trash first (recoverable there ~30 days).' : 'Messages are expunged immediately at the provider.'}\n\nEnable?`);
      if (!ok) return;
    }
    await api.put(`/api/accounts/${account.id}/safe-delete`, { enabled, mode, graceDays });
    toast(enabled ? 'Safe delete enabled — runs hourly' : 'Safe delete disabled');
    onSaved(); onClose();
  };

  return (
    <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>Safe delete — {account.email}</div>
      <p className="settings-desc">
        Frees space at the provider: once a message is verifiably archived here (checksum-verified copy in your S3
        bucket) and older than the grace window, it is removed from the origin mailbox. Seamless keeps the archive copy forever.
      </p>
      <label className="checkbox-line">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Remove imported mail from the origin server
      </label>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', margin: '8px 0', fontSize: 13 }}>
        <label>Origin keeps the last
          <input className="text-input" type="number" min={1} style={{ width: 70, margin: '0 6px' }}
            value={graceDays} onChange={(e) => setGraceDays(Number(e.target.value) || 30)} />
          days</label>
        <select className="text-input" style={{ width: 'auto' }} value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="trash">Move to origin Trash (second safety net)</option>
          <option value="expunge">Expunge at origin immediately</option>
        </select>
      </div>
      {preview && (
        <p style={{ fontSize: 12.5, color: 'var(--md-text-soft)' }}>
          A run right now would remove <b>{preview.count}</b> messages from the origin
          {preview.oldest ? ` (oldest: ${new Date(preview.oldest).toLocaleDateString()})` : ''}.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" onClick={() => void save()}>Save</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/** Learn-from-Gmail onboarding: analyse labelled history, propose rules, seed the AI memory. */
function GmailLearnPanel({ account, onClose }: { account: any; onClose: () => void }) {
  const [importId, setImportId] = useState<number | null>(null);
  const [status, setStatus] = useState<string>('');
  const [stats, setStats] = useState<any>({});
  const [proposals, setProposals] = useState<any[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());

  const start = async () => {
    try {
      const res = await api.post<{ importId: number }>(`/api/gmail-learn/${account.id}`);
      setImportId(res.importId);
      setStatus('running');
    } catch (e: any) { toast(e?.message ?? 'Could not start', 'error'); }
  };

  useEffect(() => {
    if (!importId || status !== 'running') return;
    const t = setInterval(async () => {
      try {
        const s = await api.get<any>(`/api/gmail-learn/${importId}/status`);
        setStatus(s.status); setStats(s.stats);
        if (s.status === 'done') {
          setProposals(s.proposals);
          setPicked(new Set(s.proposals.map((_: any, i: number) => i)));
        }
      } catch { /* keep polling */ }
    }, 3000);
    return () => clearInterval(t);
  }, [importId, status]);

  const accept = async () => {
    try {
      const res = await api.post<{ created: number }>(`/api/gmail-learn/${importId}/accept`, { indexes: [...picked] });
      toast(`${res.created} rules created — re-classifying`);
      onClose();
    } catch (e: any) { toast(e?.message ?? 'Accept failed', 'error'); }
  };

  return (
    <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 12, marginTop: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>Learn from Gmail — {account.email}</div>
      <p className="settings-desc">
        Reads your existing Gmail labels and labelled mail (read-only), proposes deterministic rules for consistent
        senders, routes mixed senders to the AI, and seeds the similarity memory with your labelled history.
      </p>
      {!importId && <button className="btn primary" onClick={() => void start()}>Analyse my Gmail</button>}
      {status === 'running' && <p style={{ fontSize: 13 }}>Analysing… (progress in Settings → Logs)</p>}
      {status === 'error' && <p style={{ fontSize: 13, color: 'var(--md-danger)' }}>Failed: {stats.error}</p>}
      {status === 'done' && (
        <>
          <p style={{ fontSize: 13 }}>
            Analysed <b>{stats.samples}</b> messages → <b>{proposals.length}</b> proposals, seeded <b>{stats.seeded ?? 0}</b> embeddings.
          </p>
          <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--md-border)', borderRadius: 6 }}>
            {proposals.map((p, i) => (
              <label key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 8px', fontSize: 12.5, borderBottom: '1px solid var(--md-border)' }}>
                <input type="checkbox" checked={picked.has(i)} onChange={(e) => {
                  const next = new Set(picked); e.target.checked ? next.add(i) : next.delete(i); setPicked(next);
                }} />
                <span style={{ flex: 1 }}>
                  <b>{p.matchValue}</b> ({p.matchField === 'from_domain' ? 'domain' : 'sender'}) →{' '}
                  {p.kind === 'ai' ? <b style={{ color: 'var(--md-blue)' }}>AI decides</b> : p.label}
                </span>
                <span style={{ color: 'var(--md-text-faint)' }}>{p.evidence} msgs</span>
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn primary" disabled={picked.size === 0} onClick={() => void accept()}>Create {picked.size} rules</button>
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </div>
  );
}

interface AccountForm {
  id?: number;
  name: string; email: string; aliases: string;
  imapHost: string; imapPort: number; imapSecure: boolean; imapUser: string; imapPass: string;
  smtpHost: string; smtpPort: number; smtpSecure: boolean; smtpUser: string; smtpPass: string;
  color: string; sentCopy: boolean; aiCategorize: boolean;
}

const BLANK: AccountForm = {
  name: '', email: '', aliases: '',
  imapHost: '', imapPort: 993, imapSecure: true, imapUser: '', imapPass: '',
  smtpHost: '', smtpPort: 465, smtpSecure: true, smtpUser: '', smtpPass: '',
  color: '#2f7ed8', sentCopy: true, aiCategorize: false,
};

const COLORS = ['#2f7ed8', '#7a5fd0', '#d05f8e', '#d0755f', '#c9a13a', '#4d9e53', '#3a9e9e', '#5b6570'];

export default function AccountSettings() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [form, setForm] = useState<AccountForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [panel, setPanel] = useState<{ kind: 'safe' | 'learn'; id: number } | null>(null);

  const load = () => void api.get<any[]>('/api/accounts').then(setAccounts).catch(() => {});
  useEffect(load, []);

  const f = <K extends keyof AccountForm>(key: K, value: AccountForm[K]) => setForm({ ...form!, [key]: value });

  const openEdit = (a?: any) => {
    setTestResult('');
    if (!a) { setForm({ ...BLANK }); return; }
    setForm({
      id: a.id, name: a.name, email: a.email, aliases: (a.aliases ?? []).join(', '),
      imapHost: a.imapHost, imapPort: a.imapPort, imapSecure: a.imapSecure, imapUser: a.imapUser, imapPass: '',
      smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpSecure: a.smtpSecure, smtpUser: a.smtpUser, smtpPass: '',
      color: a.color, sentCopy: a.sentCopy, aiCategorize: a.aiCategorize,
    });
  };

  const body = () => ({
    ...form,
    aliases: form!.aliases.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
  });

  const test = async () => {
    setBusy(true); setTestResult('');
    try {
      await api.post('/api/accounts/test', body());
      setTestResult('✓ IMAP and SMTP connections OK');
    } catch (e: any) {
      setTestResult(`✗ ${e?.message ?? 'connection failed'}`);
    } finally { setBusy(false); }
  };

  const saveAccount = async () => {
    setBusy(true);
    try {
      if (form!.id) await api.put(`/api/accounts/${form!.id}`, body());
      else await api.post('/api/accounts', body());
      toast('Account saved — syncing');
      setForm(null);
      load();
      setTimeout(() => { void useMail.getState().boot(); void useCompose.getState().loadIdentities(); }, 1500);
    } catch (e: any) {
      toast(e?.message ?? 'Save failed', 'error');
    } finally { setBusy(false); }
  };

  const remove = async (id: number) => {
    if (!window.confirm('Remove this account? Local index and cached mail for it are deleted (server mailbox is untouched).')) return;
    await api.del(`/api/accounts/${id}`);
    load();
    void useMail.getState().boot();
  };

  if (form) {
    return (
      <div>
        <h2>{form.id ? 'Edit account' : 'Add account'}</h2>
        <div className="field-row">
          <div className="field"><label>Display name</label>
            <input className="text-input" value={form.name} onChange={(e) => f('name', e.target.value)} placeholder="Support" /></div>
          <div className="field"><label>Email address</label>
            <input className="text-input" value={form.email} onChange={(e) => f('email', e.target.value)} placeholder="support@company.com" /></div>
        </div>
        <div className="field"><label>Aliases (comma-separated — used for reply-from matching)</label>
          <input className="text-input" value={form.aliases} onChange={(e) => f('aliases', e.target.value)} placeholder="help@company.com, info@company.com" /></div>

        <h3>IMAP (incoming)</h3>
        <div className="field-row">
          <div className="field" style={{ flex: 2 }}><label>Host</label>
            <input className="text-input" value={form.imapHost} onChange={(e) => f('imapHost', e.target.value)} placeholder="imap.example.com" /></div>
          <div className="field"><label>Port</label>
            <input className="text-input" type="number" value={form.imapPort} onChange={(e) => f('imapPort', Number(e.target.value))} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>User</label>
            <input className="text-input" value={form.imapUser} onChange={(e) => f('imapUser', e.target.value)} /></div>
          <div className="field"><label>Password {form.id ? '(blank = keep current)' : ''}</label>
            <input className="text-input" type="password" value={form.imapPass} onChange={(e) => f('imapPass', e.target.value)} /></div>
        </div>
        <label className="checkbox-line">
          <input type="checkbox" checked={form.imapSecure} onChange={(e) => f('imapSecure', e.target.checked)} /> Use TLS (port 993)
        </label>

        <h3>SMTP (outgoing)</h3>
        <div className="field-row">
          <div className="field" style={{ flex: 2 }}><label>Host</label>
            <input className="text-input" value={form.smtpHost} onChange={(e) => f('smtpHost', e.target.value)} placeholder="smtp.example.com" /></div>
          <div className="field"><label>Port</label>
            <input className="text-input" type="number" value={form.smtpPort} onChange={(e) => f('smtpPort', Number(e.target.value))} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>User</label>
            <input className="text-input" value={form.smtpUser} onChange={(e) => f('smtpUser', e.target.value)} /></div>
          <div className="field"><label>Password {form.id ? '(blank = keep current)' : ''}</label>
            <input className="text-input" type="password" value={form.smtpPass} onChange={(e) => f('smtpPass', e.target.value)} /></div>
        </div>
        <label className="checkbox-line">
          <input type="checkbox" checked={form.smtpSecure} onChange={(e) => f('smtpSecure', e.target.checked)} /> Use TLS (465; uncheck for STARTTLS/587 or plain)
        </label>

        <h3>Options</h3>
        <div className="field"><label>Account color (unified inbox marker)</label>
          <div className="swatches">
            {COLORS.map((c) => (
              <button key={c} className={`swatch ${form.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => f('color', c)} aria-label={c} />
            ))}
          </div>
        </div>
        <label className="checkbox-line">
          <input type="checkbox" checked={form.sentCopy} onChange={(e) => f('sentCopy', e.target.checked)} />
          Save a copy to this account's Sent folder after sending (disable for Gmail — it saves automatically)
        </label>
        <label className="checkbox-line">
          <input type="checkbox" checked={form.aiCategorize} onChange={(e) => f('aiCategorize', e.target.checked)} />
          AI-categorize incoming mail into labels (needs an AI provider under Settings → AI)
        </label>

        <div style={{ display: 'flex', gap: 8, marginTop: 18, alignItems: 'center' }}>
          <button className="btn primary" disabled={busy} onClick={saveAccount}>Save account</button>
          <button className="btn" disabled={busy} onClick={test}>Test connection</button>
          <button className="btn ghost" onClick={() => setForm(null)}>Cancel</button>
          <span style={{ fontSize: 12.5, color: testResult.startsWith('✓') ? 'var(--md-ok)' : 'var(--md-danger)' }}>{testResult}</span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2>Accounts</h2>
      <p className="settings-desc">Each account syncs over IMAP (or OAuth for Gmail/Microsoft) and sends through its own outgoing server. Messages are archived as .eml in your S3 bucket.</p>
      <table className="tbl">
        <thead><tr><th></th><th>Email</th><th>Type</th><th>Safe delete</th><th></th></tr></thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td><span className="acct-dot" style={{ background: a.color, display: 'inline-block' }} /></td>
              <td>{a.email}{a.name ? ` (${a.name})` : ''}</td>
              <td>{a.kind === 'gmail' ? 'Gmail (OAuth)' : a.kind === 'microsoft' ? 'Microsoft (OAuth)' : `IMAP ${a.imapHost}:${a.imapPort}`}</td>
              <td>{a.safeDeleteEnabled ? `on (${a.safeDeleteGraceDays}d, ${a.safeDeleteMode})` : 'off'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {a.kind === 'imap' && <button className="btn ghost" onClick={() => openEdit(a)}>Edit</button>}
                <button className="btn ghost" onClick={() => setPanel(panel?.kind === 'safe' && panel.id === a.id ? null : { kind: 'safe', id: a.id })}>Safe delete</button>
                {a.kind === 'gmail' && <button className="btn ghost" onClick={() => setPanel(panel?.kind === 'learn' && panel.id === a.id ? null : { kind: 'learn', id: a.id })}>Learn</button>}
                <button className="btn ghost danger" onClick={() => void remove(a.id)}>Remove</button>
              </td>
            </tr>
          ))}
          {accounts.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--md-text-faint)' }}>No accounts yet.</td></tr>}
        </tbody>
      </table>
      {panel?.kind === 'safe' && accounts.find((a) => a.id === panel.id) && (
        <SafeDeletePanel account={accounts.find((a) => a.id === panel.id)} onClose={() => setPanel(null)} onSaved={load} />
      )}
      {panel?.kind === 'learn' && accounts.find((a) => a.id === panel.id) && (
        <GmailLearnPanel account={accounts.find((a) => a.id === panel.id)} onClose={() => setPanel(null)} />
      )}
      <OauthSection onConnected={() => { load(); void useMail.getState().boot(); }} />
      <button className="btn primary" onClick={() => openEdit()}>Add IMAP account</button>
    </div>
  );
}
