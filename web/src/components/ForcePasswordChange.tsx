/** Shown instead of the app when an administrator reset this user's password (users.must_change_password). */
import { useState } from 'react';
import { api } from '../api/client.ts';
import { useSession, cachedAppName } from '../state/session.ts';
import { MailLogo } from '../icons.tsx';

export default function ForcePasswordChange() {
  const init = useSession((s) => s.init);
  const logout = useSession((s) => s.logout);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = current.length > 0 && password.length >= 8 && password === confirm;

  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true); setErr('');
    try {
      await api.put('/api/users/password', { current, password });
      await init();
    } catch (e: any) {
      setErr(e?.message ?? 'Could not change the password');
    }
    setBusy(false);
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand"><MailLogo size="1.65em" /><span className="app-name">{cachedAppName()}</span></div>
        <p>Your administrator gave you a temporary password. Choose your own to continue.</p>
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="field"><label>Temporary password</label>
            <input className="text-input" type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} /></div>
          <div className="field"><label>New password (min 8 characters)</label>
            <input className="text-input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <div className="field"><label>Confirm new password</label>
            <input className="text-input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
          {confirm && password !== confirm && <div className="login-err">The two passwords don’t match.</div>}
          {err && <div className="login-err">{err}</div>}
          <button className="btn primary" type="submit" disabled={!ok || busy} style={{ width: '100%', height: 44 }}>Save and continue</button>
        </form>
        <button className="btn ghost" style={{ width: '100%', marginTop: 10 }} onClick={() => void logout()}>Sign out</button>
      </div>
    </div>
  );
}
