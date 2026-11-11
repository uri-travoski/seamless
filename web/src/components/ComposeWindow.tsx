import { useCallback, useEffect, useRef, useState } from 'react';
import { createDisposableAddress } from './settings/DisposableSettings.tsx';
import type { ReactNode } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import TextStyle from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { renderTemplate, hasRecipientTokens, type ComposePayload, type ApiTemplate } from '@seamless/shared';
import { useTemplates, fillTemplate } from '../state/templates.ts';
import { NO_AUTOFILL } from '../state/ui.ts';
import { useCompose, type Draft } from '../state/compose.ts';
import { FollowupChoices } from './FollowupMenu.tsx';
import AddressField from './AddressField.tsx';
import { useMail } from '../state/mail.ts';
import { sendMail, undoSendApi, saveDraftApi, scheduleMail, uploadFile, api } from '../api/client.ts';
import { toast, countdownToast } from '../toast.ts';
import {
  MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon, UndoIcon, RedoIcon, BoldIcon, ItalicIcon,
  UnderlineIcon, StrikethroughIcon, HighlightIcon, BulletListIcon, NumberedListIcon,
  AlignLeftIcon, AlignCenterIcon, AlignRightIcon, LinkIcon, ImageIcon, ClearFormatIcon, AttachIcon, SparkleIcon, EyeIcon, TrashIcon,
  ScheduledIcon, CaretDownIcon, TemplateIcon, KebabIcon, AlarmIcon,
} from '../icons.tsx';
import { IconContext } from '@phosphor-icons/react';

interface QuickTime { label: string; at: number }

function quickScheduleTimes(): QuickTime[] {
  const now = new Date();
  const out: QuickTime[] = [];
  const fmt = (d: Date) => d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const inHour = new Date(now.getTime() + 3_600_000);
  out.push({ label: `In 1 hour · ${inHour.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, at: inHour.getTime() });
  const evening = new Date(now); evening.setHours(18, 0, 0, 0);
  if (evening.getTime() > now.getTime() + 1_800_000) out.push({ label: `This evening · ${fmt(evening)}`, at: evening.getTime() });
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(8, 0, 0, 0);
  out.push({ label: `Tomorrow morning · ${fmt(tomorrow)}`, at: tomorrow.getTime() });
  const monday = new Date(now); const add = ((8 - monday.getDay()) % 7) || 7; monday.setDate(now.getDate() + add); monday.setHours(8, 0, 0, 0);
  out.push({ label: `Monday morning · ${fmt(monday)}`, at: monday.getTime() });
  return out;
}

function fmtSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ComposeWindow({ draft }: { draft: Draft }) {
  const update = useCompose((s) => s.update);
  const close = useCompose((s) => s.close);
  const identities = useCompose((s) => s.identities);
  const [showCcBcc, setShowCcBcc] = useState(draft.cc.length > 0 || draft.bcc.length > 0);
  const [sending, setSending] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [customDt, setCustomDt] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  /** Sign-up forms: mint a throw-away address on the first own domain and send from it. */
  const makeDisposable = async () => {
    try {
      const { domains } = await api.get<{ domains: { domain: string }[] }>('/api/disposable');
      if (!domains.length) { toast('Set up an own-domain mailbox first (Settings > Mailboxes)', 'error'); return; }
      const label = (draft.subject || '').trim().slice(0, 60);
      const d = await createDisposableAddress({ domain: domains[0].domain, generator: 'words', label });
      await useCompose.getState().loadIdentities();
      const identity = useCompose.getState().identities.find((i) => i.email === d.address) ?? null;
      update(draft.key, { identity });
      void navigator.clipboard?.writeText(d.address).catch(() => {});
      toast(`Sending from ${d.address} (copied)`);
    } catch (e: any) { toast(e?.message ?? 'Could not create an address', 'error'); }
  };
  const templates = useTemplates((s) => s.list);
  const [tplOpen, setTplOpen] = useState(false);
  const [tplFilter, setTplFilter] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [fuOpen, setFuOpen] = useState(false);
  useEffect(() => { if (!useTemplates.getState().loaded) void useTemplates.getState().refresh(); }, []);

  // latest draft for the editor's key handler (it's created once)
  const draftRef = useRef(draft);
  draftRef.current = draft;

  /** Insert a template at the cursor (subject too, if empty). */
  const insertTemplate = async (t: ApiTemplate, replaceRange?: { from: number; to: number }) => {
    const d = draftRef.current;
    const filled = await fillTemplate(t, { identity: d.identity, to: d.to, subject: d.subject });
    if (!filled || !editorRef.current) return;
    const chain = editorRef.current.chain().focus();
    if (replaceRange) chain.deleteRange(replaceRange);
    chain.insertContent(filled.html).run();
    if (!d.subject && filled.subject) update(d.key, { subject: filled.subject });
  };
  const insertRef = useRef(insertTemplate);
  insertRef.current = insertTemplate;
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  const editor = useEditor({
    editorProps: {
      // ;shortcut + space / Tab / Enter expands the matching template
      handleKeyDown: (view, event) => {
        if (event.key !== ' ' && event.key !== 'Tab' && event.key !== 'Enter') return false;
        const { $from } = view.state.selection;
        const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
        const m = before.match(/(?:^|\s)(;[a-z0-9_-]{1,30})$/i);
        if (!m) return false;
        const t = useTemplates.getState().list.find((x) => x.shortcut === m[1].toLowerCase());
        if (!t) return false;
        event.preventDefault();
        void insertRef.current(t, { from: $from.pos - m[1].length, to: $from.pos });
        return true;
      },
    },
    extensions: [
      StarterKit,
      Underline,
      Link.configure({ openOnClick: false }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Image.configure({ allowBase64: true }),
      Placeholder.configure({ placeholder: 'Write your message…' }),
    ],
    content: draft.initialHtml,
  });
  editorRef.current = editor;

  const payload = useCallback((forSend = false): ComposePayload => {
    let html = editor?.getHTML() ?? '';
    let subject = draft.subject;
    // template placeholders waiting for a recipient are filled now
    if (forSend && (hasRecipientTokens(html) || hasRecipientTokens(subject))) {
      const ctx = { recipient: draft.to[0] ?? null };
      html = renderTemplate(html, ctx, { html: true });
      subject = renderTemplate(subject, ctx);
    }
    return {
    accountId: draft.identity?.accountId ?? 0,
    fromEmail: draft.identity?.email ?? '',
    to: draft.to, cc: draft.cc, bcc: draft.bcc,
    subject,
    html,
    inReplyTo: draft.inReplyTo,
    replyToEmailId: draft.replyToEmailId,
    attachmentIds: draft.attachments.map((a) => a.id),
    attachments: draft.attachments,
    followupDays: draft.followupDays,
    track: draft.track,
    perRecipientTracking: draft.track && draft.perRecipientTracking,
    draftId: draft.draftId,
  };
  }, [draft, editor]);

  const doSend = async () => {
    if (!draft.identity) { toast('Add an account first (Settings > Accounts)', 'error'); return; }
    if (draft.to.length === 0) { toast('Add at least one recipient', 'error'); return; }
    setSending(true);
    try {
      const res = await sendMail(payload(true));
      if (res.queued && res.jobId && res.releaseAt) {
        const jobId = res.jobId;
        const stop = countdownToast((n) => `Sending in ${n}s…`, res.releaseAt, async () => {
          try {
            const back = await undoSendApi(jobId);
            stop();
            useCompose.getState().openFromPayload(back.payload);
            toast('Send cancelled — your message is back in the editor');
          } catch { stop(); toast('Too late — it has already been sent', 'error'); }
        });
      } else toast('Message sent');
      close(draft.key);
      void useMail.getState().refreshCurrent();
    } catch (e: any) {
      toast(`Send failed: ${e?.message ?? 'unknown error'}`, 'error');
      setSending(false);
    }
  };

  const doSchedule = async (at: number) => {
    if (!draft.identity) { toast('Add an account first (Settings > Accounts)', 'error'); return; }
    if (draft.to.length === 0) { toast('Add at least one recipient', 'error'); return; }
    if (!Number.isFinite(at) || at <= Date.now()) { toast('Pick a time in the future', 'error'); return; }
    setScheduleOpen(false);
    setSending(true);
    try {
      await scheduleMail(payload(true), at);
      toast(`Scheduled for ${new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`);
      close(draft.key);
      void useMail.getState().refreshCurrent();
    } catch (e: any) {
      toast(`Could not schedule: ${e?.message ?? 'unknown error'}`, 'error');
      setSending(false);
    }
  };

  const doSaveDraft = async () => {
    if (!draft.identity) { close(draft.key); return; }
    const html = editor?.getHTML() ?? '';
    const isEmpty = draft.to.length === 0 && !draft.subject && html.replace(/<[^>]+>/g, '').trim() === '';
    if (isEmpty) { close(draft.key); return; }
    try {
      await saveDraftApi(payload());
      toast('Draft saved');
    } catch {
      toast('Draft could not be saved', 'error');
    }
    close(draft.key);
  };

  const attach = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      try {
        const meta = await uploadFile(file);
        update(draft.key, { attachments: [...useCompose.getState().windows.find((w) => w.key === draft.key)!.attachments, meta] });
      } catch {
        toast(`Upload failed: ${file.name}`, 'error');
      }
    }
  };

  const saveAsTemplate = async () => {
    const name = window.prompt('Template name', draft.subject || 'New template');
    if (!name?.trim()) return;
    try {
      await useTemplates.getState().save({ name: name.trim(), subject: draft.subject, bodyHtml: editor?.getHTML() ?? '', accountId: draft.identity?.accountId ?? null, category: '' });
      toast(`Saved “${name.trim()}” to Templates`);
    } catch (e: any) { toast(e?.message ?? 'Could not save the template', 'error'); }
  };

  const aiDraft = async () => {
    if (!draft.replyToEmailId) { toast('AI draft works on replies', 'error'); return; }
    setAiBusy(true);
    try {
      const res = await api.post<{ draft: string }>('/api/ai/draft', { emailId: draft.replyToEmailId, instruction: '' });
      const paragraphs = res.draft.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
      editor?.commands.insertContentAt(0, paragraphs);
    } catch (e: any) {
      toast(e?.message ?? 'AI draft failed', 'error');
    } finally {
      setAiBusy(false);
    }
  };

  if (draft.minimized) {
    return (
      <IconContext.Provider value={{ weight: 'regular', size: 16 }}>
      <div className="compose-win minimized">
        <div className="compose-head" onClick={() => update(draft.key, { minimized: false })}>
          <span className="t">{draft.subject || 'New message'}</span>
          <button className="icon-btn" onClick={(e) => { e.stopPropagation(); void doSaveDraft(); }} title="Close (saves draft)"><CloseIcon /></button>
        </div>
      </div>
      </IconContext.Provider>
    );
  }

  const tb = (active: boolean, title: string, glyph: ReactNode, run: () => void) => (
    <button className={`icon-btn ${active ? 'active' : ''}`} title={title}
      onMouseDown={(e) => e.preventDefault()} onClick={run}>{glyph}</button>
  );

  return (
    <IconContext.Provider value={{ weight: 'regular', size: 16 }}>
    <div className={`compose-win ${draft.maximized ? 'maximized' : ''}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void attach(e.dataTransfer.files); }}>
      <div className="compose-head" onClick={() => update(draft.key, { minimized: true })}>
        <span className="t">{draft.subject || 'New message'}</span>
        <button className="icon-btn" title="Minimize" onClick={(e) => { e.stopPropagation(); update(draft.key, { minimized: true }); }}><MinimizeIcon /></button>
        <button className="icon-btn" title={draft.maximized ? 'Restore' : 'Maximize'} onClick={(e) => { e.stopPropagation(); update(draft.key, { maximized: !draft.maximized }); }}>{draft.maximized ? <RestoreIcon /> : <MaximizeIcon />}</button>
        <button className="icon-btn" title="Close (saves draft)" onClick={(e) => { e.stopPropagation(); void doSaveDraft(); }}><CloseIcon /></button>
      </div>
      <div className="compose-body">
        <div className="compose-row">
          <span className="lbl">From</span>
          <select
            value={draft.identity ? `${draft.identity.accountId}|${draft.identity.email}` : ''}
            onChange={(e) => {
              const [accountId, email] = e.target.value.split('|');
              const identity = identities.find((i) => i.accountId === Number(accountId) && i.email === email) ?? null;
              update(draft.key, { identity });
            }}
          >
            {identities.map((i) => (
              <option key={`${i.accountId}|${i.email}`} value={`${i.accountId}|${i.email}`}>
                {i.name ? `${i.name} <${i.email}>` : i.email}{i.isAlias ? ' (alias)' : ''}
              </option>
            ))}
          </select>
          <button className="cc-toggle" title="Create a throw-away address on your own domain and send from it" onClick={() => void makeDisposable()}>Use a disposable address</button>
          <div style={{ flex: 1 }} />
          {!showCcBcc && <button className="cc-toggle" onClick={() => setShowCcBcc(true)}>Cc / Bcc</button>}
        </div>
        <AddressFieldWrapper draft={draft} field="to" label="To" autoFocus={!draft.replyToEmailId} />
        {showCcBcc && <AddressFieldWrapper draft={draft} field="cc" label="Cc" />}
        {showCcBcc && <AddressFieldWrapper draft={draft} field="bcc" label="Bcc" />}
        <div className="compose-row">
          <span className="lbl">Subj</span>
          <input value={draft.subject} onChange={(e) => update(draft.key, { subject: e.target.value })} placeholder="Subject" />
        </div>

        <div className="editor-toolbar">
          {tb(false, 'Undo', <UndoIcon />, () => editor?.chain().focus().undo().run())}
          {tb(false, 'Redo', <RedoIcon />, () => editor?.chain().focus().redo().run())}
          <span className="sep" />
          {tb(!!editor?.isActive('bold'), 'Bold', <BoldIcon />, () => editor?.chain().focus().toggleBold().run())}
          {tb(!!editor?.isActive('italic'), 'Italic', <ItalicIcon />, () => editor?.chain().focus().toggleItalic().run())}
          {tb(!!editor?.isActive('underline'), 'Underline', <UnderlineIcon />, () => editor?.chain().focus().toggleUnderline().run())}
          {tb(!!editor?.isActive('strike'), 'Strikethrough', <StrikethroughIcon />, () => editor?.chain().focus().toggleStrike().run())}
          <input type="color" title="Text color" onChange={(e) => editor?.chain().focus().setColor(e.target.value).run()} />
          {tb(!!editor?.isActive('highlight'), 'Highlight', <HighlightIcon />, () => editor?.chain().focus().toggleHighlight({ color: '#fff3a3' }).run())}
          <span className="sep" />
          {tb(!!editor?.isActive('bulletList'), 'Bullet list', <BulletListIcon />, () => editor?.chain().focus().toggleBulletList().run())}
          {tb(!!editor?.isActive('orderedList'), 'Numbered list', <NumberedListIcon />, () => editor?.chain().focus().toggleOrderedList().run())}
          <span className="sep" />
          {tb(!!editor?.isActive({ textAlign: 'left' }), 'Align left', <AlignLeftIcon />, () => editor?.chain().focus().setTextAlign('left').run())}
          {tb(!!editor?.isActive({ textAlign: 'center' }), 'Center', <AlignCenterIcon />, () => editor?.chain().focus().setTextAlign('center').run())}
          {tb(!!editor?.isActive({ textAlign: 'right' }), 'Align right', <AlignRightIcon />, () => editor?.chain().focus().setTextAlign('right').run())}
          <span className="sep" />
          {tb(!!editor?.isActive('link'), 'Link', <LinkIcon />, () => {
            if (editor?.isActive('link')) { editor.chain().focus().unsetLink().run(); return; }
            const url = window.prompt('Link URL');
            if (url) editor?.chain().focus().setLink({ href: url }).run();
          })}
          {tb(false, 'Insert image', <ImageIcon />, () => {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = 'image/*';
            input.onchange = () => {
              const f = input.files?.[0];
              if (!f) return;
              const reader = new FileReader();
              reader.onload = () => editor?.chain().focus().setImage({ src: String(reader.result) }).run();
              reader.readAsDataURL(f);
            };
            input.click();
          })}
          {tb(false, 'Clear formatting', <ClearFormatIcon />, () => editor?.chain().focus().clearNodes().unsetAllMarks().run())}
          <span className="sep" />
          <div className="label-menu">
            <button className={`icon-btn ${tplOpen ? 'active' : ''}`} title="Insert template (or type ;shortcut)"
              onMouseDown={(e) => e.preventDefault()} onClick={() => setTplOpen((v) => !v)}><TemplateIcon /></button>
            {tplOpen && (
              <div className="dropdown tpl-pop">
                <input className="text-input compact" type="search" name="seamless-template-filter" {...NO_AUTOFILL} autoFocus placeholder="Find a template…" value={tplFilter} onChange={(e) => setTplFilter(e.target.value)} />
                {templates.length === 0 && <div className="menu-empty">No templates yet — make one with “Save as template” or in Templates.</div>}
                {Object.entries(templates
                  .filter((t) => `${t.name} ${t.category} ${t.shortcut ?? ''}`.toLowerCase().includes(tplFilter.toLowerCase()))
                  .reduce<Record<string, ApiTemplate[]>>((acc, t) => { (acc[t.category || 'General'] ??= []).push(t); return acc; }, {}))
                  .map(([cat, list]) => (
                    <div key={cat}>
                      <div className="switch-head">{cat}</div>
                      {list.map((t) => (
                        <button key={t.id} className="side-item" onClick={() => { setTplOpen(false); setTplFilter(''); void insertTemplate(t); }}>
                          <span className="name">{t.name}</span>{t.shortcut && <code className="tpl-key">{t.shortcut}</code>}
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            )}
          </div>
          <button className={`icon-btn track-eye ${draft.track ? 'active' : ''}`} aria-pressed={draft.track}
            title={draft.track ? 'Open tracking ON — you will see when it is opened (click to turn off)' : 'Open tracking OFF (click to turn on)'}
            onMouseDown={(e) => e.preventDefault()} onClick={() => update(draft.key, { track: !draft.track })}>
            <EyeIcon weight={draft.track ? 'fill' : 'regular'} />
          </button>
        </div>

        <div className="editor-scroll">
          <EditorContent editor={editor} />
        </div>

        {draft.attachments.length > 0 && (
          <div className="compose-atts">
            {draft.attachments.map((a) => (
              <span key={a.id} className="addr-chip">
                <AttachIcon /> {a.filename} ({fmtSize(a.size)})
                <button onClick={() => update(draft.key, { attachments: draft.attachments.filter((x) => x.id !== a.id) })} aria-label="Remove attachment"><CloseIcon /></button>
              </span>
            ))}
          </div>
        )}

        <div className="compose-foot">
          <div className="send-split">
            <button className="btn primary" disabled={sending} onClick={doSend}>{sending ? 'Sending…' : 'Send'}</button>
            <button className="btn primary split-caret" disabled={sending} title="Send later" onClick={() => setScheduleOpen((v) => !v)}><CaretDownIcon /></button>
            {scheduleOpen && (
              <div className="schedule-menu">
                <div className="schedule-head"><ScheduledIcon /> Send later</div>
                {quickScheduleTimes().map((q) => (
                  <button key={q.label} className="side-item" onClick={() => void doSchedule(q.at)}>
                    <span className="name">{q.label}</span>
                  </button>
                ))}
                <div className="schedule-custom">
                  <input type="datetime-local" className="text-input" value={customDt} onChange={(e) => setCustomDt(e.target.value)} />
                  <button className="btn" disabled={!customDt} onClick={() => void doSchedule(new Date(customDt).getTime())}>Schedule</button>
                </div>
              </div>
            )}
          </div>
          <button className="icon-btn" title="Attach files" onClick={() => fileRef.current?.click()}><AttachIcon /></button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
          {draft.replyToEmailId && (
            <button className="btn ghost" disabled={aiBusy} onClick={aiDraft}><SparkleIcon /> {aiBusy ? 'Drafting…' : 'AI draft'}</button>
          )}
          <div className="grow" />
          {draft.followupDays && <span className="track-state" title="You will be reminded if nobody replies"><AlarmIcon size={14} /> Remind in {draft.followupDays}d</span>}
          {draft.track && <span className="track-state" title="Open tracking is on for this message"><EyeIcon weight="fill" size={14} /> Tracked{draft.perRecipientTracking ? ' per recipient' : ''}</span>}
          <div className="label-menu">
            <button className={`icon-btn ${moreOpen ? 'active' : ''}`} title="More options" onClick={() => setMoreOpen((v) => !v)}><KebabIcon /></button>
            {moreOpen && (
              <div className="dropdown up">
                <button className="side-item" onClick={() => { setMoreOpen(false); void saveAsTemplate(); }}><TemplateIcon size={15} /><span className="name">Save as template…</span></button>
                <button className="side-item" onClick={() => setFuOpen((v) => !v)} aria-expanded={fuOpen}>
                  <AlarmIcon size={15} /><span className="name">{draft.followupDays ? `Reminder: ${draft.followupDays}d if no reply` : 'Remind me if no reply…'}</span>
                </button>
                {fuOpen && (
                  <div className="followup-choices">
                    <FollowupChoices current={draft.followupDays} onPick={(days) => { update(draft.key, { followupDays: days }); setFuOpen(false); setMoreOpen(false); }} />
                    {draft.followupDays && <button className="side-item" onClick={() => { update(draft.key, { followupDays: undefined }); setFuOpen(false); setMoreOpen(false); }}><span className="name">No reminder</span></button>}
                  </div>
                )}
                <label className="side-item checkbox-line" title="Send each recipient their own copy with its own pixel, so the open report shows who opened">
                  <input type="checkbox" checked={draft.perRecipientTracking} disabled={!draft.track}
                    onChange={(e) => update(draft.key, { perRecipientTracking: e.target.checked })} />
                  <span className="name">Track each recipient separately</span>
                </label>
              </div>
            )}
          </div>
          <button className="icon-btn" title="Discard" onClick={() => close(draft.key)}><TrashIcon /></button>
        </div>
      </div>
    </div>
    </IconContext.Provider>
  );
}

function AddressFieldWrapper({ draft, field, label, autoFocus }: {
  draft: Draft; field: 'to' | 'cc' | 'bcc'; label: string; autoFocus?: boolean;
}) {
  const update = useCompose((s) => s.update);
  return (
    <AddressField label={label} value={draft[field]} autoFocus={autoFocus}
      onChange={(v) => update(draft.key, { [field]: v } as any)} />
  );
}
