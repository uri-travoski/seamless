import { useEffect, useState } from 'react';
import type { ApiBackup } from '@seamless/shared';
import { useSession } from '../state/session.ts';
import { api } from '../api/client.ts';
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

  // Disaster recovery lives here because this is the only screen a restored-from-nothing
  // server can show: the database is empty, so there is no account to sign in with.
  const [backups, setBackups] = useState<ApiBackup[]>([]);
  const [restoring, setRestoring] = useState('');
  const [restored, setRestored] = useState('');

  useEffect(() => {
    if (!isSetup) return;
    api.get<{ backups: ApiBackup[] }>('/api/setup/backups')
      .then((r) => setBackups(r.backups))
      .catch(() => setBackups([]));   // no bucket, no backups, no restore offer — just set up fresh
  }, [isSetup]);

  const restore = async (key: string) => {
    setErr('');
    setRestoring(key);
    try {
      const r = await api.post<{ rows: number }>('/api/setup/restore', { key });
      setRestored(`Restored ${r.rows} rows. Sign in with your existing account.`);
      setBackups([]);
      await useSession.getState().init();   // users exist again: flips setup -> login
    } catch (e: any) {
      setErr(e?.message ?? 'Restore failed');
    } finally {
      setRestoring('');
    }
  };

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

        {isSetup && restored && <div className="dim" style={{ marginTop: 12 }}>{restored}</div>}

        {isSetup && backups.length > 0 && (
          <div style={{ marginTop: 18, borderTop: '1px solid var(--md-border)', paddingTop: 14 }}>
            <strong style={{ fontSize: 13 }}>Rebuilding a lost server?</strong>
            <p className="hint" style={{ marginTop: 4 }}>
              {backups.length} backup{backups.length > 1 ? 's' : ''} found in your storage bucket. Restoring replaces
              this empty database with everything it held — mail, labels, rules and AI history.
            </p>
            {backups.slice(0, 5).map((b) => (
              <div key={b.key} className="field-row" style={{ alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span className="dim" style={{ flex: 1 }}>
                  {new Date(b.createdAt).toLocaleString()} · {b.rows} rows
                </span>
                <button className="btn" disabled={!!restoring} onClick={() => void restore(b.key)}>
                  {restoring === b.key ? 'Restoring…' : 'Restore'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
