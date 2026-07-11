import { useState } from 'react';
import { useSession } from '../state/session.ts';
import { MailLogo } from '../icons.tsx';

export default function Login() {
  const status = useSession((s) => s.status);
  const login = useSession((s) => s.login);
  const setup = useSession((s) => s.setup);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isSetup = status === 'setup';
  const canSubmit = email.length > 0 && password.length > 0;

  const submit = async () => {
    setErr('');
    if (isSetup && password !== confirm) { setErr('Passwords do not match'); return; }
    setBusy(true);
    try {
      await (isSetup ? setup(email, name, password) : login(email, password));
    } catch (e: any) {
      setErr(e?.message ?? 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand"><MailLogo size={30} />Seamless</div>
        <p style={{ color: 'var(--md-text-soft)', fontSize: 13, marginTop: 0 }}>
          {isSetup ? 'First run — create the admin account for this instance.' : 'Sign in to open your mail.'}
        </p>
        <div className="field">
          <label>Email</label>
          <input
            className="text-input" type="email" value={email} autoFocus
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isSetup && canSubmit && submit()}
          />
        </div>
        {isSetup && (
          <div className="field">
            <label>Name</label>
            <input
              className="text-input" type="text" value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        )}
        <div className="field">
          <label>Password</label>
          <input
            className="text-input" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !isSetup && canSubmit && submit()}
          />
        </div>
        {isSetup && (
          <div className="field">
            <label>Confirm password</label>
            <input
              className="text-input" type="password" value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        )}
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: '9px 0' }} disabled={busy || !canSubmit} onClick={submit}>
          {isSetup ? 'Create & open' : 'Sign in'}
        </button>
        <div className="login-err">{err}</div>
      </div>
    </div>
  );
}
