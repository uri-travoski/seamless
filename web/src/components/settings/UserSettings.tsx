import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { useSession } from '../../state/session.ts';
import { toast } from '../../toast.ts';
import { Wizard, BLANK } from './MailboxSettings.tsx';
import QuotaBar from './QuotaBar.tsx';

interface UserRow {
  id: number; email: string; name: string; role: 'admin' | 'member'; createdAt: number;
  disabled: boolean; mustChangePassword: boolean; lastLoginAt: number | null;
  mailboxCount: number; mailboxes: string[];
  usedBytes: number; quotaBytes: number | null; percent: number | null;
}

const GB = 1024 ** 3;
const gbText = (bytes: number | null) => (bytes == null ? '' : String(Math.round((bytes / GB) * 100) / 100));
const when = (t: number | null) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

type Dialog =
  | { kind: 'add'; email: string; name: string; password: string; role: 'admin' | 'member'; quotaGb: string; mustChange: boolean }
  | { kind: 'edit'; user: UserRow; name: string; role: 'admin' | 'member'; quotaGb: string }
  | { kind: 'reset'; user: UserRow; password: string };

export default function UserSettings() {
  const me = useSession((s) => s.user);
  const isAdmin = me?.role === 'admin';
  const [users, setUsers] = useState<UserRow[]>([]);
  const [defaultGb, setDefaultGb] = useState('');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [mailboxFor, setMailboxFor] = useState<UserRow | null>(null);
  const [pw, setPw] = useState({ current: '', password: '', confirm: '' });

  const refresh = async () => {
    if (!isAdmin) return;
    try {
      setUsers(await api.get<UserRow[]>('/api/users'));
      setDefaultGb(gbText((await api.get<{ bytes: number | null }>('/api/users/quota-default')).bytes));
    } catch { /* member */ }
  };
  useEffect(() => { void refresh(); }, [isAdmin]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok, 'info'); await refresh(); }
    catch (e: any) { toast(e?.message ?? 'That did not work', 'error'); }
  };

  const submitDialog = async () => {
    if (!dialog) return;
    const d = dialog;
    await act(async () => {
      if (d.kind === 'add') await api.post('/api/users', { email: d.email, name: d.name, password: d.password, role: d.role, quotaGb: d.quotaGb, mustChangePassword: d.mustChange });
      else if (d.kind === 'edit') await api.put(`/api/users/${d.user.id}`, { name: d.name, role: d.role, quotaGb: d.quotaGb });
      else await api.post(`/api/users/${d.user.id}/reset-password`, { password: d.password });
      setDialog(null);
    }, d.kind === 'add' ? 'User created' : d.kind === 'edit' ? 'User saved' : 'Password reset — they must choose a new one at next sign-in');
  };

  const removeUser = (u: UserRow) => {
    if (!window.confirm(`Delete ${u.email}? Their mailboxes, mail cache and settings are removed.`)) return;
    void act(() => api.del(`/api/users/${u.id}`), 'User deleted');
  };
  const toggle = (u: UserRow) => {
    if (!u.disabled && !window.confirm(`Disable ${u.email}? They are signed out everywhere, cannot sign in, and their mailboxes stop syncing. Nothing is deleted.`)) return;
    void act(() => api.post(`/api/users/${u.id}/${u.disabled ? 'enable' : 'disable'}`), u.disabled ? 'User enabled' : 'User disabled');
  };
  const signOut = (u: UserRow) => {
    if (!window.confirm(`Sign ${u.email} out of every browser and device?`)) return;
    void act(() => api.post(`/api/users/${u.id}/sign-out`), 'Signed out everywhere');
  };
  const saveDefault = () => void act(() => api.put('/api/users/quota-default', { gb: defaultGb }), 'Default limit saved');

  const changePassword = async () => {
    if (pw.password !== pw.confirm) { toast('Passwords do not match', 'error'); return; }
    try {
      await api.put('/api/users/password', { current: pw.current, password: pw.password });
      setPw({ current: '', password: '', confirm: '' });
      toast('Password changed', 'info');
    } catch (e: any) {
      toast(e?.message ?? 'Could not change password', 'error');
    }
  };

  if (mailboxFor) {
    return (
      <div>
        <p className="settings-desc">Adding a mailbox for <b>{mailboxFor.name || mailboxFor.email}</b> ({mailboxFor.email}). It will belong to them, not to you.</p>
        <Wizard initial={{ ...BLANK, forUserId: mailboxFor.id }} categories={[]} onDone={(saved) => { setMailboxFor(null); if (saved) void refresh(); }} />
      </div>
    );
  }

  return (
    <div>
      <h2>Users</h2>
      <p className="settings-desc">
        Signed in as <b>{me?.email}</b> ({me?.role}).
      </p>

      <h3 style={{ fontSize: 14, marginTop: 18 }}>Change my password</h3>
      <div className="field"><label>Current password</label>
        <input className="text-input" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></div>
      <div className="field"><label>New password (min 8 characters)</label>
        <input className="text-input" type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></div>
      <div className="field"><label>Confirm new password</label>
        <input className="text-input" type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} /></div>
      <button className="btn primary" disabled={!pw.current || pw.password.length < 8} onClick={() => void changePassword()}>Change password</button>

      {isAdmin && (
        <>
          <h3 style={{ fontSize: 14, marginTop: 26 }}>All users</h3>
          <p className="settings-desc">
            Storage limits only warn: at 80 % and 100 % the user and every administrator get a notification. Mail keeps arriving and nothing is deleted.
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr><th>User</th><th>Role</th><th>Mailboxes</th><th>Storage</th><th>Last sign-in</th><th /></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} style={u.disabled ? { opacity: 0.6 } : undefined}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{u.name || u.email}</div>
                      <div className="dim" style={{ fontSize: 12.5 }}>{u.name ? u.email : ''}</div>
                      {u.disabled && <span className="pill error">Disabled</span>}
                      {u.mustChangePassword && <span className="pill busy" title="Must choose a new password at next sign-in">Temporary password</span>}
                    </td>
                    <td>{u.role === 'admin' ? 'Admin' : 'Member'}</td>
                    <td title={u.mailboxes.join('\n')}>{u.mailboxCount}</td>
                    <td><QuotaBar usedBytes={u.usedBytes} quotaBytes={u.quotaBytes} percent={u.percent} /></td>
                    <td>{when(u.lastLoginAt)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn ghost" onClick={() => setDialog({ kind: 'edit', user: u, name: u.name, role: u.role, quotaGb: gbText(u.quotaBytes) })}>Edit</button>
                      <button className="btn ghost" onClick={() => setMailboxFor(u)}>Add mailbox</button>
                      {u.id !== me?.id && <button className="btn ghost" onClick={() => setDialog({ kind: 'reset', user: u, password: '' })}>Reset password</button>}
                      <button className="btn ghost" onClick={() => signOut(u)}>Sign out everywhere</button>
                      {u.id !== me?.id && <button className="btn ghost" onClick={() => toggle(u)}>{u.disabled ? 'Enable' : 'Disable'}</button>}
                      {u.id !== me?.id && <button className="btn ghost danger" onClick={() => removeUser(u)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="field" style={{ maxWidth: 360, marginTop: 18 }}>
            <label>Default storage limit for new users (GB, empty = no limit)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="text-input" inputMode="decimal" value={defaultGb} onChange={(e) => setDefaultGb(e.target.value)} placeholder="no limit" />
              <button className="btn" onClick={saveDefault}>Save</button>
            </div>
          </div>

          {dialog ? (
            <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 14, marginTop: 14, maxWidth: 520 }}>
              {dialog.kind === 'add' && (
                <>
                  <h3 style={{ fontSize: 14, margin: '0 0 10px' }}>Add user</h3>
                  <div className="field"><label>Email</label>
                    <input className="text-input" type="email" value={dialog.email} autoFocus onChange={(e) => setDialog({ ...dialog, email: e.target.value })} /></div>
                  <div className="field"><label>Name</label>
                    <input className="text-input" value={dialog.name} onChange={(e) => setDialog({ ...dialog, name: e.target.value })} /></div>
                  <div className="field"><label>Temporary password (min 8 characters)</label>
                    <input className="text-input" type="text" autoComplete="off" value={dialog.password} onChange={(e) => setDialog({ ...dialog, password: e.target.value })} /></div>
                  <label className="check"><input type="checkbox" checked={dialog.mustChange} onChange={(e) => setDialog({ ...dialog, mustChange: e.target.checked })} /> They must choose their own password at first sign-in</label>
                  <div className="field"><label>Role</label>
                    <select className="text-input" value={dialog.role} onChange={(e) => setDialog({ ...dialog, role: e.target.value as 'admin' | 'member' })}>
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select></div>
                  <div className="field"><label>Storage limit (GB, empty = no limit)</label>
                    <input className="text-input" inputMode="decimal" value={dialog.quotaGb} onChange={(e) => setDialog({ ...dialog, quotaGb: e.target.value })} /></div>
                </>
              )}
              {dialog.kind === 'edit' && (
                <>
                  <h3 style={{ fontSize: 14, margin: '0 0 10px' }}>Edit {dialog.user.email}</h3>
                  <div className="field"><label>Name</label>
                    <input className="text-input" value={dialog.name} autoFocus onChange={(e) => setDialog({ ...dialog, name: e.target.value })} /></div>
                  <div className="field"><label>Role</label>
                    <select className="text-input" value={dialog.role} onChange={(e) => setDialog({ ...dialog, role: e.target.value as 'admin' | 'member' })}>
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select></div>
                  <div className="field"><label>Storage limit (GB, empty = no limit)</label>
                    <input className="text-input" inputMode="decimal" value={dialog.quotaGb} onChange={(e) => setDialog({ ...dialog, quotaGb: e.target.value })} /></div>
                </>
              )}
              {dialog.kind === 'reset' && (
                <>
                  <h3 style={{ fontSize: 14, margin: '0 0 10px' }}>Reset password for {dialog.user.email}</h3>
                  <p className="settings-desc">Type a temporary password and tell them. They are signed out everywhere and must choose a new password at next sign-in.</p>
                  <div className="field"><label>Temporary password (min 8 characters)</label>
                    <input className="text-input" type="text" autoComplete="off" autoFocus value={dialog.password} onChange={(e) => setDialog({ ...dialog, password: e.target.value })} /></div>
                </>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary"
                  disabled={(dialog.kind === 'add' && (!dialog.email || dialog.password.length < 8)) || (dialog.kind === 'reset' && dialog.password.length < 8)}
                  onClick={() => void submitDialog()}>{dialog.kind === 'add' ? 'Create user' : dialog.kind === 'edit' ? 'Save' : 'Reset password'}</button>
                <button className="btn ghost" onClick={() => setDialog(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn primary" style={{ marginTop: 14 }}
              onClick={() => setDialog({ kind: 'add', email: '', name: '', password: '', role: 'member', quotaGb: defaultGb, mustChange: true })}>Add user</button>
          )}
        </>
      )}
    </div>
  );
}
