/** Shared-inbox panel under a thread (T4 F-32): assignee, status, presence, internal comments. */
import { useEffect, useState } from 'react';
import type { ApiAssignment, ApiEmail, ApiThreadComment } from '@seamless/shared';
import { useSession } from '../state/session.ts';
import { useCompose } from '../state/compose.ts';
import { useMail } from '../state/mail.ts';
import {
  useShared, livePresence, sendPresence, isSharedAccount, fetchAssignment, saveAssignment, fetchComments, postComment, fetchPeople,
} from '../state/shared.ts';
import { toast } from '../toast.ts';

export function AssigneeChip({ email }: { email: ApiEmail }) {
  const a = email.assignment;
  if (!a || (!a.assigneeId && a.status === 'open')) return null;
  const initials = (a.assigneeName ?? '?').trim().slice(0, 2).toUpperCase();
  return (
    <span className="assignee-chip" title={`${a.assigneeName ? `Assigned to ${a.assigneeName}` : 'Unassigned'} · ${a.status}`}>
      {a.assigneeId ? <span className="assignee-avatar">{initials}</span> : null}
      {a.status !== 'open' && <span className={`status-pill ${a.status}`}>{a.status}</span>}
    </span>
  );
}

export default function SharedThread({ email }: { email: ApiEmail }) {
  const me = useSession((s) => s.user);
  const overview = useMail((s) => s.overview);
  const ownedShared = useShared((s) => s.ownedShared);
  const presence = useShared((s) => s.presence[`${email.accountId}:${email.threadId}`]);
  const windows = useCompose((s) => s.windows);
  const [asg, setAsg] = useState<ApiAssignment | null>(null);
  const [people, setPeople] = useState<{ id: number; name: string; email: string; role: string }[]>([]);
  const [comments, setComments] = useState<ApiThreadComment[]>([]);
  const [text, setText] = useState('');
  const [, tick] = useState(0);
  const role = email.accountId && overview?.shared?.find((s) => s.id === email.accountId)?.role;
  const canWork = !role || role !== 'viewer';
  const shared = !!overview?.shared?.some((s) => s.id === email.accountId) || ownedShared.includes(email.accountId);

  const load = () => {
    fetchAssignment(email.accountId, email.threadId).then(setAsg).catch(() => {});
    fetchComments(email.accountId, email.threadId).then(setComments).catch(() => {});
  };
  useEffect(() => {
    if (!shared) return;
    load();
    fetchPeople(email.accountId).then(setPeople).catch(() => {});
  }, [email.accountId, email.threadId, shared, overview]);

  // presence: "viewing" now and every 30 s; "left" on unmount
  const replying = windows.some((w) => w.replyToEmailId && w.replyToEmailId.startsWith('m') && (useMail.getState().emails[w.replyToEmailId]?.threadId === email.threadId));
  useEffect(() => {
    if (!shared) return;
    const action = replying ? 'replying' : 'viewing';
    sendPresence(email.threadId, email.accountId, action);
    const t = setInterval(() => { sendPresence(email.threadId, email.accountId, action); tick((n) => n + 1); }, 30_000);
    return () => { clearInterval(t); sendPresence(email.threadId, email.accountId, 'left'); };
  }, [email.accountId, email.threadId, shared, replying]);
  // re-render so stale entries disappear
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 10_000); return () => clearInterval(t); }, []);

  if (!shared) return null;
  const others = livePresence(presence).filter((p) => p.userId !== me?.id);
  const replier = others.find((p) => p.action === 'replying');
  const viewers = others.filter((p) => p.action === 'viewing');

  const save = async (patch: { assigneeId?: number | null; status?: string }) => {
    try {
      setAsg(await saveAssignment(email.accountId, email.threadId, {
        assigneeId: patch.assigneeId !== undefined ? patch.assigneeId : asg?.assigneeId ?? null,
        status: patch.status ?? asg?.status ?? 'open', dueAt: asg?.dueAt ?? null,
      }));
      void useMail.getState().refreshCurrent();
    } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
  };
  const send = async () => {
    if (!text.trim()) return;
    try { await postComment(email.accountId, email.threadId, text); setText(''); setComments(await fetchComments(email.accountId, email.threadId)); }
    catch (e: any) { toast(e?.message ?? 'Could not comment', 'error'); }
  };
  const status = asg?.status ?? 'open';

  return (
    <div className="shared-thread">
      {replier && <div className="presence-line">✎ {replier.userName} is replying…</div>}
      {!replier && viewers.length > 0 && <div className="presence-line dim">{viewers.map((v) => v.userName).join(', ')} {viewers.length > 1 ? 'are' : 'is'} viewing</div>}
      <div className="assign-bar">
        <label>Assigned to{' '}
          <select value={asg?.assigneeId ?? ''} disabled={!canWork} aria-label="Assign to…"
            onChange={(e) => void save({ assigneeId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Unassigned</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.id === me?.id ? `${p.name} (me)` : p.name}</option>)}
          </select>
        </label>
        <span className="status-group" role="group" aria-label="Status">
          {(['open', 'pending', 'done'] as const).map((s) => (
            <button key={s} className={`chip-choice ${status === s ? 'on' : ''}`} disabled={!canWork} onClick={() => void save({ status: s })}>{s[0].toUpperCase() + s.slice(1)}</button>
          ))}
        </span>
      </div>
      <div className="comments-panel" aria-label="Team internal comments">
        <div className="comments-head">Team internal comments <span className="dim">never sent to anyone outside</span></div>
        {comments.map((c) => (
          <div key={c.id} className="comment">
            <b>{c.userName}</b> <span className="dim">{new Date(c.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <div className="comment-body">{c.body}</div>
          </div>
        ))}
        {canWork && (
          <div className="comment-form">
            <textarea value={text} maxLength={5000} placeholder="Add a team internal comment… use @name to mention someone" onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }} />
            <button className="btn" disabled={!text.trim()} onClick={() => void send()}>Comment</button>
          </div>
        )}
      </div>
    </div>
  );
}
