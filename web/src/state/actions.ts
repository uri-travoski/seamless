/**
 * Per-email actions (T1 F-16), shared by hover buttons, the right-click menu, the reading
 * pane toolbar, the bulk bar and keyboard shortcuts. Destructive ones show a 5 s Undo.
 */
import type { ApiEmail } from '@seamless/shared';
import { useMail, viewFilter, BULK_MAX } from './mail.ts';
import { useCompose } from './compose.ts';
import { api, emailSet, fetchBody } from '../api/client.ts';
import { toast, undoToast } from '../toast.ts';
import { navigate } from '../router.ts';
import { fmtSnoozeLong } from '../snoozeTimes.ts';

const mail = () => useMail.getState();
const email = (id: string): ApiEmail | undefined => mail().emails[id];

function moveWithUndo(id: string, target: string, verb: string): void {
  const e = email(id);
  if (!e) return;
  const from = e.mailboxId;
  mail().moveTo(id, target);
  undoToast(verb, () => {
    void emailSet({ [id]: { mailboxIds: { [from]: true } } }).then(() => mail().refreshCurrent());
  });
}

export const actions = {
  archive: (id: string) => moveWithUndo(id, 'u:archive', 'Archived'),
  spam: (id: string) => moveWithUndo(id, 'u:junk', 'Moved to Spam'),
  notSpam: (id: string) => moveWithUndo(id, 'u:inbox', 'Moved to Inbox'),
  restore: (id: string) => moveWithUndo(id, 'u:inbox', 'Restored to Inbox'),
  move: (id: string, target: string, name: string) => moveWithUndo(id, target, `Moved to ${name}`),

  /** Snooze the conversation until `until` (epoch ms); Undo puts it back in the Inbox. */
  snooze: async (id: string, until: number) => {
    const e = email(id);
    if (!e) return;
    try {
      await api.post('/api/snooze', { emailId: id, until });
      undoToast(`Snoozed until ${fmtSnoozeLong(until)}`, () => {
        void api.del(`/api/snooze/${encodeURIComponent(e.threadId)}`).then(() => mail().refreshCurrent());
      });
      await mail().refreshCurrent();
    } catch (err: any) { toast(err?.message ?? 'Could not snooze', 'error'); }
  },

  /** Remind me if nobody replies to this sent message within `days`. */
  followup: async (id: string, days: number) => {
    const due = Date.now() + days * 86_400_000;
    try {
      await api.post('/api/followups', { emailId: id, dueAt: due });
      toast(`Reminder set — you'll be told in ${days} day${days === 1 ? '' : 's'} if nobody replies`);
      await mail().refreshCurrent();
    } catch (err: any) { toast(err?.message ?? 'Could not set the reminder', 'error'); }
  },
  cancelFollowup: async (followupId: number) => {
    try { await api.del(`/api/followups/${followupId}`); toast('Reminder cancelled'); await mail().refreshCurrent(); }
    catch (err: any) { toast(err?.message ?? 'Could not cancel', 'error'); }
  },

  /** Delete → Bin (undoable). In Bin/Spam it's permanent, so ask first. */
  trash: (id: string) => {
    const e = email(id);
    if (!e) return;
    if (e.mailboxRole === 'trash' || e.mailboxRole === 'junk') {
      if (!window.confirm('Delete this message forever? This cannot be undone.')) return;
      mail().destroy(id);
      toast('Deleted forever');
      return;
    }
    const from = e.mailboxId;
    mail().destroy(id);
    undoToast('Moved to Bin', () => {
      void emailSet({ [id]: { mailboxIds: { [from]: true } } }).then(() => mail().refreshCurrent());
    });
  },

  markRead: (id: string, read: boolean) => mail().markRead(id, read),
  toggleRead: (id: string) => { const e = email(id); if (e) mail().markRead(id, e.keywords.$seen !== true); },
  star: (id: string) => mail().toggleStar(id),
  labels: (id: string, labelIds: number[]) => mail().applyLabels(id, labelIds),

  reply: (id: string) => { const e = email(id); if (e) void useCompose.getState().openReply(e, 'reply'); },
  replyAll: (id: string) => { const e = email(id); if (e) void useCompose.getState().openReply(e, 'replyAll'); },
  forward: (id: string) => { const e = email(id); if (e) void useCompose.getState().openReply(e, 'forward'); },

  blockSender: async (id: string) => {
    const e = email(id);
    if (!e) return;
    const who = e.from[0]?.email ?? 'this sender';
    if (!window.confirm(`Block ${who}? Their mail will go straight to Spam.`)) return;
    try {
      const r = await api.post<{ address: string; filterCreated: boolean }>('/api/block-sender', { emailId: id });
      mail().moveTo(id, 'u:junk');
      toast(`Blocked ${r.address}${r.filterCreated ? ' — a filter now sends their mail to Spam' : ''}`);
    } catch (err: any) { toast(err?.message ?? 'Could not block', 'error'); }
  },

  /** T4 F-35: mark / unmark the sender as a VIP (never auto-removed from the Inbox, always notifies). */
  toggleVip: async (id: string) => {
    const e = email(id);
    const addr = e?.from[0]?.email?.toLowerCase();
    if (!e || !addr) return;
    try {
      if (e.vip) {
        const list = await api.get<{ items: { id: number; kind: string; value: string }[] }>('/api/vips');
        const dom = addr.split('@')[1];
        const hits = list.items.filter((v) => (v.kind === 'address' && v.value === addr) || (v.kind === 'domain' && v.value === dom));
        for (const v of hits) await api.del(`/api/vips/${v.id}`);
        toast(`${addr} is no longer a VIP`);
      } else {
        await api.post('/api/vips', { kind: 'address', value: addr });
        toast(`${addr} is now a VIP`);
      }
      await mail().refreshCurrent();
    } catch (err: any) { toast(err?.message ?? 'Could not update VIPs', 'error'); }
  },

  /** Opens Settings → Filters with from / subject / list-id filled in. */
  createFilter: (id: string) => {
    const e = email(id);
    if (!e) return;
    sessionStorage.setItem('seamless-filter-prefill', JSON.stringify({
      name: `From ${e.from[0]?.name || e.from[0]?.email || ''}`.trim(),
      from: e.from[0]?.email ?? '', subject: e.subject,
    }));
    navigate({ page: 'settings', tab: 'filters' });
  },

  /** Print the rendered message (headers + body) from a blank window. */
  print: async (id: string) => {
    const e = email(id);
    if (!e) return;
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print', 'error'); return; }
    try {
      const b = await fetchBody(id, false);
      const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
      const addr = (l: { name: string; email: string }[]) => esc(l.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', '));
      w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(e.subject || '(no subject)')}</title>
        <style>body{font:14px/1.5 system-ui,sans-serif;color:#111;margin:24px}h1{font-size:20px;margin:0 0 8px}
        .meta{color:#555;font-size:12.5px;border-bottom:1px solid #ddd;padding-bottom:10px;margin-bottom:14px}img{max-width:100%}</style></head><body>
        <h1>${esc(e.subject || '(no subject)')}</h1>
        <div class="meta">From: ${addr(e.from)}<br>To: ${addr(e.to)}${e.cc.length ? `<br>Cc: ${addr(e.cc)}` : ''}<br>Date: ${esc(new Date(e.receivedAt).toLocaleString())}</div>
        ${b.html ?? `<pre style="white-space:pre-wrap">${esc(b.text ?? '')}</pre>`}</body></html>`);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 300);
    } catch { w.close(); toast('Could not load the message to print', 'error'); }
  },
  viewOriginal: (id: string) => { window.open(`/api/message/${id}/original`, '_blank', 'noopener'); },
  downloadEml: (id: string) => { location.href = `/api/raw/${id}`; },
  openReport: (id: string) => navigate({ page: 'opens', emailId: id }),
};

export type BulkAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'inbox' | 'spam' | 'delete' | 'move' | 'label' | 'unlabel' | 'snooze';

const REMOVES = new Set<BulkAction>(['archive', 'inbox', 'spam', 'delete', 'move', 'snooze']);
const VERB: Record<BulkAction, string> = {
  read: 'Marked read', unread: 'Marked unread', star: 'Starred', unstar: 'Unstarred', archive: 'Archived', inbox: 'Moved to Inbox',
  spam: 'Moved to Spam', delete: 'Deleted', move: 'Moved', label: 'Labelled', unlabel: 'Label removed', snooze: 'Snoozed',
};

/** Bulk bar: the checked rows, or every message matching the view when "all matching" is on. */
export async function runBulk(action: BulkAction, value?: string | number): Promise<void> {
  const st = mail();
  const ids = [...st.checked];
  const body = st.allMatching ? { filter: viewFilter(st.view, st.scope), action, value } : { ids, action, value };
  if (!st.allMatching && ids.length === 0) return;
  const n = st.allMatching ? Math.min(st.total, BULK_MAX) : ids.length;
  if (action === 'delete' && st.allMatching && !window.confirm(`Delete ${st.total > BULK_MAX ? `the newest ${n.toLocaleString()} of ${st.total.toLocaleString()}` : `all ${n.toLocaleString()}`} matching messages?`)) return;

  // optimistic: rows that leave this view disappear now
  if (REMOVES.has(action) && !st.allMatching) {
    const gone = new Set(ids);
    useMail.setState({
      ids: st.ids.filter((x) => !gone.has(x)), total: Math.max(0, st.total - gone.size),
      selectedId: st.selectedId && gone.has(st.selectedId) ? null : st.selectedId,
    });
  }
  useMail.setState({ checked: new Set(), allMatching: false });
  const busy = n > 200 ? toast(`Working on ${n.toLocaleString()} messages…`) : null;
  void busy;
  try {
    const r = await api.post<{ affected: number; undoToken: string; undoable: boolean }>('/api/bulk', body);
    await mail().refreshCurrent();
    const text = `${VERB[action]} ${r.affected.toLocaleString()} message${r.affected === 1 ? '' : 's'}`;
    if (r.undoable) {
      undoToast(text, () => {
        void api.post('/api/bulk/undo', { undoToken: r.undoToken })
          .then(() => mail().refreshCurrent())
          .catch((e: any) => toast(e?.message ?? 'Could not undo', 'error'));
      });
    } else {
      toast(text);
    }
  } catch (e: any) {
    toast(e?.message ?? 'Bulk action failed', 'error');
    void mail().refreshCurrent();
  }
}
