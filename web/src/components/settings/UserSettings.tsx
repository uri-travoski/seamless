import { useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { useSession } from '../../state/session.ts';
import { toast } from '../../toast.ts';

interface UserRow { id: number; email: string; name: string; role: 'admin' | 'member' }

export default function UserSettings() {
  const me = useSession((s) => s.user);
  const isAdmin = me?.role === 'admin';
  const [users, setUsers] = useState<UserRow[]>([]);
  const [adding, setAdding] = useState<{ email: string; name: string; password: string; role: 'admin' | 'member' } | null>(null);
  const [pw, setPw] = useState({ current: '', password: '', confirm: '' });

  const refresh = async () => {
    if (!isAdmin) return;
    try { setUsers(await api.get<UserRow[]>('/api/users')); } catch { /* member */ }
  };
  useEffect(() => { void refresh(); }, [isAdmin]);

  const addUser = async () => {
    if (!adding) return;
    try {
      await api.post('/api/users', adding);
      setAdding(null);
      toast('User created', 'info');
      await refresh();
    } catch (e: any) {
      toast(e?.message ?? 'Could not create user', 'error');
    }
  };

  const removeUser = async (u: UserRow) => {
    if (!window.confirm(`Delete ${u.email}? Their accounts, mail cache and settings are removed.`)) return;
    try {
      await api.del(`/api/users/${u.id}`);
      await refresh();
    } catch (e: any) {
      toast(e?.message ?? 'Could not delete user', 'error');
    }
  };

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
          {users.map((u) => (
            <div key={u.id} className="cond-row">
              <span style={{ width: 220, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.email}</span>
              <span style={{ flex: 1, color: 'var(--md-text-faint)', fontSize: 12.5 }}>{u.name}</span>
              <span style={{ width: 70, color: 'var(--md-text-soft)', fontSize: 12.5 }}>{u.role}</span>
              {u.id !== me?.id && (
                <button className="btn ghost danger" onClick={() => void removeUser(u)}>Delete</button>
              )}
            </div>
          ))}

          {adding ? (
            <div style={{ border: '1px solid var(--md-border)', borderRadius: 8, padding: 14, marginTop: 14 }}>
              <div className="field"><label>Email</label>
                <input className="text-input" type="email" value={adding.email} autoFocus onChange={(e) => setAdding({ ...adding, email: e.target.value })} /></div>
              <div className="field"><label>Name</label>
                <input className="text-input" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></div>
              <div className="field"><label>Password (min 8 characters)</label>
                <input className="text-input" type="password" value={adding.password} onChange={(e) => setAdding({ ...adding, password: e.target.value })} /></div>
              <div className="field"><label>Role</label>
                <select className="text-input" value={adding.role} onChange={(e) => setAdding({ ...adding, role: e.target.value as 'admin' | 'member' })}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" disabled={!adding.email || adding.password.length < 8} onClick={() => void addUser()}>Create user</button>
                <button className="btn ghost" onClick={() => setAdding(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn primary" style={{ marginTop: 14 }}
              onClick={() => setAdding({ email: '', name: '', password: '', role: 'member' })}>Add user</button>
          )}
        </>
      )}
    </div>
  );
}
