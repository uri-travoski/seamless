import { useEffect, useRef, useState } from 'react';
import { disposeWithUndo } from './settings/DisposableSettings.tsx';
import type { ApiEmail, ApiEmailBody } from '@seamless/shared';
import { useMail } from '../state/mail.ts';
import { useSession } from '../state/session.ts';
import { useCompose } from '../state/compose.ts';
import { fetchBody, api, saveNote, fetchTracking } from '../api/client.ts';
import type { TrackingInfo } from '@seamless/shared';
import { cache } from '../api/cache.ts';
import { toast } from '../toast.ts';
import SnoozeButton from './SnoozeMenu.tsx';
import { FollowupBanner } from './FollowupMenu.tsx';
import LabelPicker from './LabelPicker.tsx';
import { readableTextOn } from './LabelColorPicker.tsx';
import { EmailMenuItems } from './EmailMenu.tsx';
import { actions } from '../state/actions.ts';
import {
  EyeIcon, ImageIcon, AttachIcon, PencilIcon, ReplyIcon, ReplyAllIcon, ForwardIcon, DownloadIcon,
  EnvelopeOpenIcon, BackIcon, ArchiveIcon, JunkIcon, TrashIcon, EnvelopeIcon, SparkleIcon, CloseIcon,
  KebabIcon, SourceIcon, NoteIcon, CaretDownIcon, RestoreMailIcon, StarIcon, InboxIcon, ChartIcon, ShieldWarnIcon,
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
function HtmlBody({ html, fontSize, fontFamily, blockLinks = false }: { html: string; fontSize: number; fontFamily: string; blockLinks?: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  const fam = fontFamily.trim();
  const fontImport = fam ? `@import url('https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap');` : '';
  const stack = fam ? `'${fam.replace(/'/g, '')}', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` : '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    ${fontImport}
    html { background: #ffffff; }
    body { margin: 0; padding: 2px 4px; font-family: ${stack}; background: #ffffff;
      font-size: ${fontSize}px; line-height: 1.55; color: #23282e; word-wrap: break-word; }
    img { max-width: 100%; height: auto; }
    img.md-blocked-img { min-width: 60px; min-height: 24px; background: #f0f2f4 url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><text y="15" font-size="14">🖼</text></svg>') center no-repeat; border: 1px dashed #cdd4da; }
    blockquote { border-left: 3px solid #cdd4da; margin: 0.4em 0; padding-left: 12px; color: #5b6570; }
    pre { white-space: pre-wrap; }
    table { max-width: 100%; }
    ${blockLinks ? 'a { pointer-events: none; cursor: default; text-decoration: line-through; color: #8a8f98 !important; }' : ''}
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

  return <iframe ref={ref} sandbox={blockLinks ? 'allow-same-origin' : 'allow-same-origin allow-popups'} srcDoc={doc} style={{ height }} title="Message" />;
}

/** Which disposable address this mail came in on, with a one-click Dispose (undo for 30 days). */
function DisposableChip({ email }: { email: ApiEmail }) {
  const refreshCurrent = useMail((s) => s.refreshCurrent);
  const d = email.disposable;
  if (!d) return null;
  return (
    <div className="disposable-chip" title={d.address}>
      <span className="chip">{d.label || d.address}</span>
      <span className="dim"> {d.status === 'active' ? d.address : `${d.address} (${d.status})`}</span>{' '}
      {d.status !== 'disposed' && <button className="btn ghost danger" onClick={() => void disposeWithUndo(d.id, () => { void refreshCurrent(); })}>Dispose</button>}
    </div>
  );
}

/** Delivery failed for one or more recipients of this sent message (T3 F-22). */
function BounceBanner({ email }: { email: ApiEmail }) {
  if (!email.bounced?.length) return null;
  return (
    <div className="bounce-banner" role="alert">
      <strong>Not delivered</strong>
      <ul>{email.bounced.map((b) => <li key={b.recipient}><b>{b.recipient}</b>{b.status ? ` (${b.status})` : ''}{b.diagnostic ? ` — ${b.diagnostic}` : ''}</li>)}</ul>
    </div>
  );
}

/** Phishing / lookalike warning (T2 F-20). High risk also switches the links off until you say so. */
function RiskBanner({ email, linksOn, onEnableLinks }: { email: ApiEmail; linksOn: boolean; onEnableLinks: () => void }) {
  const r = email.risk;
  const refreshCurrent = useMail((s) => s.refreshCurrent);
  if (!r) return null;
  const high = r.level === 'high';
  const safe = async () => {
    try { await api.post(`/api/risk/${email.id}/safe`); toast(`${email.from[0]?.email ?? 'The sender'} is now trusted`); await refreshCurrent(); }
    catch { toast('Could not save', 'error'); }
  };
  const report = async () => {
    try { await api.post(`/api/risk/${email.id}/report`); toast('Reported and moved to Spam'); await refreshCurrent(); }
    catch { toast('Could not report', 'error'); }
  };
  return (
    <div className={`risk-banner ${r.level}`} role="alert">
      <div className="risk-head"><ShieldWarnIcon size={18} weight="fill" /> <strong>{high ? 'Be careful — this may be a scam' : 'Take care with this message'}</strong></div>
      <ul>{r.reasons.map((x) => <li key={x.code}>{x.text}</li>)}</ul>
      <div className="risk-actions">
        <button className="btn danger small" onClick={() => void report()}>Report phishing</button>
        <button className="btn small" onClick={() => void safe()}>This is safe</button>
        {high && !linksOn && <button className="btn ghost small" onClick={onEnableLinks}>Enable links anyway</button>}
        {high && linksOn && <span className="dim">Links are on — be careful.</span>}
      </div>
    </div>
  );
}

/** Review lane: one-tap decision for mail the cascade would not guess about. */
function ReviewBanner({ email }: { email: ApiEmail }) {
  const labels = useMail((s) => s.labels);
  const patchEmail = useMail((s) => s.patchEmail);
  const destroy = useMail((s) => s.destroy);
  const refreshMailboxes = useMail((s) => s.refreshMailboxes);
  const [picking, setPicking] = useState(false);

  const resolve = async (labelIds: number[] | null) => {
    try {
      await api.post(`/api/review/${email.id}/resolve`, labelIds ? { labelIds } : {});
      patchEmail(email.id, { needsReview: false, labelIds: labelIds ?? email.labelIds });
      void refreshMailboxes();
    } catch { toast('Could not resolve', 'error'); }
  };

  return (
    <div className="review-banner">
      <div className="review-q">This one needs your call — what should happen to mail like this?</div>
      <div className="review-actions">
        <button className="btn" onClick={() => void resolve(null)}>Keep as is</button>
        <button className="btn" onClick={() => setPicking((v) => !v)}>Label…</button>
        <button className="btn danger" onClick={() => { void resolve(null); destroy(email.id); }}>Trash</button>
      </div>
      {picking && (
        <div className="review-labels">
          {labels.map((l) => (
            <button key={l.id} className="chip" style={{ background: l.color, color: readableTextOn(l.color), border: 'none', cursor: 'pointer' }}
              onClick={() => { setPicking(false); void resolve([...new Set([...email.labelIds, l.id])]); }}>
              {l.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface TeachParse {
  summary: string; label: string | null; retentionDays: number | null;
  autoRead: boolean; deleteIfUnread: boolean; existingMatches: { id: number; name: string }[];
}
type LabelChoice = { kind: 'existing'; id: number; name: string } | { kind: 'new'; name: string } | { kind: 'none' };

/** "Teach the AI": type plain English, AI parses it into directives and applies to future similar mail. */
function TeachPanel({ email, onClose }: { email: ApiEmail; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TeachParse | null>(null);
  const [choice, setChoice] = useState<LabelChoice>({ kind: 'none' });

  const parse = async () => {
    if (!note.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<TeachParse>('/api/processor-notes/parse', { emailId: email.id, note });
      setResult(r);
      if (r.existingMatches?.length) setChoice({ kind: 'existing', id: r.existingMatches[0].id, name: r.existingMatches[0].name });
      else if (r.label) setChoice({ kind: 'new', name: r.label });
      else setChoice({ kind: 'none' });
    } catch (e: any) { toast(e?.message ?? 'Could not read that', 'error'); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!result) return;
    setBusy(true);
    try {
      await api.post('/api/processor-notes', {
        emailId: email.id, note, summary: result.summary, label: choice,
        autoRead: result.autoRead, retentionDays: result.retentionDays, deleteIfUnread: result.deleteIfUnread,
      });
      toast('Learned — future emails like this will be handled the same way', 'info');
      onClose();
    } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="note-box teach-box">
      <div className="note-head"><SparkleIcon size={14} /> Teach the AI
        <span className="note-hint">learns from this email and handles future ones like it</span>
      </div>
      {!result ? (
        <>
          <textarea className="note-text" value={note} autoFocus
            placeholder={'Say what this email is and how to handle emails like it — e.g. "This is a product warranty. Label these Warranties and keep them for 2 years."'}
            onChange={(e) => setNote(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn primary" disabled={busy || !note.trim()} onClick={() => void parse()}>{busy ? 'Reading…' : 'Continue'}</button>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="teach-confirm">
          <p className="teach-summary"><b>Understood:</b> {result.summary}</p>
          <div className="teach-field">
            <span className="teach-label">File under</span>
            <div className="teach-choices">
              {result.existingMatches?.map((m) => (
                <button key={m.id} className={`chip-choice ${choice.kind === 'existing' && choice.id === m.id ? 'on' : ''}`}
                  onClick={() => setChoice({ kind: 'existing', id: m.id, name: m.name })}>{m.name} <span className="muted">existing</span></button>
              ))}
              {result.label && (
                <button className={`chip-choice ${choice.kind === 'new' ? 'on' : ''}`}
                  onClick={() => setChoice({ kind: 'new', name: result.label! })}>{result.label} <span className="muted">new label</span></button>
              )}
              <button className={`chip-choice ${choice.kind === 'none' ? 'on' : ''}`} onClick={() => setChoice({ kind: 'none' })}>No label</button>
            </div>
          </div>
          {(result.retentionDays != null || result.autoRead || result.deleteIfUnread) && (
            <ul className="teach-actions">
              {result.retentionDays != null && <li>Delete after <b>{result.retentionDays} days</b>{result.deleteIfUnread ? ' (only if never read)' : ''}</li>}
              {result.autoRead && <li>Mark as read on arrival</li>}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save & apply to future mail'}</button>
            <button className="btn ghost" onClick={() => setResult(null)}>Back</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Why this label?" — the stored cascade decision for this message. */
function WhyLine({ email }: { email: ApiEmail }) {
  const [why, setWhy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const load = async () => {
    setLoaded(true);
    try {
      const decisions = await api.get<any[]>(`/api/message/${email.id}/decisions`);
      if (decisions.length === 0) { setWhy('matched by your rules (no AI involved)'); return; }
      const d = decisions[0];
      setWhy(`${d.tier === 'llm' ? `AI (${d.model})` : 'similarity to your labelled mail'} · ${Math.round(d.confidence * 100)}% · ${d.reason || d.output?.reason || ''}`);
    } catch { setWhy(null); }
  };
  if (email.labelIds.length === 0 && email.disposition !== 'delete') return null;
  return (
    <span className="why-line">
      {!loaded
        ? <button className="details-toggle" style={{ fontSize: 11.5 }} onClick={(e) => { e.stopPropagation(); void load(); }}>why?</button>
        : <span style={{ fontSize: 11.5, color: 'var(--md-text-faint)' }}>{why ?? ''}</span>}
    </span>
  );
}

function MessageCard({ email, expanded, onToggle }: { email: ApiEmail; expanded: boolean; onToggle: () => void }) {
  const settings = useSession((s) => s.settings);
  const openReply = useCompose((s) => s.openReply);
  const openDraft = useCompose((s) => s.openDraft);
  const patchEmail = useMail((s) => s.patchEmail);
  const [body, setBody] = useState<ApiEmailBody | null>(null);
  const [remoteLoaded, setRemoteLoaded] = useState(false);
  const [linksOn, setLinksOn] = useState(false);
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
            {expanded && <WhyLine email={email} />}
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
            <div className="dropdown card-menu" role="menu">
              <EmailMenuItems email={email} close={() => setMenuOpen(false)} />
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
          <BounceBanner email={email} />
          <DisposableChip email={email} />
          <RiskBanner email={email} linksOn={linksOn} onEnableLinks={() => setLinksOn(true)} />
          {email.needsReview && <ReviewBanner email={email} />}
          {noteOpen && (
            <div className="note-box">
              <div className="note-head"><NoteIcon size={14} weight="fill" /> Private note <span className="note-hint">only you can see this</span></div>
              <textarea className="note-text" value={noteDraft} placeholder="Add a personal note about this email…"
                onChange={(e) => setNoteDraft(e.target.value)} onBlur={() => void persistNote(noteDraft)} />
            </div>
          )}
          <FollowupBanner email={email} />
          {email.openCount >= 0 && (
            <div className="track-wrap">
              <button className={`track-banner ${email.openCount > 0 ? 'clickable' : ''}`}
                onClick={() => { if (email.openCount > 0) { const n = !trackOpen; setTrackOpen(n); if (n) void loadTracking(); } }}>
                <EyeIcon size={14} /> {email.openCount === 0
                  ? 'Tracking active — not opened yet.'
                  : `Opened ${email.openCount} time${email.openCount === 1 ? '' : 's'}${email.lastOpenAt ? ` · last ${new Date(email.lastOpenAt).toLocaleString()}` : ''}`}
                {(email.autoOpenCount ?? 0) > 0 && <span className="track-auto"> · {email.autoOpenCount} probable automatic</span>}
                {email.openCount > 0 && <CaretDownIcon size={12} style={{ marginLeft: 'auto', transform: trackOpen ? 'rotate(180deg)' : 'none' }} />}
              </button>
              <button className="btn ghost small track-report" onClick={() => actions.openReport(email.id)}><ChartIcon size={14} /> Open report</button>
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
              ? <HtmlBody html={body.html} fontSize={settings.fontSize} fontFamily={settings.fontFamily} blockLinks={email.risk?.level === 'high' && !linksOn} />
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

/** "More" in the reading toolbar: the full per-email menu. */
function ToolbarMore({ email }: { email: ApiEmail }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  return (
    <div className="label-menu" ref={ref}>
      <button className={`icon-btn ${open ? 'active' : ''}`} title="More actions" aria-haspopup="menu" onClick={() => setOpen((v) => !v)}><KebabIcon /></button>
      {open && <div className="dropdown" role="menu"><EmailMenuItems email={email} close={() => setOpen(false)} /></div>}
    </div>
  );
}

export default function ReadingPane() {
  const selectedId = useMail((s) => s.selectedId);
  const threadIds = useMail((s) => s.threadIds);
  const emails = useMail((s) => s.emails);
  const select = useMail((s) => s.select);
  const markRead = useMail((s) => s.markRead);
  const applyLabels = useMail((s) => s.applyLabels);
  const labels = useMail((s) => s.labels);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [summary, setSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [teachOpen, setTeachOpen] = useState(false);

  const selected = selectedId ? emails[selectedId] : null;

  useEffect(() => {
    setSummary(null);
    setTeachOpen(false);
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
        <button className="icon-btn" title="Back to list (u)" onClick={() => void select(null)}><BackIcon /></button>
        <span className="tb-sep" />
        <button className="icon-btn" title="Mark unread (Shift+U)" onClick={() => { markRead(selected.id, false); void select(null); }}><EnvelopeIcon /></button>
        <button className={`icon-btn ${selected.keywords.$flagged ? 'active' : ''}`} title="Star (s)" onClick={() => actions.star(selected.id)}><StarIcon weight={selected.keywords.$flagged ? 'fill' : 'regular'} /></button>
        <LabelPicker value={selected.labelIds} onChange={(ids) => applyLabels(selected.id, ids)} />
        {selected.mailboxRole === 'inbox' && <SnoozeButton onPick={(at) => void actions.snooze(selected.id, at)} />}
        {inBin
          ? <button className="icon-btn" title={selected.mailboxRole === 'junk' ? 'Not spam' : 'Restore to Inbox'} onClick={() => (selected.mailboxRole === 'junk' ? actions.notSpam(selected.id) : actions.restore(selected.id))}><RestoreMailIcon /></button>
          : <button className="icon-btn" title="Archive (e)" onClick={() => actions.archive(selected.id)}><ArchiveIcon /></button>}
        {selected.mailboxRole !== 'junk' && <button className="icon-btn" title="Report spam (!)" onClick={() => actions.spam(selected.id)}><JunkIcon /></button>}
        <button className="icon-btn" title={inBin ? 'Delete forever' : 'Delete (#)'} onClick={() => actions.trash(selected.id)}><TrashIcon /></button>
        <span className="tb-sep" />
        {!selected.keywords.$draft && <>
          <button className="icon-btn" title="Reply (r)" onClick={() => actions.reply(selected.id)}><ReplyIcon /></button>
          <button className="icon-btn" title="Reply all (a)" onClick={() => actions.replyAll(selected.id)}><ReplyAllIcon /></button>
          <button className="icon-btn" title="Forward (f)" onClick={() => actions.forward(selected.id)}><ForwardIcon /></button>
        </>}
        <ToolbarMore email={selected} />
        <button className={`icon-btn ${teachOpen ? 'active' : ''}`} title="Teach the AI about emails like this" onClick={() => setTeachOpen((v) => !v)}><SparkleIcon /></button>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" disabled={summarizing} onClick={summarize}><SparkleIcon /> {summarizing ? 'Summarizing…' : 'Summarize'}</button>
      </div>
      </IconContext.Provider>
      <div className="read-scroll">
        {teachOpen && <div style={{ padding: '12px 16px 0' }}><TeachPanel email={selected} onClose={() => setTeachOpen(false)} /></div>}
        <h1 className="read-subject">
          {selected.subject || '(no subject)'}
          {thread.length > 1 && <span className="thread-count">{thread.length} messages</span>}
          {chips.map((l) => (
            <span key={l!.id} className="chip" style={{ background: l!.color, color: readableTextOn(l!.color) }}>
              {l!.name}
              <button className="chip-x" title="Remove label" aria-label={`Remove label ${l!.name}`}
                onClick={() => applyLabels(selected.id, selected.labelIds.filter((id) => id !== l!.id))}>×</button>
            </span>
          ))}
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
