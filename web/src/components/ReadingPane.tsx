import { useEffect, useRef, useState } from 'react';
import type { ApiEmail, ApiEmailBody } from '@seamless/shared';
import { useMail } from '../state/mail.ts';
import { useSession } from '../state/session.ts';
import { useCompose } from '../state/compose.ts';
import { fetchBody, api, saveNote, fetchTracking } from '../api/client.ts';
import type { TrackingInfo } from '@seamless/shared';
import { cache } from '../api/cache.ts';
import { toast } from '../toast.ts';
import LabelPicker from './LabelPicker.tsx';
import {
  EyeIcon, ImageIcon, AttachIcon, PencilIcon, ReplyIcon, ReplyAllIcon, ForwardIcon, DownloadIcon,
  EnvelopeOpenIcon, BackIcon, ArchiveIcon, JunkIcon, TrashIcon, EnvelopeIcon, SparkleIcon, CloseIcon,
  KebabIcon, SourceIcon, NoteIcon, CaretDownIcon, RestoreMailIcon,
} from '../icons.tsx';
import { IconContext } from '@phosphor-icons/react';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Short readable client label from a user-agent string. */
function clientName(ua: string): string {
  if (!ua) return 'Unknown';
  const s = ua.toLowerCase();
  const os = /iphone|ipad|ios/.test(s) ? 'iOS' : /android/.test(s) ? 'Android' : /windows/.test(s) ? 'Windows'
    : /mac os|macintosh/.test(s) ? 'Mac' : /linux/.test(s) ? 'Linux' : '';
  const app = /googleimageproxy/.test(s) ? 'Gmail proxy' : /outlook/.test(s) ? 'Outlook' : /applemail|apple mail/.test(s) ? 'Apple Mail'
    : /thunderbird/.test(s) ? 'Thunderbird' : /edg\//.test(s) ? 'Edge' : /chrome/.test(s) ? 'Chrome'
    : /firefox/.test(s) ? 'Firefox' : /safari/.test(s) ? 'Safari' : 'Email client';
  return os ? `${app} · ${os}` : app;
}

/** Sandboxed iframe (no scripts) with auto-height for HTML mail. */
function HtmlBody({ html, fontSize, fontFamily }: { html: string; fontSize: number; fontFamily: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  const fam = fontFamily.trim();
  const fontImport = fam ? `@import url('https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap');` : '';
  const stack = fam ? `'${fam.replace(/'/g, '')}', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` : '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    ${fontImport}
    body { margin: 0; font-family: ${stack};
      font-size: ${fontSize}px; line-height: 1.55; color: #23282e; word-wrap: break-word; }
    img { max-width: 100%; height: auto; }
    img.md-blocked-img { min-width: 60px; min-height: 24px; background: #f0f2f4 url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><text y="15" font-size="14">🖼</text></svg>') center no-repeat; border: 1px dashed #cdd4da; }
    blockquote { border-left: 3px solid #cdd4da; margin: 0.4em 0; padding-left: 12px; color: #5b6570; }
    pre { white-space: pre-wrap; }
    table { max-width: 100%; }
  </style></head><body>${html}</body></html>`;

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    const measure = () => {
      const h = iframe.contentDocument?.documentElement?.scrollHeight;
      if (h && Math.abs(h - height) > 4) setHeight(Math.min(h + 8, 20000));
    };
    iframe.addEventListener('load', measure);
    const t1 = setTimeout(measure, 60);
    const t2 = setTimeout(measure, 400);
    return () => { iframe.removeEventListener('load', measure); clearTimeout(t1); clearTimeout(t2); };
  }, [doc, height]);

  return <iframe ref={ref} sandbox="allow-same-origin allow-popups" srcDoc={doc} style={{ height }} title="Message" />;
}

function MessageCard({ email, expanded, onToggle }: { email: ApiEmail; expanded: boolean; onToggle: () => void }) {
  const settings = useSession((s) => s.settings);
  const openReply = useCompose((s) => s.openReply);
  const openDraft = useCompose((s) => s.openDraft);
  const patchEmail = useMail((s) => s.patchEmail);
  const [body, setBody] = useState<ApiEmailBody | null>(null);
  const [remoteLoaded, setRemoteLoaded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [trackOpen, setTrackOpen] = useState(false);
  const [tracking, setTracking] = useState<TrackingInfo | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const loadTracking = async () => {
    try { setTracking(await fetchTracking(email.id)); } catch { /* not tracked */ }
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    setBody(null);
    setRemoteLoaded(settings.allowRemoteImages);
    // cache first, then network
    void cache.getBody(email.id).then((hit) => { if (alive && hit && !settings.allowRemoteImages) { setBody(hit); setNoteDraft(hit.note ?? ''); setNoteOpen(!!hit.note); } });
    fetchBody(email.id, settings.allowRemoteImages)
      .then((b) => { if (alive) { setBody(b); setNoteDraft(b.note); setNoteOpen(!!b.note); if (!settings.allowRemoteImages) void cache.putBody(email.id, b); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [email.id, expanded, settings.allowRemoteImages]);

  const persistNote = async (val: string) => {
    try {
      await saveNote(email.id, val);
      const has = val.trim() !== '';
      patchEmail(email.id, { hasNote: has });
    } catch { toast('Could not save note', 'error'); }
  };

  const loadRemote = async () => {
    try {
      const b = await fetchBody(email.id, true);
      setBody(b);
      setRemoteLoaded(true);
    } catch { toast('Could not load remote images', 'error'); }
  };

  const from = email.from[0];
  const initials = (from?.name || from?.email || '?').trim().slice(0, 1).toUpperCase();
  const when = new Date(email.receivedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <article className="msg-card">
      <div className="card-head" onClick={onToggle}>
        <div className="avatar" style={{ background: email.accountColor }}>{initials}</div>
        <div className="who">
          <div className="from-line">
            <span className="from-name">{from?.name || from?.email}</span>
            <span className="from-addr">{from?.name ? `<${from?.email}>` : ''}</span>
          </div>
          <div className="to-line">
            to {email.to.map((a) => a.name || a.email).join(', ') || '—'}
            {email.cc.length > 0 && `, cc ${email.cc.map((a) => a.name || a.email).join(', ')}`}
            {' '}· via {email.accountEmail}
            {expanded && (
              <button className="details-toggle" title="Details"
                onClick={(e) => { e.stopPropagation(); setDetailsOpen((v) => !v); }}>
                <CaretDownIcon size={11} style={{ transform: detailsOpen ? 'rotate(180deg)' : 'none' }} />
              </button>
            )}
          </div>
        </div>
        <div className="when">{when}</div>
        {expanded && (
          <button className={`icon-btn note-btn ${email.hasNote || noteOpen ? 'has-note' : ''}`} title={email.hasNote ? 'Personal note' : 'Add note'}
            onClick={(e) => { e.stopPropagation(); setNoteOpen((v) => !v); }}><NoteIcon weight="fill" /></button>
        )}
        <div className="card-kebab" ref={menuRef} onClick={(e) => e.stopPropagation()}>
          <button className={`icon-btn ${menuOpen ? 'active' : ''}`} title="More" onClick={() => setMenuOpen((v) => !v)}><KebabIcon /></button>
          {menuOpen && (
            <div className="dropdown">
              <button className="side-item" onClick={() => { window.open(`/api/message/${email.id}/original`, '_blank', 'noopener'); setMenuOpen(false); }}>
                <SourceIcon size={15} /><span className="name">Show original</span>
              </button>
              <a className="side-item" href={`/api/raw/${email.id}`} onClick={() => setMenuOpen(false)} style={{ textDecoration: 'none' }}>
                <DownloadIcon size={15} /><span className="name">Download .eml</span>
              </a>
            </div>
          )}
        </div>
      </div>

      {!expanded && <div className="card-collapsed-preview">{email.preview}</div>}

      {expanded && (
        <>
          {detailsOpen && (
            <table className="msg-details"><tbody>
              <tr><th>From:</th><td>{from?.name ? `${from.name} <${from.email}>` : from?.email}</td></tr>
              {email.replyTo.length > 0 && <tr><th>Reply-To:</th><td>{email.replyTo.map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}</td></tr>}
              <tr><th>To:</th><td>{email.to.map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ') || '—'}</td></tr>
              {email.cc.length > 0 && <tr><th>Cc:</th><td>{email.cc.map((a) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ')}</td></tr>}
              <tr><th>Subject:</th><td>{email.subject || '(no subject)'}</td></tr>
              <tr><th>Date:</th><td>{new Date(email.receivedAt).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}</td></tr>
              <tr><th>Size:</th><td>{fmtSize(email.size)}</td></tr>
            </tbody></table>
          )}
          {noteOpen && (
            <div className="note-box">
              <div className="note-head"><NoteIcon size={14} weight="fill" /> Private note <span className="note-hint">only you can see this</span></div>
              <textarea className="note-text" value={noteDraft} placeholder="Add a personal note about this email…"
                onChange={(e) => setNoteDraft(e.target.value)} onBlur={() => void persistNote(noteDraft)} />
            </div>
          )}
          {email.openCount >= 0 && (
            <div className="track-wrap">
              <button className={`track-banner ${email.openCount > 0 ? 'clickable' : ''}`}
                onClick={() => { if (email.openCount > 0) { const n = !trackOpen; setTrackOpen(n); if (n) void loadTracking(); } }}>
                <EyeIcon size={14} /> {email.openCount === 0
                  ? 'Tracking active — not opened yet.'
                  : `Opened ${email.openCount} time${email.openCount === 1 ? '' : 's'}${email.lastOpenAt ? ` · last ${new Date(email.lastOpenAt).toLocaleString()}` : ''}`}
                {email.openCount > 0 && <CaretDownIcon size={12} style={{ marginLeft: 'auto', transform: trackOpen ? 'rotate(180deg)' : 'none' }} />}
              </button>
              {trackOpen && (
                <div className="track-log">
                  {!tracking ? <div className="track-loading">Loading opens…</div> : (
                    <table className="track-table"><thead>
                      <tr><th>#</th><th>When</th><th>IP</th><th>Client</th></tr>
                    </thead><tbody>
                      {tracking.log.map((o, i) => (
                        <tr key={i}>
                          <td>{tracking.log.length - i}</td>
                          <td>{new Date(o.ts).toLocaleString()}</td>
                          <td className="mono">{o.ip || '—'}</td>
                          <td title={o.ua}>{clientName(o.ua)}</td>
                        </tr>
                      ))}
                    </tbody></table>
                  )}
                </div>
              )}
            </div>
          )}
          {body?.hasBlockedRemote && !remoteLoaded && (
            <div className="remote-banner">
              <ImageIcon size={15} /> Remote images are blocked for privacy.
              <button className="btn" onClick={loadRemote}>Load images</button>
            </div>
          )}
          <div className="msg-body">
            {!body && <div style={{ color: 'var(--md-text-faint)', fontSize: 13 }}>Loading…</div>}
            {body && (body.html
              ? <HtmlBody html={body.html} fontSize={settings.fontSize} fontFamily={settings.fontFamily} />
              : <div className="plain">{body.text ?? '(empty message)'}</div>)}
          </div>
          {body && body.attachments.length > 0 && (
            <div className="att-strip">
              {body.attachments.map((a) => (
                <a key={a.partId} className="att-tile" href={`/api/blob/${email.id}/${a.partId}?download=1`}>
                  <AttachIcon size={14} /> {a.filename} <span className="size">{fmtSize(a.size)}</span>
                </a>
              ))}
            </div>
          )}
          <div className="card-actions">
            {email.keywords.$draft ? (
              <button className="btn" onClick={() => body && void openDraft(email, body)}><PencilIcon /> Edit draft</button>
            ) : (
              <>
                <button className="btn" onClick={() => void openReply(email, 'reply')}><ReplyIcon /> Reply</button>
                {(email.to.length + email.cc.length) > 1 && (
                  <button className="btn" onClick={() => void openReply(email, 'replyAll')}><ReplyAllIcon /> Reply all</button>
                )}
                <button className="btn" onClick={() => void openReply(email, 'forward')}><ForwardIcon /> Forward</button>
                <a className="btn" href={`/api/raw/${email.id}`} style={{ textDecoration: 'none' }}><DownloadIcon /> .eml</a>
              </>
            )}
          </div>
        </>
      )}
    </article>
  );
}

export default function ReadingPane() {
  const selectedId = useMail((s) => s.selectedId);
  const threadIds = useMail((s) => s.threadIds);
  const emails = useMail((s) => s.emails);
  const select = useMail((s) => s.select);
  const moveTo = useMail((s) => s.moveTo);
  const destroy = useMail((s) => s.destroy);
  const markRead = useMail((s) => s.markRead);
  const applyLabels = useMail((s) => s.applyLabels);
  const labels = useMail((s) => s.labels);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);

  const selected = selectedId ? emails[selectedId] : null;

  useEffect(() => {
    setSummary(null);
    // expand the selected message + last in thread
    if (selectedId) setExpanded(new Set([selectedId, ...(threadIds.length ? [threadIds[threadIds.length - 1]] : [])]));
  }, [selectedId, threadIds.length > 0 ? threadIds[threadIds.length - 1] : '']);

  if (!selected) {
    return (
      <section className="read-pane">
        <div className="read-empty">
          <div className="big"><EnvelopeOpenIcon size={42} /></div>
          <div>Select a message to read it here.</div>
          <div style={{ fontSize: 12 }}>j / k to navigate · Enter to open · e archive · # delete</div>
        </div>
      </section>
    );
  }

  const thread = (threadIds.length ? threadIds : [selected.id]).map((id) => emails[id]).filter(Boolean) as ApiEmail[];
  const chips = selected.labelIds.map((id) => labels.find((l) => l.id === id)).filter(Boolean);

  const summarize = async () => {
    setSummarizing(true);
    try {
      const res = await api.post<{ summary: string }>('/api/ai/summarize', { threadId: selected.threadId });
      setSummary(res.summary);
    } catch (e: any) {
      toast(e?.message ?? 'Summarize failed', 'error');
    } finally {
      setSummarizing(false);
    }
  };

  const inBin = selected.mailboxRole === 'trash' || selected.mailboxRole === 'junk';

  return (
    <section className="read-pane">
      <IconContext.Provider value={{ weight: 'regular', size: 18 }}>
      <div className="read-toolbar">
        <button className="icon-btn" title="Back" onClick={() => void select(null)}><BackIcon /></button>
        {inBin && <button className="icon-btn" title="Restore to Inbox" onClick={() => moveTo(selected.id, 'u:inbox')}><RestoreMailIcon /></button>}
        {!inBin && <button className="icon-btn" title="Archive" onClick={() => moveTo(selected.id, 'u:archive')}><ArchiveIcon /></button>}
        {selected.mailboxRole !== 'junk' && <button className="icon-btn" title="Junk" onClick={() => moveTo(selected.id, 'u:junk')}><JunkIcon /></button>}
        <button className="icon-btn" title="Delete" onClick={() => destroy(selected.id)}><TrashIcon /></button>
        <button className="icon-btn" title="Mark unread" onClick={() => { markRead(selected.id, false); void select(null); }}><EnvelopeIcon /></button>
        <LabelPicker value={selected.labelIds} onChange={(ids) => applyLabels(selected.id, ids)} />
        <div style={{ flex: 1 }} />
        <button className="btn ghost" disabled={summarizing} onClick={summarize}><SparkleIcon /> {summarizing ? 'Summarizing…' : 'Summarize'}</button>
      </div>
      </IconContext.Provider>
      <div className="read-scroll">
        <h1 className="read-subject">
          {selected.subject || '(no subject)'}
          {thread.length > 1 && <span className="thread-count">{thread.length} messages</span>}
          {chips.map((l) => <span key={l!.id} className="chip" style={{ background: l!.color }}>{l!.name}</span>)}
        </h1>
        {summary && (
          <div className="summary-card">
            <div className="head"><span><SparkleIcon size={15} /> AI thread summary</span> <button className="icon-btn" onClick={() => setSummary(null)}><CloseIcon /></button></div>
            {summary}
          </div>
        )}
        {thread.map((e) => (
          <MessageCard
            key={e.id}
            email={e}
            expanded={expanded.has(e.id)}
            onToggle={() => {
              const next = new Set(expanded);
              if (next.has(e.id)) next.delete(e.id); else next.add(e.id);
              setExpanded(next);
            }}
          />
        ))}
      </div>
    </section>
  );
}
