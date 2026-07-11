import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

interface Device { id: number; label: string; scopes: string[]; createdAt: string; lastUsedAt: string | null }
interface ServerInfo { imap: { host: string; port: number; tls: boolean }; smtp: { host: string; port: number; tls: boolean }; carddav: string }

export default function DevicesSettings() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<{ label: string; secret: string } | null>(null);

  const refresh = async () => {
    setDevices(await api.get<Device[]>('/api/devices'));
    setInfo(await api.get<ServerInfo>('/api/devices/server-info'));
  };
  useEffect(() => { void refresh(); }, []);

  const create = async () => {
    const res = await api.post<{ id: number; secret: string }>('/api/devices', { label: label || 'Device' });
    setFresh({ label: label || 'Device', secret: res.secret });
    setLabel('');
    await refresh();
  };

  const revoke = async (d: Device) => {
    if (!window.confirm(`Revoke "${d.label}"? The device stops syncing immediately.`)) return;
    await api.del(`/api/devices/${d.id}`);
    await refresh();
  };

  return (
    <div>
      <h2>Devices</h2>
      <p className="settings-desc">
        Standard mail apps (Thunderbird, iOS Mail, K-9…) connect to Seamless itself over IMAP/SMTP, and phones sync
        the addressbook over CardDAV. Create one app password per device; your login password never leaves the web app.
      </p>

      {info && (
        <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Server settings for your device</div>
          <table style={{ borderCollapse: 'collapse' }}><tbody>
            <tr><td style={{ paddingRight: 14, color: 'var(--md-text-soft)' }}>Incoming (IMAP)</td>
              <td><code>{info.imap.host}</code> port <code>{info.imap.port}</code>{info.imap.tls ? ', TLS' : ', no TLS (use on trusted networks or behind a TLS proxy)'}</td></tr>
            <tr><td style={{ paddingRight: 14, color: 'var(--md-text-soft)' }}>Outgoing (SMTP)</td>
              <td><code>{info.smtp.host}</code> port <code>{info.smtp.port}</code>, password auth</td></tr>
            <tr><td style={{ paddingRight: 14, color: 'var(--md-text-soft)' }}>Contacts (CardDAV)</td>
              <td><code>{info.carddav}</code></td></tr>
            <tr><td style={{ paddingRight: 14, color: 'var(--md-text-soft)' }}>Username</td><td>your Seamless login email</td></tr>
            <tr><td style={{ paddingRight: 14, color: 'var(--md-text-soft)' }}>Password</td><td>an app password from below</td></tr>
          </tbody></table>
        </div>
      )}

      {fresh && (
        <div style={{ border: '1px solid #cfe0cd', background: '#f2f8f1', borderRadius: 8, padding: 12, marginBottom: 14 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>App password for “{fresh.label}” — copy it now, it is not shown again</div>
          <code style={{ fontSize: 15, userSelect: 'all' }}>{fresh.secret}</code>
          <div style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => { void navigator.clipboard.writeText(fresh.secret); toast('Copied'); }}>Copy</button>
            <button className="btn ghost" onClick={() => setFresh(null)}>Done</button>
          </div>
        </div>
      )}

      {devices.map((d) => (
        <div key={d.id} className="cond-row">
          <span style={{ width: 200, fontWeight: 600 }}>{d.label}</span>
          <span style={{ width: 160, fontSize: 12, color: 'var(--md-text-soft)' }}>{d.scopes.join(' · ')}</span>
          <span style={{ flex: 1, fontSize: 12, color: 'var(--md-text-faint)' }}>
            {d.lastUsedAt ? `last used ${new Date(d.lastUsedAt).toLocaleString()}` : 'never used'}
          </span>
          <button className="btn ghost danger" onClick={() => void revoke(d)}>Revoke</button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input className="text-input" style={{ width: 260 }} placeholder='Device name, e.g. "iPhone Mail"'
          value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
        <button className="btn primary" onClick={() => void create()}>Create app password</button>
      </div>
    </div>
  );
}
