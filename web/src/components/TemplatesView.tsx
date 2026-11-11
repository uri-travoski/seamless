/**
 * Templates (T1 F-12): the sidebar's Templates view and Settings → Templates.
 * List grouped by category; click "Use" to start a message from one; edit with placeholders.
 */
import { useEffect, useMemo, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import { TEMPLATE_PLACEHOLDERS, type ApiTemplate } from '@seamless/shared';
import { useTemplates } from '../state/templates.ts';
import { useCompose } from '../state/compose.ts';
import { toast } from '../toast.ts';
import { TemplateIcon, PencilIcon, TrashIcon, ComposeIcon, PlusSimpleIcon, BoldIcon, ItalicIcon, UnderlineIcon, BulletListIcon, LinkIcon } from '../icons.tsx';

type Editing = Partial<ApiTemplate> & { name: string; bodyHtml: string };

function TemplateEditor({ value, onSave, onCancel }: { value: Editing; onSave: (t: Editing) => Promise<void>; onCancel: () => void }) {
  const identities = useCompose((s) => s.identities);
  const [t, setT] = useState<Editing>(value);
  const [busy, setBusy] = useState(false);
  const editor = useEditor({ extensions: [StarterKit, Underline, Link.configure({ openOnClick: false })], content: value.bodyHtml || '<p></p>' });
  const accounts = identities.filter((i) => !i.isAlias);

  const insert = (token: string) => editor?.chain().focus().insertContent(token).run();
  const save = async () => {
    if (!t.name.trim()) { toast('Give the template a name', 'error'); return; }
    setBusy(true);
    try { await onSave({ ...t, bodyHtml: editor?.getHTML() ?? '' }); } finally { setBusy(false); }
  };

  return (
    <div className="tpl-editor">
      <div className="field-row">
        <div className="field"><label>Name</label><input className="text-input" autoFocus value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></div>
        <div className="field"><label>Category</label><input className="text-input" list="tpl-cats" placeholder="e.g. Sales" value={t.category ?? ''} onChange={(e) => setT({ ...t, category: e.target.value })} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label>Subject</label><input className="text-input" value={t.subject ?? ''} placeholder="Quote for {{?Job}}" onChange={(e) => setT({ ...t, subject: e.target.value })} /></div>
        <div className="field" style={{ maxWidth: 160 }}><label>Shortcut</label><input className="text-input" value={t.shortcut ?? ''} placeholder=";quote" onChange={(e) => setT({ ...t, shortcut: e.target.value })} /></div>
      </div>
      <div className="field"><label>Default From</label>
        <select className="text-input" value={t.accountId ?? ''} onChange={(e) => setT({ ...t, accountId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Whatever is selected in compose</option>
          {accounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.name ? `${a.name} <${a.email}>` : a.email}</option>)}
        </select>
      </div>
      <div className="field"><label>Body</label>
        <div className="tpl-body">
          <div className="editor-toolbar">
            <button className="icon-btn" title="Bold" onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleBold().run()}><BoldIcon size={16} /></button>
            <button className="icon-btn" title="Italic" onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleItalic().run()}><ItalicIcon size={16} /></button>
            <button className="icon-btn" title="Underline" onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleUnderline().run()}><UnderlineIcon size={16} /></button>
            <button className="icon-btn" title="Bullet list" onMouseDown={(e) => e.preventDefault()} onClick={() => editor?.chain().focus().toggleBulletList().run()}><BulletListIcon size={16} /></button>
            <button className="icon-btn" title="Link" onMouseDown={(e) => e.preventDefault()} onClick={() => { const u = window.prompt('Link URL'); if (u) editor?.chain().focus().setLink({ href: u }).run(); }}><LinkIcon size={16} /></button>
          </div>
          <div className="editor-scroll"><EditorContent editor={editor} /></div>
        </div>
      </div>
      <div className="placeholder-help">
        <span className="dim">Insert:</span>
        {TEMPLATE_PLACEHOLDERS.map((p) => (
          <button key={p.token} className="chip-choice" title={p.help} onClick={() => insert(p.token === '{{?Question}}' ? '{{?Your question}}' : p.token)}>{p.token}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save template'}</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export default function TemplatesView({ embedded = false }: { embedded?: boolean }) {
  const list = useTemplates((s) => s.list);
  const refresh = useTemplates((s) => s.refresh);
  const save = useTemplates((s) => s.save);
  const remove = useTemplates((s) => s.remove);
  const openTemplate = useCompose((s) => s.openTemplate);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  useEffect(() => { void refresh(); }, [refresh]);

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const g: Record<string, ApiTemplate[]> = {};
    for (const t of list) {
      if (f && !`${t.name} ${t.subject} ${t.category} ${t.shortcut ?? ''}`.toLowerCase().includes(f)) continue;
      (g[t.category || 'General'] ??= []).push(t);
    }
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [list, filter]);

  const current = list.find((t) => t.id === selected) ?? null;
  const categories = [...new Set(list.map((t) => t.category).filter(Boolean))];

  return (
    <section className={embedded ? '' : 'page templates-page'}>
      {!embedded && (
        <div className="page-head">
          <h1 className="page-title"><TemplateIcon size={20} /> Templates</h1>
          <div style={{ flex: 1 }} />
          <button className="btn primary" onClick={() => { setSelected(null); setEditing({ name: '', bodyHtml: '<p>Hi {{recipient.first_name}},</p><p></p><p>{{sender.name}}</p>', category: '' }); }}>
            <PlusSimpleIcon size={15} /> New template
          </button>
        </div>
      )}
      {embedded && (
        <button className="btn primary" style={{ marginBottom: 12 }} onClick={() => { setSelected(null); setEditing({ name: '', bodyHtml: '<p>Hi {{recipient.first_name}},</p><p></p><p>{{sender.name}}</p>', category: '' }); }}>
          <PlusSimpleIcon size={15} /> New template
        </button>
      )}
      <datalist id="tpl-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="tpl-layout">
        <div className="tpl-list">
          <input className="text-input compact" placeholder="Find a template…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {list.length === 0 && <div className="empty-state"><TemplateIcon size={28} /><p>No templates yet.</p><p className="dim">Write one here, or use “Save as template” in the compose window. Type its <code>;shortcut</code> in a message to drop it in.</p></div>}
          {groups.map(([cat, items]) => (
            <div key={cat}>
              <div className="switch-head">{cat}</div>
              {items.map((t) => (
                <button key={t.id} className={`side-item ${selected === t.id ? 'active' : ''}`} onClick={() => { setSelected(t.id); setEditing(null); }}>
                  <span className="name">{t.name}</span>
                  {t.shortcut && <code className="tpl-key">{t.shortcut}</code>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="tpl-detail">
          {editing ? (
            <TemplateEditor key={editing.id ?? 'new'} value={editing}
              onCancel={() => setEditing(null)}
              onSave={async (t) => {
                try { const id = await save(t); setEditing(null); setSelected(id); toast('Template saved'); }
                catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
              }} />
          ) : current ? (
            <div>
              <div className="tpl-head">
                <div>
                  <h2 className="tpl-title">{current.name}</h2>
                  <div className="dim">{current.category || 'General'}{current.shortcut ? ` · ${current.shortcut}` : ''} · used {current.useCount}×</div>
                </div>
                <div style={{ flex: 1 }} />
                <button className="btn primary" onClick={() => void openTemplate(current)}><ComposeIcon size={15} /> Use</button>
                <button className="btn" onClick={() => setEditing({ ...current })}><PencilIcon size={15} /> Edit</button>
                <button className="btn ghost danger" onClick={async () => { if (window.confirm(`Delete “${current.name}”?`)) { await remove(current.id); setSelected(null); } }}><TrashIcon size={15} /></button>
              </div>
              {current.subject && <div className="tpl-subject"><span className="dim">Subject:</span> {current.subject}</div>}
              <div className="tpl-preview" dangerouslySetInnerHTML={{ __html: current.bodyHtml }} />
            </div>
          ) : (
            <div className="empty-state"><TemplateIcon size={32} /><p>Pick a template to preview it, or make a new one.</p></div>
          )}
        </div>
      </div>
    </section>
  );
}
