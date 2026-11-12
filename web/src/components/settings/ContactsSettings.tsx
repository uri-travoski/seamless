import { useEffect, useState } from 'react';
import type { ApiContact, ApiContactGroup } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { navigate } from '../../router.ts';
import ContactImport from './ContactImport.tsx';

type Filter = 'all' | 'mine' | 'auto' | 'hidden' | 'business';
type Sort = 'name' | 'recent' | 'used';
interface Draft {
  id?: number; displayName: string; org: string; notes: string; hidden: boolean;
  emails: { email: string; label: string }[]; phones: { label: string; value: string }[]; groupIds: number[];
}
interface Detail { contact: ApiContact; conversations: { id: string; subject: string; date: number; from: string }[] }
interface DupPair { reason: string; a: ApiContact; b: ApiContact }

const blank = (): Draft => ({ displayName: '', org: '', notes: '', hidden: false, emails: [{ email: '', label: '' }], phones: [], groupIds: [] });
const toDraft = (c: ApiContact): Draft => ({
  id: c.id, displayName: c.displayName, org: c.org, notes: c.notes, hidden: c.hidden,
  emails: c.emailsDetail.length ? c.emailsDetail.map((e) => ({ email: e.email, label: e.label })) : [{ email: '', label: '' }],
  phones: c.phones, groupIds: c.groupIds,
});
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');
const FORMATS: [string, string][] = [['vcf', 'vCard (.vcf) — Apple, Android, Outlook, Thunderbird'], ['google', 'Google Contacts CSV'], ['outlook', 'Outlook CSV'], ['csv', 'Generic CSV'], ['json', 'JSON']];

export default function ContactsSettings() {
  const [contacts, setContacts] = useState<ApiContact[]>([]);
  const [groups, setGroups] = useState<ApiContactGroup[]>([]);
  const [settings, setSettings] = useState({ autoSave: true, saveRepliers: true });
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('used');
  const [groupId, setGroupId] = useState(0);
  const [term, setTerm] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [edit, setEdit] = useState<Draft | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [dups, setDups] = useState<DupPair[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [exportFmt, setExportFmt] = useState('vcf');
  const [newGroup, setNewGroup] = useState('');

  const refresh = async () => {
    const qs = new URLSearchParams({ filter, sort });
    if (term) qs.set('q', term);
    if (groupId) qs.set('group', String(groupId));
    setContacts(await api.get<ApiContact[]>(`/api/contacts?${qs}`));
    setGroups(await api.get<ApiContactGroup[]>('/api/contact-groups'));
  };
  useEffect(() => { void api.get<typeof settings>('/api/contacts/settings').then(setSettings); }, []);
  useEffect(() => { const t = setTimeout(() => void refresh(), 150); return () => clearTimeout(t); }, [filter, sort, groupId, term]);

  const saveSettings = async (patch: Partial<typeof settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await api.put('/api/contacts/settings', patch);
  };

  const save = async () => {
    if (!edit) return;
    const body = { ...edit, emails: edit.emails.filter((e) => e.email.trim()), phones: edit.phones.filter((p) => p.value.trim()) };
    try {
      if (edit.id) await api.put(`/api/contacts/${edit.id}`, body); else await api.post('/api/contacts', body);
      setEdit(null);
      await refresh();
    } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
  };

  const bulk = async (action: string, extra: Record<string, unknown> = {}) => {
    if (action === 'delete' && !window.confirm(`Delete ${sel.size} contact${sel.size === 1 ? '' : 's'}?`)) return;
    await api.post('/api/contacts/bulk', { ids: [...sel], action, ...extra });
    if (action === 'delete') setSel(new Set());
    await refresh();
  };

  const open = async (c: ApiContact) => {
    setEdit(null);
    setDetail(await api.get<Detail>(`/api/contacts/${c.id}/detail`));
  };
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const exportHref = (ids?: number[]) => `/api/contacts/export?format=${exportFmt}${ids?.length ? `&ids=${ids.join(',')}` : ''}${groupId ? `&group=${groupId}` : ''}${filter !== 'all' ? `&filter=${filter}` : ''}`;
  const autoCount = contacts.filter((c) => c.autoCreated).length;
  const search = (q: string) => navigate(`/mail/unified/search?q=${encodeURIComponent(q)}`);

  return (
    <div>
      <h2>Contacts</h2>
      <label className="checkbox-line" style={{ fontWeight: 600 }}>
        <input type="checkbox" checked={settings.autoSave} onChange={(e) => void saveSettings({ autoSave: e.target.checked })} />
        Automatically save people I write to or reply to
      </label>
      <label className="checkbox-line" style={{ marginLeft: 22, opacity: settings.autoSave ? 1 : 0.5 }}>
        <input type="checkbox" disabled={!settings.autoSave} checked={settings.saveRepliers} onChange={(e) => void saveSettings({ saveRepliers: e.target.checked })} />
        Also save senders I reply to
      </label>
      <p className="settings-desc">
        Like Gmail: the moment you send, everyone in To/Cc/Bcc is saved (never no-reply addresses, your own addresses, or mailing-list mail) and you get an Undo.
        Turning this off stops new saves only — existing contacts stay. Phones sync this addressbook over CardDAV (Settings → Devices). Hidden contacts stay out of autocomplete and CardDAV.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="text-input" style={{ width: 200 }} placeholder="Search contacts…" value={term} onChange={(e) => setTerm(e.target.value)} />
        <select className="text-input" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filter">
          <option value="all">All</option><option value="mine">My contacts</option><option value="auto">Auto-saved</option><option value="hidden">Hidden</option><option value="business">Business</option>
        </select>
        <select className="text-input" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="used">Most used</option><option value="recent">Recent</option><option value="name">Name</option>
        </select>
        <select className="text-input" value={groupId} onChange={(e) => setGroupId(Number(e.target.value))} aria-label="Group">
          <option value={0}>All groups</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.memberCount})</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={() => { setDetail(null); setEdit(blank()); }}>Add contact</button>
        <button className="btn ghost" onClick={async () => setDups(await api.get<DupPair[]>('/api/contacts/duplicates'))}>Merge duplicates</button>
        <button className="btn ghost" onClick={() => setImporting(true)}>Import…</button>
        <select className="text-input" value={exportFmt} onChange={(e) => setExportFmt(e.target.value)} aria-label="Export format">
          {FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <a className="btn ghost" href={exportHref(sel.size ? [...sel] : undefined)} style={{ textDecoration: 'none' }}>{sel.size ? `Export ${sel.size}` : 'Export'}</a>
      </div>

      {sel.size > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b>{sel.size} selected</b>
          <button className="btn ghost" onClick={() => void bulk('promote')}>Make "My contact"</button>
          <button className="btn ghost" onClick={() => void bulk('hide')}>Hide</button>
          <button className="btn ghost" onClick={() => void bulk('unhide')}>Unhide</button>
          <select className="text-input" value="" onChange={(e) => { if (e.target.value) void bulk('addToGroup', { groupId: Number(e.target.value) }); }} aria-label="Add to group">
            <option value="">Add to group…</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          {groupId > 0 && <button className="btn ghost" onClick={() => void bulk('removeFromGroup', { groupId })}>Remove from this group</button>}
          <button className="btn ghost danger" onClick={() => void bulk('delete')}>Delete</button>
          <button className="btn ghost" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      {importing && <ContactImport onClose={() => setImporting(false)} onDone={() => void refresh()} />}

      {dups && (
        <div className="contact-drawer">
          <h3 style={{ marginTop: 0 }}>Possible duplicates</h3>
          {dups.length === 0 && <p style={{ margin: 0 }}>No duplicates found.</p>}
          {dups.map((d) => (
            <div key={`${d.a.id}-${d.b.id}`} className="contact-row">
              <span style={{ flex: 1, fontSize: 12.5 }}>
                <b>{d.a.displayName || d.a.emails[0]}</b> ({d.a.emails.join(', ')}) + <b>{d.b.displayName || d.b.emails[0]}</b> ({d.b.emails.join(', ')})
                <span className="contact-tag" style={{ marginLeft: 6 }}>same {d.reason}</span>
              </span>
              <button className="btn ghost" onClick={async () => {
                await api.post('/api/contacts/merge', { keepId: d.a.id, mergeId: d.b.id });
                setDups(await api.get<DupPair[]>('/api/contacts/duplicates')); await refresh(); toast('Merged');
              }}>Merge</button>
            </div>
          ))}
          <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => setDups(null)}>Close</button>
        </div>
      )}

      <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid var(--md-border)', borderRadius: 8 }}>
        {contacts.map((c) => (
          <div key={c.id} className={`contact-row ${sel.has(c.id) ? 'sel' : ''}`} style={{ opacity: c.hidden ? 0.55 : 1 }}>
            <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.displayName || c.emails[0]}`} />
            <span className="avatar-dot">{(c.displayName || c.emails[0] || '?')[0].toUpperCase()}</span>
            <button className="btn ghost" style={{ width: 170, justifyContent: 'flex-start', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => void open(c)}>{c.displayName || '—'}</button>
            <span style={{ flex: 1, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.emails.join(', ')}{c.org ? ` · ${c.org}` : ''}</span>
            {c.autoCreated ? <span className="contact-tag">auto-saved</span> : null}
            {c.hidden ? <span className="contact-tag">hidden</span> : null}
            <span style={{ width: 120, fontSize: 11.5, color: 'var(--md-text-faint)', textAlign: 'right' }} title={`sent ${c.sentCount} / received ${c.receivedCount}`}>
              {c.sentCount + c.receivedCount}× · {when(c.lastInteractionAt)}
            </span>
            {c.autoCreated && <button className="btn ghost" onClick={async () => { await api.post(`/api/contacts/${c.id}/promote`); await refresh(); }}>Keep</button>}
            <button className="btn ghost" onClick={() => { setDetail(null); setEdit(toDraft(c)); }}>Edit</button>
          </div>
        ))}
        {contacts.length === 0 && <p style={{ color: 'var(--md-text-faint)', padding: 12, margin: 0 }}>No contacts here yet — send some mail, add one, or import a file.</p>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <button className="btn ghost" onClick={async () => { await api.post('/api/contacts/harvest'); await refresh(); toast('Addressbook rebuilt from your mail'); }}>Rebuild from mail</button>
        <button className="btn ghost danger" disabled={autoCount === 0 && filter !== 'auto'} onClick={async () => {
          if (!window.confirm('Delete ALL auto-saved contacts? Contacts you added, edited or kept are not touched.')) return;
          const r = await api.del<{ deleted: number }>('/api/contacts?autoSaved=1&confirm=1');
          toast(`Deleted ${r.deleted} auto-saved contacts`); await refresh();
        }}>Delete all auto-saved contacts</button>
      </div>

      {detail && (
        <div className="contact-drawer">
          <h3 style={{ marginTop: 0 }}>{detail.contact.displayName || detail.contact.emails[0]}</h3>
          <p style={{ margin: '2px 0' }}>{detail.contact.emailsDetail.map((e) => `${e.email}${e.label ? ` (${e.label})` : ''}`).join(' · ')}</p>
          {detail.contact.org && <p style={{ margin: '2px 0' }}>{detail.contact.org}</p>}
          {detail.contact.phones.length > 0 && <p style={{ margin: '2px 0' }}>{detail.contact.phones.map((p) => `${p.value} (${p.label})`).join(' · ')}</p>}
          <p style={{ margin: '2px 0', color: 'var(--md-text-faint)' }}>Sent {detail.contact.sentCount} · received {detail.contact.receivedCount} · last {when(detail.contact.lastInteractionAt)}</p>
          <h4 style={{ marginBottom: 4 }}>Recent conversations</h4>
          {detail.conversations.length === 0 && <p style={{ margin: 0 }}>None found.</p>}
          {detail.conversations.map((m) => <div key={m.id} style={{ fontSize: 12.5 }}>{new Date(m.date).toLocaleDateString()} · {m.subject || '(no subject)'}</div>)}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn ghost" onClick={() => search(`from:${detail.contact.emails[0]}`)}>Mail from them</button>
            <button className="btn ghost" onClick={() => search(`to:${detail.contact.emails[0]}`)}>Mail to them</button>
            <button className="btn ghost" onClick={() => setDetail(null)}>Close</button>
          </div>
        </div>
      )}

      {edit && (
        <div className="contact-drawer">
          <h3 style={{ marginTop: 0 }}>{edit.id ? 'Edit contact' : 'Add contact'}</h3>
          <div className="field-row">
            <div className="field"><label>Name</label><input className="text-input" value={edit.displayName} onChange={(e) => setEdit({ ...edit, displayName: e.target.value })} /></div>
            <div className="field"><label>Organisation</label><input className="text-input" value={edit.org} onChange={(e) => setEdit({ ...edit, org: e.target.value })} /></div>
          </div>
          <div className="field"><label>Email addresses</label>
            {edit.emails.map((m, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <input className="text-input" style={{ flex: 1 }} placeholder="name@example.com" value={m.email} onChange={(e) => setEdit({ ...edit, emails: edit.emails.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)) })} />
                <select className="text-input" value={m.label} onChange={(e) => setEdit({ ...edit, emails: edit.emails.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}>
                  <option value="">label</option><option value="work">Work</option><option value="home">Home</option><option value="other">Other</option>
                </select>
                <button className="btn ghost" aria-label="Remove email" onClick={() => setEdit({ ...edit, emails: edit.emails.filter((_, j) => j !== i) })}>×</button>
              </div>
            ))}
            <button className="btn ghost" onClick={() => setEdit({ ...edit, emails: [...edit.emails, { email: '', label: '' }] })}>+ Add email</button>
          </div>
          <div className="field"><label>Phones</label>
            {edit.phones.map((p, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <input className="text-input" style={{ flex: 1 }} value={p.value} onChange={(e) => setEdit({ ...edit, phones: edit.phones.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                <select className="text-input" value={p.label} onChange={(e) => setEdit({ ...edit, phones: edit.phones.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}>
                  <option value="mobile">Mobile</option><option value="work">Work</option><option value="home">Home</option><option value="other">Other</option>
                </select>
                <button className="btn ghost" aria-label="Remove phone" onClick={() => setEdit({ ...edit, phones: edit.phones.filter((_, j) => j !== i) })}>×</button>
              </div>
            ))}
            <button className="btn ghost" onClick={() => setEdit({ ...edit, phones: [...edit.phones, { label: 'mobile', value: '' }] })}>+ Add phone</button>
          </div>
          <div className="field"><label>Groups</label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {groups.map((g) => (
                <label key={g.id} className="checkbox-line"><input type="checkbox" checked={edit.groupIds.includes(g.id)}
                  onChange={(e) => setEdit({ ...edit, groupIds: e.target.checked ? [...edit.groupIds, g.id] : edit.groupIds.filter((x) => x !== g.id) })} />{g.name}</label>
              ))}
              {groups.length === 0 && <span style={{ color: 'var(--md-text-faint)' }}>No groups yet — create one below.</span>}
            </div>
          </div>
          <div className="field"><label>Notes</label><input className="text-input" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></div>
          <label className="checkbox-line"><input type="checkbox" checked={edit.hidden} onChange={(e) => setEdit({ ...edit, hidden: e.target.checked })} /> Hidden (kept, but out of autocomplete and CardDAV)</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn primary" onClick={() => void save()}>Save contact</button>
            <button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
            {edit.id && <button className="btn ghost danger" onClick={async () => {
              if (!window.confirm(`Delete ${edit.displayName || 'this contact'}?`)) return;
              await api.del(`/api/contacts/${edit.id}`); setEdit(null); await refresh();
            }}>Delete</button>}
          </div>
        </div>
      )}

      <h3 style={{ marginTop: 22 }}>Groups</h3>
      <p className="settings-desc">Type a group name in To and it expands to everyone in it.</p>
      {groups.map((g) => (
        <div key={g.id} className="contact-row" style={{ border: 'none' }}>
          <b style={{ flex: 1 }}>{g.name}</b><span style={{ color: 'var(--md-text-faint)' }}>{g.memberCount} people</span>
          <button className="btn ghost" onClick={async () => {
            const name = window.prompt('Rename group', g.name);
            if (name && name.trim()) { try { await api.put(`/api/contact-groups/${g.id}`, { name }); await refresh(); } catch (e: any) { toast(e?.message ?? 'Could not rename', 'error'); } }
          }}>Rename</button>
          <button className="btn ghost danger" onClick={async () => {
            if (!window.confirm(`Delete the group "${g.name}"? The contacts stay.`)) return;
            await api.del(`/api/contact-groups/${g.id}`); if (groupId === g.id) setGroupId(0); await refresh();
          }}>Delete</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <input className="text-input" style={{ width: 200 }} placeholder="New group name" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
        <button className="btn ghost" disabled={!newGroup.trim()} onClick={async () => {
          try { await api.post('/api/contact-groups', { name: newGroup }); setNewGroup(''); await refresh(); } catch (e: any) { toast(e?.message ?? 'Could not create', 'error'); }
        }}>Add group</button>
      </div>
    </div>
  );
}
