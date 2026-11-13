/** Settings → Security (T0 F-01/F-02): two-factor sign-in and active sessions. */
import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { useSession } from '../../state/session.ts';
import { ShieldIcon, CopyIcon, DevicesIcon } from '../../icons.tsx';

interface Status { totp: boolean; totpSince: number | null; recoveryCodesLeft: number; required: boolean }
interface Session { id: string; current: boolean; ip: string; userAgent: string; label?: string; createdAt: number; lastSeenAt: number | null; expiresAt: number | null }

function device(ua: string): string {
  if (!ua) return 'Unknown device';
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}

function Codes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="banner">
      <div>
        <strong>Save these recovery codes now.</strong> Each one signs you in once if you lose your phone. They won't be shown again.
        <pre className="code-block recovery">{codes.join('\n')}</pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => { void navigator.clipboard?.writeText(codes.join('\n')); toast('Copied'); }}><CopyIcon size={15} /> Copy</button>
          <button className="btn primary" onClick={onDone}>I've saved them</button>
        </div>
      </div>
    </div>
  );
}

export default function SecuritySettings() {
  const me = useSession((s) => s.user);
  const mustEnrol = useSession((s) => s.mfaEnrollRequired);
  const [status, setStatus] = useState<Status | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [enrol, setEnrol] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);

  const load = () => {
    void api.get<Status>('/api/security').then(setStatus).catch(() => {});
    void api.get<Session[]>('/api/sessions').then(setSessions).catch(() => {});
  };
  useEffect(load, []);

  const start = async () => {
    try { const r = await api.post<{ qr: string; secret: string }>('/api/security/totp/start'); setEnrol(r); setCode(''); }
    catch (e: any) { toast(e?.message ?? 'Could not start', 'error'); }
  };
  const confirm = async () => {
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/security/totp/confirm', { code });
      setCodes(r.recoveryCodes); setEnrol(null); load();
      if (mustEnrol) void useSession.getState().init();
    } catch (e: any) { toast(e?.message ?? 'That code did not match', 'error'); }
  };
  const withPassword = async (url: string, after: (r: any) => void) => {
    const password = window.prompt('Enter your password to confirm');
    if (!password) return;
    try { after(await api.post(url, { password })); load(); } catch (e: any) { toast(e?.message ?? 'Failed', 'error'); }
  };

  return (
    <div>
      <h2>Security</h2>
      {mustEnrol && <div className="banner error"><div>Your administrator requires two-factor sign-in. Set it up below to continue.</div></div>}

      <h3>Two-factor sign-in</h3>
      {codes && <Codes codes={codes} onDone={() => setCodes(null)} />}
      {status?.totp ? (
        <div className="security-row">
          <ShieldIcon size={22} weight="fill" className="ok-icon" />
          <div style={{ flex: 1 }}>
            <strong>Authenticator app is on</strong>
            <div className="dim">Since {status.totpSince ? new Date(status.totpSince).toLocaleDateString() : '—'} · {status.recoveryCodesLeft} recovery codes left</div>
          </div>
          <button className="btn" onClick={() => void withPassword('/api/security/recovery/regenerate', (r) => setCodes(r.recoveryCodes))}>New recovery codes</button>
          <button className="btn ghost danger" onClick={() => void withPassword('/api/security/totp/disable', () => toast('Two-factor turned off'))}>Turn off</button>
        </div>
      ) : enrol ? (
        <div className="enrol">
          <img src={enrol.qr} alt="QR code for your authenticator app" width={180} height={180} />
          <div>
            <p>Scan this with an authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator…), then type the 6-digit code it shows.</p>
            <p className="dim">Can't scan? Enter this key: <code>{enrol.secret}</code></p>
            <div className="field-row" style={{ alignItems: 'flex-end' }}>
              <div className="field" style={{ marginBottom: 0, maxWidth: 160 }}>
                <input className="text-input" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" autoFocus value={code}
                  onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void confirm()} aria-label="Code" />
              </div>
              <button className="btn primary" disabled={code.replace(/\s/g, '').length !== 6} onClick={() => void confirm()}>Turn on</button>
              <button className="btn ghost" onClick={() => setEnrol(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="security-row">
          <ShieldIcon size={22} />
          <div style={{ flex: 1 }}><strong>Not set up</strong><div className="dim">Add a code from your phone to every sign-in.</div></div>
          <button className="btn primary" onClick={() => void start()}>Set up authenticator app</button>
        </div>
      )}
      <p className="hint">Passkeys arrive once this server is reached over HTTPS (browsers only allow them on secure sites).</p>

      {me?.role === 'admin' && status && (
        <label className="checkbox-line">
          <input type="checkbox" checked={status.required}
            onChange={async (e) => { await api.put('/api/security/policy', { mfaRequired: e.target.checked }); load(); }} />
          Require two-factor sign-in for every user on this server
        </label>
      )}

      <h3>Where you're signed in</h3>
      <div className="session-list">
        {sessions.map((s) => (
          <div key={s.id} className="security-row">
            <DevicesIcon size={20} />
            <div style={{ flex: 1 }}>
              <strong>{s.label || device(s.userAgent)}</strong>{s.current && <span className="tag ok">this device</span>}
              <div className="dim">{s.ip || 'unknown IP'} · signed in {new Date(s.createdAt).toLocaleDateString()} · last active {s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '—'}</div>
            </div>
            {!s.current && <button className="btn ghost" onClick={async () => { await api.del(`/api/sessions/${s.id}`); load(); }}>Sign out</button>}
          </div>
        ))}
      </div>
      {sessions.length > 1 && (
        <button className="btn" onClick={async () => { const r = await api.post<{ revoked: number }>('/api/sessions/revoke-others'); toast(`Signed out ${r.revoked} other session${r.revoked === 1 ? '' : 's'}`); load(); }}>
          Sign out everywhere else
        </button>
      )}
      <p className="hint">Sessions end after 30 days without use, and after 90 days at most.</p>

      <h3>Password</h3>
      <ChangePassword />

      <h3>Trusted senders</h3>
      <TrustedSenders />
    </div>
  );
}

function ChangePassword() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const save = async () => {
    try { await api.put('/api/users/password', { current: cur, password: next }); toast('Password changed'); setCur(''); setNext(''); }
    catch (e: any) { toast(e?.message ?? 'Could not change password', 'error'); }
  };
  return (
    <div className="field-row" style={{ alignItems: 'flex-end', maxWidth: 560 }}>
      <div className="field" style={{ marginBottom: 0 }}><label>Current password</label><input className="text-input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
      <div className="field" style={{ marginBottom: 0 }}><label>New password</label><input className="text-input" type="password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
      <button className="btn" disabled={!cur || next.length < 8} onClick={() => void save()}>Change</button>
    </div>
  );
}

interface Trusted { id: number; kind: 'address' | 'domain'; value: string }

/** Senders and domains that never get a phishing warning (added with “This is safe” on a warning). */
function TrustedSenders() {
  const [list, setList] = useState<Trusted[]>([]);
  const [val, setVal] = useState('');
  const load = () => { void api.get<Trusted[]>('/api/trusted-senders').then(setList).catch(() => {}); };
  useEffect(load, []);
  const add = async () => {
    try { await api.post('/api/trusted-senders', { value: val }); setVal(''); load(); }
    catch (e: any) { toast(e?.message ?? 'Could not add', 'error'); }
  };
  return (
    <div>
      <p className="settings-desc">Messages from these never show a phishing warning. Use it for people and companies you know are genuine.</p>
      {list.length === 0 ? <p className="dim">None yet.</p> : (
        <table className="plain-table"><thead><tr><th>Sender</th><th>Type</th><th /></tr></thead><tbody>
          {list.map((t) => (
            <tr key={t.id}><td>{t.value}</td><td>{t.kind === 'domain' ? 'Whole domain' : 'Address'}</td>
              <td><button className="btn ghost small" onClick={async () => { await api.del(`/api/trusted-senders/${t.id}`); load(); }}>Remove</button></td></tr>
          ))}
        </tbody></table>
      )}
      <div className="field-row" style={{ alignItems: 'flex-end', maxWidth: 560, marginTop: 10 }}>
        <div className="field" style={{ marginBottom: 0 }}><label>Add an address or domain</label>
          <input className="text-input" value={val} placeholder="billing@supplier.com or supplier.com" onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && val && void add()} /></div>
        <button className="btn" disabled={!val.trim()} onClick={() => void add()}>Add</button>
      </div>
    </div>
  );
}
