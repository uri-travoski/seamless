import { ImportForm } from './settings/ExportDialog.tsx';
import { useEffect, useState } from 'react';
import type { ApiBackup } from '@seamless/shared';
import { useSession } from '../state/session.ts';
import { api } from '../api/client.ts';
import { MailLogo } from '../icons.tsx';
import StorageForm, { emptyForm, type FormValue } from './settings/StorageForm.tsx';
import { toast } from '../toast.ts';
import { cachedAppName } from '../state/session.ts';

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
  const [showPw, setShowPw] = useState(false);
  const [mfaToken, setMfaToken] = useState('');
  const [code, setCode] = useState('');
  const loginMfa = useSession((s) => s.loginMfa);
  const isSetup = status === 'setup';
  // optional first-run "Storage" step: skipped by default (the server's own settings are used)
  const [useOwnStorage, setUseOwnStorage] = useState(false);
  const [mailForm, setMailForm] = useState<FormValue>(emptyForm('mail'));
  const canSubmit = email.length > 0 && password.length > 0;

  // Disaster recovery lives here because this is the only screen a restored-from-nothing
  // server can show: the database is empty, so there is no account to sign in with.
  const [backups, setBackups] = useState<ApiBackup[]>([]);
  const [restoring, setRestoring] = useState('');
  const [restored, setRestored] = useState('');
  const [mailNote, setMailNote] = useState('');
  const [mailWarn, setMailWarn] = useState(false);

  // Only the BACKUP bucket ever has to be asked for: its credentials cannot come out of the
  // backup (you need them to read it). The MAIL bucket does not — its config travels inside.
  const [askStorage, setAskStorage] = useState(false);
  const [store, setStore] = useState({ endpoint: '', bucket: '', accessKey: '', secretKey: '', region: 'auto' });
  const [looking, setLooking] = useState(false);
  const usingCustomStore = () => (store.bucket ? { store, prefix: undefined } : {});

  useEffect(() => {
    if (!isSetup) return;
    api.get<{ backups: ApiBackup[] }>('/api/setup/backups')
      .then((r) => {
        setBackups(r.backups);
        if (!r.backups.length) setAskStorage(true);   // nothing where we looked — let them point us
      })
      .catch(() => setAskStorage(true));              // no usable storage config at all
  }, [isSetup]);

  const findBackups = async () => {
    setErr('');
    setLooking(true);
    try {
      const r = await api.post<{ backups: ApiBackup[] }>('/api/setup/backups', { store });
      setBackups(r.backups);
      if (!r.backups.length) setErr('No backups found in that bucket.');
    } catch (e: any) {
      setErr(e?.message ?? 'Could not read that bucket');
    } finally {
      setLooking(false);
    }
  };

  const restore = async (key: string) => {
    setErr('');
    setRestoring(key);
    try {
      const r = await api.post<{
        rows: number;
        mailStore: { bucket: string; endpoint: string; adopted: boolean };
        blobs: { checked: boolean; ok: boolean; error?: string };
      }>('/api/setup/restore', { key, ...usingCustomStore() });

      setRestored(`Restored ${r.rows} rows. Sign in with your existing account.`);
      // the mail was never in the backup, only the pointer to it: say whether we reached it
      if (!r.blobs.checked) {
        setMailNote(`Mail bucket "${r.mailStore.bucket}" — nothing archived yet.`);
      } else if (r.blobs.ok) {
        setMailWarn(false);
        setMailNote(`Mail reconnected: bucket "${r.mailStore.bucket}"${r.mailStore.adopted ? ', found in the backup' : ''} — blob checksum verified.`);
      } else {
        setMailWarn(true);
        setMailNote(`Database restored, but the mail bucket "${r.mailStore.bucket}" is unreachable: ${r.blobs.error}. Message bodies will not open until it is.`);
      }
      setBackups([]);
      setAskStorage(false);
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
      if (mfaToken) {
        await loginMfa(mfaToken, code);
      } else if (isSetup) {
        await setup(email, name, password);
        if (useOwnStorage && mailForm.bucket) {
          // the admin exists and is signed in now, so the normal (admin-only) route can save it
          await api.post('/api/storage/targets', { role: 'mail', ...mailForm })
            .catch((e: any) => toast(`Storage was not saved: ${e?.message ?? 'test failed'}. You can set it up in Settings → Storage.`, 'error'));
        }
      } else {
        const r = await login(email, password);
        if (r.mfaToken) { setMfaToken(r.mfaToken); setCode(''); }
      }
    } catch (e: any) {
      if (mfaToken && /expired/.test(e?.message ?? '')) { setMfaToken(''); setPassword(''); }
      setErr(e?.message ?? 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand"><MailLogo size="1.65em" /><span className="app-name">{cachedAppName()}</span></div>
        {mfaToken ? (
          <>
            <p style={{ color: 'var(--md-text-soft)', fontSize: 13, marginTop: 0 }}>
              Enter the 6-digit code from your authenticator app, or one of your recovery codes.
            </p>
            <div className="field">
              <label>Code</label>
              <input className="text-input" inputMode="numeric" autoComplete="one-time-code" value={code} autoFocus
                onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code && submit()} />
            </div>
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: '9px 0' }} disabled={busy || !code} onClick={submit}>Verify</button>
            <button className="btn ghost" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} onClick={() => { setMfaToken(''); setErr(''); }}>Back</button>
            <div className="login-err">{err}</div>
          </>
        ) : (<>
        <p style={{ color: 'var(--md-text-soft)', fontSize: 13, marginTop: 0 }}>
          {isSetup ? 'First run — create the admin account for this instance.' : 'Sign in to your account'}
        </p>
        <div className="field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email"
            className="text-input" type="email" value={email} autoFocus placeholder="name@example.com" aria-label="Email" 
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
          <label htmlFor="login-password">Password</label>
          <div className="pw-wrap">
            <input id="login-password"
              className="text-input" type={showPw ? 'text' : 'password'} value={password} placeholder="••••••••" aria-label="Password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isSetup && canSubmit && submit()}
            />
            <button type="button" className="pw-toggle" aria-label="Toggle password visibility" onClick={() => setShowPw((v) => !v)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
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
        </>)}

        {isSetup && !restored && (
          <div style={{ marginTop: 14 }}>
            <label className="check">
              <input type="checkbox" checked={useOwnStorage} onChange={(e) => setUseOwnStorage(e.target.checked)} /> Choose where mail is stored
            </label>
            {!useOwnStorage && <div className="hint">Skip — use the server’s settings. You can change this later in Settings → Storage.</div>}
            {useOwnStorage && <StorageForm role="mail" value={mailForm} onChange={setMailForm} testUrl="/api/setup/storage-test" />}
          </div>
        )}

        {isSetup && restored && (
          <div style={{ marginTop: 12 }}>
            <div className="dim">{restored}</div>
            {mailNote && (
              <div className="hint" style={{ marginTop: 6, color: mailWarn ? 'var(--md-danger)' : undefined }}>
                {mailNote}
              </div>
            )}
          </div>
        )}

        {isSetup && backups.length > 0 && (
          <div style={{ marginTop: 18, borderTop: '1px solid var(--md-border)', paddingTop: 14 }}>
            <strong style={{ fontSize: 13 }}>Rebuilding a lost server?</strong>
            <p className="hint" style={{ marginTop: 4 }}>
              {backups.length} backup{backups.length > 1 ? 's' : ''} found. Restoring replaces this empty database with
              everything it held — mail, labels, rules and AI history — and reconnects to the mail bucket the backup
              came from.
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

        {isSetup && !restored && (
          <details style={{ marginTop: 18, borderTop: '1px solid var(--md-border)', paddingTop: 14 }}>
            <summary><strong style={{ fontSize: 13 }}>Import from export file</strong></summary>
            <p className="hint" style={{ marginTop: 4 }}>
              Moving from another Seamless server? Choose the <code>.seamless-export</code> file and its password.
            </p>
            <ImportForm mode="full" onDone={(s) => { setRestored(s); void useSession.getState().init(); }} />
          </details>
        )}

        {isSetup && askStorage && !backups.length && !restored && (
          <div style={{ marginTop: 18, borderTop: '1px solid var(--md-border)', paddingTop: 14 }}>
            <strong style={{ fontSize: 13 }}>Restoring from a backup?</strong>
            <p className="hint" style={{ marginTop: 4 }}>
              No backups found where this server was told to look. Point it at the bucket your backups are in. You do
              not need the mail bucket — the backup knows where the mail lives.
            </p>
            <div className="field">
              <label>Bucket</label>
              <input className="text-input" value={store.bucket} placeholder="seamless-backups"
                onChange={(e) => setStore({ ...store, bucket: e.target.value })} />
            </div>
            <div className="field">
              <label>Endpoint</label>
              <input className="text-input" value={store.endpoint} placeholder="https://<account>.r2.cloudflarestorage.com"
                onChange={(e) => setStore({ ...store, endpoint: e.target.value })} />
            </div>
            <div className="field-row">
              <div className="field">
                <label>Access key</label>
                <input className="text-input" value={store.accessKey}
                  onChange={(e) => setStore({ ...store, accessKey: e.target.value })} />
              </div>
              <div className="field">
                <label>Secret key</label>
                <input className="text-input" type="password" value={store.secretKey}
                  onChange={(e) => setStore({ ...store, secretKey: e.target.value })} />
              </div>
            </div>
            <button className="btn" disabled={looking || !store.bucket} onClick={() => void findBackups()}>
              {looking ? 'Looking…' : 'Find backups'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
