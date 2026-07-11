import { useCallback, useRef, useState } from 'react';
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
import type { ComposePayload } from '@seamless/shared';
import { useCompose, type Draft } from '../state/compose.ts';
import AddressField from './AddressField.tsx';
import { useMail } from '../state/mail.ts';
import { sendMail, saveDraftApi, scheduleMail, uploadFile, api } from '../api/client.ts';
import { toast } from '../toast.ts';
import {
  MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon, UndoIcon, RedoIcon, BoldIcon, ItalicIcon,
  UnderlineIcon, StrikethroughIcon, HighlightIcon, BulletListIcon, NumberedListIcon, QuoteIcon, CodeIcon,
  AlignLeftIcon, AlignCenterIcon, AlignRightIcon, LinkIcon, ImageIcon, ClearFormatIcon, AttachIcon, SparkleIcon, EyeIcon, TrashIcon,
  ScheduledIcon, CaretDownIcon,
} from '../icons.tsx';

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

  const editor = useEditor({
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

  const payload = useCallback((): ComposePayload => ({
    accountId: draft.identity?.accountId ?? 0,
    fromEmail: draft.identity?.email ?? '',
    to: draft.to, cc: draft.cc, bcc: draft.bcc,
    subject: draft.subject,
    html: editor?.getHTML() ?? '',
    inReplyTo: draft.inReplyTo,
    replyToEmailId: draft.replyToEmailId,
    attachmentIds: draft.attachments.map((a) => a.id),
    track: draft.track,
    draftId: draft.draftId,
  }), [draft, editor]);

  const doSend = async () => {
    if (!draft.identity) { toast('Add an account first (Settings > Accounts)', 'error'); return; }
    if (draft.to.length === 0) { toast('Add at least one recipient', 'error'); return; }
    setSending(true);
    try {
      await sendMail(payload());
      toast('Message sent');
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
      await scheduleMail(payload(), at);
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
      <div className="compose-win minimized">
        <div className="compose-head" onClick={() => update(draft.key, { minimized: false })}>
          <span className="t">{draft.subject || 'New message'}</span>
          <button className="icon-btn" onClick={(e) => { e.stopPropagation(); void doSaveDraft(); }} title="Close (saves draft)"><CloseIcon /></button>
        </div>
      </div>
    );
  }

  const tb = (active: boolean, title: string, glyph: ReactNode, run: () => void) => (
    <button className={`icon-btn ${active ? 'active' : ''}`} title={title}
      onMouseDown={(e) => e.preventDefault()} onClick={run}>{glyph}</button>
  );

  return (
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
          {tb(!!editor?.isActive('blockquote'), 'Quote', <QuoteIcon />, () => editor?.chain().focus().toggleBlockquote().run())}
          {tb(!!editor?.isActive('codeBlock'), 'Code', <CodeIcon />, () => editor?.chain().focus().toggleCodeBlock().run())}
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
        </div>

        <div className="editor-scroll">
          <EditorContent editor={editor} />
        </div>

        {draft.attachments.length > 0 && (
          <div className="compose-atts">
            {draft.attachments.map((a) => (
              <span key={a.id} className="addr-chip">
                <AttachIcon size={13} /> {a.filename} ({fmtSize(a.size)})
                <button onClick={() => update(draft.key, { attachments: draft.attachments.filter((x) => x.id !== a.id) })} aria-label="Remove attachment"><CloseIcon size={13} /></button>
              </span>
            ))}
          </div>
        )}

        <div className="compose-foot">
          <div className="send-split">
            <button className="btn primary" disabled={sending} onClick={doSend}>{sending ? 'Sending…' : 'Send'}</button>
            <button className="btn primary split-caret" disabled={sending} title="Send later" onClick={() => setScheduleOpen((v) => !v)}><CaretDownIcon size={14} /></button>
            {scheduleOpen && (
              <div className="schedule-menu">
                <div className="schedule-head"><ScheduledIcon size={14} /> Send later</div>
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
          <label className="track-toggle" title="Insert an invisible tracking pixel to see when the message is opened">
            <input type="checkbox" checked={draft.track} onChange={(e) => update(draft.key, { track: e.target.checked })} />
            <EyeIcon size={14} /> Track opens
          </label>
          <button className="icon-btn" title="Discard" onClick={() => close(draft.key)}><TrashIcon /></button>
        </div>
      </div>
    </div>
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
