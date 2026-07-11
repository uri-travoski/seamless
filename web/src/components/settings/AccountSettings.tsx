import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { useMail } from '../../state/mail.ts';
import { useCompose } from '../../state/compose.ts';

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
      <p className="settings-desc">Each account syncs over IMAP and sends through its own SMTP server. Messages are archived as .eml in your S3 bucket.</p>
      <table className="tbl">
        <thead><tr><th></th><th>Email</th><th>IMAP</th><th>SMTP</th><th></th></tr></thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td><span className="acct-dot" style={{ background: a.color, display: 'inline-block' }} /></td>
              <td>{a.email}{a.name ? ` (${a.name})` : ''}</td>
              <td>{a.imapHost}:{a.imapPort}</td>
              <td>{a.smtpHost}:{a.smtpPort}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn ghost" onClick={() => openEdit(a)}>Edit</button>
                <button className="btn ghost danger" onClick={() => void remove(a.id)}>Remove</button>
              </td>
            </tr>
          ))}
          {accounts.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--md-text-faint)' }}>No accounts yet.</td></tr>}
        </tbody>
      </table>
      <button className="btn primary" style={{ marginTop: 14 }} onClick={() => openEdit()}>Add account</button>
    </div>
  );
}
