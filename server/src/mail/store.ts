import type { ApiEmail, ApiMailbox, EmailQueryRequest, EmailQueryResponse, MailboxRole } from '@seamless/shared';
import { q, one, run, bumpState, currentState } from '../db.ts';
import { parseSearch } from './searchparse.ts';
import { enqueueOp } from '../imap/sync.ts';
import { deleteMessageRow } from './ingest.ts';
import { scopeAccountIds, categoryIdByName } from './categories.ts';

const UNIFIED_ROLES: MailboxRole[] = ['inbox', 'drafts', 'sent', 'scheduled', 'archive', 'junk', 'trash'];
const UNIFIED_NAMES: Record<string, string> = {
  inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent', scheduled: 'Scheduled', archive: 'Archive', junk: 'Junk', trash: 'Trash',
};

/** Mailboxes for the sidebar. The unified role folders (u:inbox, ...) count only the
 *  accounts inside `scope`; per-account folders are always listed in full. */
export async function listMailboxes(userId: number, scope?: string): Promise<ApiMailbox[]> {
  const inScope = await scopeAccountIds(userId, scope);
  const counts = await q<{ mailbox_id: number; total: number; unread: number }>(`
    SELECT m.mailbox_id, COUNT(*) AS total,
           COUNT(*) FILTER (WHERE m.unread AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?)) AS unread
    FROM messages m WHERE m.user_id = ? GROUP BY m.mailbox_id
  `, [Date.now(), userId]);
  const byId = new Map(counts.map((c) => [c.mailbox_id, c]));

  const rows = await q(`
    SELECT mb.*, a.email AS account_email FROM mailboxes mb JOIN accounts a ON a.id = mb.account_id
    WHERE a.user_id = ?
    ORDER BY mb.account_id, CASE mb.role
      WHEN 'inbox' THEN 0 WHEN 'drafts' THEN 1 WHEN 'sent' THEN 2 WHEN 'scheduled' THEN 3
      WHEN 'archive' THEN 4 WHEN 'junk' THEN 5 WHEN 'trash' THEN 6 ELSE 7 END, mb.name
  `, [userId]);

  const out: ApiMailbox[] = [];
  const roleTotals = new Map<string, { total: number; unread: number }>();
  for (const r of rows) {
    const c = byId.get(r.id) ?? { total: 0, unread: 0 };
    if (r.role && (inScope === null || inScope.includes(r.account_id))) {
      const agg = roleTotals.get(r.role) ?? { total: 0, unread: 0 };
      agg.total += c.total; agg.unread += c.unread ?? 0;
      roleTotals.set(r.role, agg);
    }
    out.push({
      id: `mb:${r.id}`, accountId: r.account_id, name: r.name, path: r.path,
      role: r.role, totalEmails: c.total, unreadEmails: c.unread ?? 0,
    });
  }
  const unified: ApiMailbox[] = UNIFIED_ROLES.map((role) => {
    const agg = roleTotals.get(role!) ?? { total: 0, unread: 0 };
    return {
      id: `u:${role}`, accountId: null, name: UNIFIED_NAMES[role!], path: `u:${role}`,
      role, totalEmails: agg.total, unreadEmails: agg.unread,
    };
  });
  return [...unified, ...out];
}

export interface MsgRow {
  id: number; user_id: number; account_id: number; mailbox_id: number; uid: number; thread_id: string;
  subject: string; snippet: string; from_name: string; from_addr: string;
  to_json: string; cc_json: string; reply_to_json: string; delivered_to: string | null;
  date: number; size: number; unread: boolean; flagged: boolean; answered: boolean; draft: boolean;
  has_attachments: boolean; tracking_token: string | null; s3_key: string | null;
  account_email: string; account_color: string; mailbox_role: string | null;
  message_id: string | null; references_ids: string;
  disposition: string; delete_at: number | null; classify_state: string;
  snoozed_until: number | null; sort_date: number | null;
}

const BASE_SELECT = `
  SELECT m.*, a.email AS account_email, a.color AS account_color, mb.role AS mailbox_role
  FROM messages m
  JOIN accounts a ON a.id = m.account_id
  JOIN mailboxes mb ON mb.id = m.mailbox_id
`;

export async function rowToApi(r: MsgRow): Promise<ApiEmail> {
  const labels = await q<{ label_id: number }>('SELECT label_id FROM message_labels WHERE message_id = ?', [r.id]);
  let openCount = -1;
  let lastOpenAt: string | null = null;
  let autoOpenCount = 0;
  if (r.tracking_token) {
    // the sent copy's token, plus any per-recipient copies sent alongside it (T1 F-15);
    // proxy/scanner opens are kept apart from the real ones
    const t = await one<{ c: number; auto: number; last: number | null }>(`
      SELECT COUNT(*) FILTER (WHERE NOT proxied) AS c, COUNT(*) FILTER (WHERE proxied) AS auto,
             MAX(ts) FILTER (WHERE NOT proxied) AS last
      FROM tracking_opens
      WHERE token = ? OR token IN (SELECT token FROM tracked_sends WHERE group_token = ?)`, [r.tracking_token, r.tracking_token]);
    openCount = t?.c ?? 0;
    autoOpenCount = t?.auto ?? 0;
    lastOpenAt = t?.last ? new Date(t.last).toISOString() : null;
  }
  // For untracked (inbound) rows, surface whether your tracked reply elsewhere in
  // the thread was opened by the recipient, so the inbox row reflects the thread.
  let threadOpenCount = -1;
  let threadOpenAt: string | null = null;
  if (!r.tracking_token) {
    const ta = await one<{ c: number; last: number | null }>(
      `SELECT COUNT(t.id) AS c, MAX(t.ts) AS last
       FROM messages sm JOIN tracking_opens t ON t.token = sm.tracking_token AND NOT t.proxied
       WHERE sm.thread_id = ? AND sm.user_id = ? AND sm.tracking_token IS NOT NULL`, [r.thread_id, r.user_id]);
    if (ta && ta.c > 0) { threadOpenCount = ta.c; threadOpenAt = new Date(ta.last!).toISOString(); }
  }
  const hasNote = !!(await one('SELECT 1 FROM notes WHERE user_id = ? AND email_id = ?', [r.user_id, `m${r.id}`]));
  const fu = await one<{ id: number; due_at: number; status: string }>(
    `SELECT id, due_at, status FROM followups WHERE message_id = ? AND user_id = ? AND status IN ('waiting','due') ORDER BY id DESC LIMIT 1`, [r.id, r.user_id]);
  return {
    id: `m${r.id}`,
    threadId: r.thread_id,
    accountId: r.account_id,
    accountEmail: r.account_email,
    accountColor: r.account_color,
    mailboxId: `mb:${r.mailbox_id}`,
    mailboxRole: r.mailbox_role as MailboxRole,
    keywords: {
      ...(r.unread ? {} : { $seen: true }),
      ...(r.flagged ? { $flagged: true } : {}),
      ...(r.answered ? { $answered: true } : {}),
      ...(r.draft ? { $draft: true } : {}),
    },
    labelIds: labels.map((l) => l.label_id),
    from: [{ name: r.from_name, email: r.from_addr }],
    to: JSON.parse(r.to_json),
    cc: JSON.parse(r.cc_json),
    replyTo: JSON.parse(r.reply_to_json),
    subject: r.subject,
    preview: r.snippet,
    receivedAt: new Date(r.date).toISOString(),
    messageId: r.message_id,
    size: r.size,
    hasAttachment: r.has_attachments,
    hasNote,
    openCount,
    autoOpenCount,
    lastOpenAt,
    threadOpenCount,
    threadOpenAt,
    disposition: (r.disposition as 'keep' | 'delete') ?? 'keep',
    deleteAt: r.delete_at ? new Date(r.delete_at).toISOString() : null,
    needsReview: r.classify_state === 'needs_review',
    followupId: fu?.id ?? null,
    followupDueAt: fu ? new Date(Number(fu.due_at)).toISOString() : null,
    followupStatus: fu ? (fu.status as 'waiting' | 'due') : null,
    snoozedUntil: r.snoozed_until && r.snoozed_until > Date.now() ? new Date(Number(r.snoozed_until)).toISOString() : null,
  };
}

export async function getNote(userId: number, emailId: string): Promise<string> {
  const row = await one<{ body: string }>('SELECT body FROM notes WHERE user_id = ? AND email_id = ?', [userId, emailId]);
  return row?.body ?? '';
}

export async function setNote(userId: number, emailId: string, body: string): Promise<void> {
  const trimmed = body.trim();
  if (trimmed === '') {
    await run('DELETE FROM notes WHERE user_id = ? AND email_id = ?', [userId, emailId]);
  } else {
    await run(`
      INSERT INTO notes(user_id, email_id, body, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id, email_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at
    `, [userId, emailId, body, Date.now()]);
  }
  await bumpState();
}

export async function getEmails(userId: number, ids: string[]): Promise<ApiEmail[]> {
  const out: ApiEmail[] = [];
  for (const id of ids) {
    const row = await one<MsgRow>(`${BASE_SELECT} WHERE m.id = ? AND m.user_id = ?`, [Number(id.replace(/^m/, '')) || 0, userId]);
    if (row) out.push(await rowToApi(row));
  }
  return out;
}

export async function getMsgRow(userId: number, emailId: string): Promise<MsgRow | undefined> {
  return one<MsgRow>(`${BASE_SELECT} WHERE m.id = ? AND m.user_id = ?`, [Number(emailId.replace(/^m/, '')) || 0, userId]);
}

export async function queryEmails(userId: number, req: EmailQueryRequest): Promise<EmailQueryResponse> {
  const where: string[] = ['m.user_id = ?'];
  const params: unknown[] = [userId];
  const f = req.filter ?? {};

  const scoped = await scopeAccountIds(userId, f.scope);
  if (scoped !== null) { where.push('m.account_id = ANY(?::int[])'); params.push(scoped); }

  if (f.inMailbox) {
    if (f.inMailbox.startsWith('mb:')) {
      where.push('m.mailbox_id = ?');
      params.push(Number(f.inMailbox.slice(3)));
    } else if (f.inMailbox.startsWith('u:')) {
      where.push('mb.role = ?');
      params.push(f.inMailbox.slice(2));
    }
  }
  if (f.accountId) { where.push('m.account_id = ?'); params.push(f.accountId); }
  if (f.label) {
    where.push('EXISTS (SELECT 1 FROM message_labels ml WHERE ml.message_id = m.id AND ml.label_id = ?)');
    params.push(f.label);
  }
  if (f.hasKeyword === '$seen') where.push('m.unread = false');
  if (f.notKeyword === '$seen') where.push('m.unread = true');
  if (f.hasKeyword === '$flagged') where.push('m.flagged = true');
  if (f.needsReview) where.push("m.classify_state = 'needs_review'");
  if (f.waiting) where.push(`EXISTS (SELECT 1 FROM followups fu WHERE fu.message_id = m.id AND fu.user_id = m.user_id AND fu.status IN ('waiting','due'))`);
  if (f.snoozed) {
    where.push('m.snoozed_until > ?'); params.push(Date.now());
  } else if (f.inMailbox) {
    // snoozed mail is out of the Inbox until it wakes
    where.push("NOT (mb.role = 'inbox' AND COALESCE(m.snoozed_until, 0) > ?)"); params.push(Date.now());
  }

  if (f.text) {
    const p = parseSearch(f.text);
    if (p.fts) {
      where.push("m.id IN (SELECT message_id FROM message_fts WHERE tsv @@ to_tsquery('simple', ?))");
      params.push(p.fts);
    }
    if (p.from) { where.push('(m.from_addr ILIKE ? OR m.from_name ILIKE ?)'); params.push(`%${p.from}%`, `%${p.from}%`); }
    if (p.to) { where.push('m.to_json ILIKE ?'); params.push(`%${p.to}%`); }
    if (p.label) {
      where.push('EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = m.id AND lower(l.name) = lower(?))');
      params.push(p.label);
    }
    if (p.inRole) { where.push('mb.role = ?'); params.push(p.inRole); }
    if (p.category) {
      const cid = await categoryIdByName(userId, p.category);
      const ids = cid ? await scopeAccountIds(userId, { kind: 'category', id: cid }) : [];
      where.push('m.account_id = ANY(?::int[])'); params.push(ids ?? []);
    }
    if (p.unread !== null) where.push(`m.unread = ${p.unread ? 'true' : 'false'}`);
    if (p.starred) where.push('m.flagged = true');
    if (p.hasAttachment) where.push('m.has_attachments = true');
    if (p.before !== null) { where.push('m.date < ?'); params.push(p.before); }
    if (p.after !== null) { where.push('m.date >= ?'); params.push(p.after); }
    // search excludes trash/junk unless explicitly requested
    if (!p.inRole && !f.inMailbox) where.push("(mb.role IS NULL OR mb.role NOT IN ('trash','junk'))");
  }

  const whereSql = 'WHERE ' + where.join(' AND ');
  const totalRow = await one<{ c: number }>(
    `SELECT COUNT(*) AS c FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id ${whereSql}`, params);
  const rows = await q<MsgRow>(
    `${BASE_SELECT} ${whereSql} ORDER BY ${f.snoozed ? 'm.snoozed_until ASC' : 'COALESCE(m.sort_date, m.date) DESC'}, m.id DESC LIMIT ? OFFSET ?`,
    [...params, req.limit, req.position]);

  return {
    ids: rows.map((r) => `m${r.id}`),
    total: totalRow?.c ?? 0,
    position: req.position,
    queryState: await currentState(),
  };
}

export async function getThreadEmailIds(userId: number, threadId: string): Promise<string[]> {
  const rows = await q<{ id: number }>(`
    SELECT m.id FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.user_id = ? AND m.thread_id = ? AND (mb.role IS NULL OR mb.role NOT IN ('trash','junk'))
    ORDER BY m.date ASC
  `, [userId, threadId]);
  return rows.map((r) => `m${r.id}`);
}

// ---- mutations (optimistic local write + queued IMAP op) ----

const KEYWORD_FLAG: Record<string, { col: string; imap: string; invert: boolean }> = {
  $seen: { col: 'unread', imap: '\\Seen', invert: true },
  $flagged: { col: 'flagged', imap: '\\Flagged', invert: false },
  $answered: { col: 'answered', imap: '\\Answered', invert: false },
};

export async function setKeywords(userId: number, emailId: string, patch: Record<string, boolean>): Promise<void> {
  const row = await getMsgRow(userId, emailId);
  if (!row) return;
  const add: string[] = [];
  const remove: string[] = [];
  for (const [kw, val] of Object.entries(patch)) {
    const map = KEYWORD_FLAG[kw];
    if (!map) continue;
    const dbVal = map.invert ? !val : val;
    await run(`UPDATE messages SET ${map.col} = ? WHERE id = ?`, [dbVal, row.id]);
    (val ? add : remove).push(map.imap);
  }
  if (patch.$seen === true) {
    await run('UPDATE messages SET opened_at = COALESCE(opened_at, ?) WHERE id = ?', [Date.now(), row.id]);
  }
  if (patch.$seen === false) {
    // manual mark-unread = "hands off": retention must never touch this message again
    await run("UPDATE messages SET user_touched = true, disposition = 'keep', delete_at = NULL, keep_reason = 'user touched' WHERE id = ?", [row.id]);
  }
  if ((add.length || remove.length) && row.uid > 0) {
    await enqueueOp(row.account_id, 'setFlags', { mailboxId: row.mailbox_id, uid: row.uid, add, remove });
  }
  await bumpState();
}

export async function setLabels(userId: number, emailId: string, labelIds: number[]): Promise<void> {
  const row = await getMsgRow(userId, emailId);
  if (!row) return;
  const before = (await q<{ label_id: number }>('SELECT label_id FROM message_labels WHERE message_id = ?', [row.id])).map((l) => l.label_id);
  await run('DELETE FROM message_labels WHERE message_id = ?', [row.id]);
  for (const lid of labelIds) {
    await run(`
      INSERT INTO message_labels(message_id, label_id)
      SELECT ?, id FROM labels WHERE id = ? AND user_id = ?
      ON CONFLICT DO NOTHING
    `, [row.id, lid, userId]);
  }
  await recordCorrection(userId, row, before, labelIds);
  await bumpState();
}

/**
 * A manual relabel is training data (DESIGN.md §6): log it, retarget the message's
 * embedding so similar mail lands right next time, and suggest a deterministic rule
 * once the same sender has been corrected to the same label 3+ times.
 */
async function recordCorrection(userId: number, row: MsgRow, before: number[], after: number[]): Promise<void> {
  const added = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  if (added.length === 0 && removed.length === 0) return;
  const fromDomain = row.from_addr.split('@')[1]?.toLowerCase() ?? '';

  await run('INSERT INTO corrections(user_id, email_id, from_domain, from_label_id, to_label_id, kind, created_at) VALUES (?,?,?,?,?,?,?)',
    [userId, row.id, fromDomain, removed[0] ?? null, added[0] ?? null, 'relabel', Date.now()]);

  // recompute disposition under the new labels; correcting a label = user opinion
  const { recomputeDisposition } = await import('../classify/engine.ts');
  await recomputeDisposition(row.id);

  if (added.length > 0) {
    // the embedding memory follows the user's correction immediately
    await run('UPDATE email_vectors SET label_id = ? WHERE message_id = ?', [added[0], row.id]);

    if (fromDomain) {
      const evidence = await one<{ c: number }>(`
        SELECT COUNT(*) AS c FROM corrections
        WHERE user_id = ? AND from_domain = ? AND to_label_id = ? AND created_at > ?
      `, [userId, fromDomain, added[0], Date.now() - 90 * 86_400_000]);
      const hasRule = await one('SELECT 1 FROM rules WHERE user_id = ? AND match_field = ? AND lower(match_value) = ? AND label_id = ?',
        [userId, 'from_domain', fromDomain, added[0]]);
      if ((evidence?.c ?? 0) >= 3 && !hasRule) {
        await run(`
          INSERT INTO rule_suggestions(user_id, match_field, match_value, label_id, evidence, status, created_at)
          VALUES (?,?,?,?,?,'pending',?)
          ON CONFLICT (user_id, match_field, match_value, label_id)
          DO UPDATE SET evidence = excluded.evidence, status = CASE WHEN rule_suggestions.status = 'dismissed' THEN 'dismissed' ELSE 'pending' END
        `, [userId, 'from_domain', fromDomain, added[0], evidence!.c, Date.now()]);
      }
    }
  }
}

/** Move to a mailbox ("mb:<id>" same-account, or "u:<role>" resolved per account). */
export async function moveEmail(userId: number, emailId: string, target: string): Promise<void> {
  const row = await getMsgRow(userId, emailId);
  if (!row) return;
  let targetMailboxId: number | null = null;
  if (target.startsWith('mb:')) {
    targetMailboxId = Number(target.slice(3));
    const tmb = await one<{ account_id: number }>('SELECT account_id FROM mailboxes WHERE id = ?', [targetMailboxId]);
    if (!tmb || tmb.account_id !== row.account_id) return;
  } else if (target.startsWith('u:')) {
    const targetRole = target.slice(2);
    const tmb = await one<{ id: number }>('SELECT id FROM mailboxes WHERE account_id = ? AND role = ?', [row.account_id, targetRole]);
    if (!tmb) return;
    targetMailboxId = tmb.id;
  }
  if (!targetMailboxId || targetMailboxId === row.mailbox_id) return;

  const targetRoleRow = await one<{ role: string | null }>('SELECT role FROM mailboxes WHERE id = ?', [targetMailboxId]);
  const realUid = row.uid;
  // optimistic local move: placeholder uid until the next sync reconciles
  await run('UPDATE messages SET mailbox_id = ?, uid = ? WHERE id = ?', [targetMailboxId, -row.id, row.id]);
  if (targetRoleRow?.role === 'trash') {
    await run('UPDATE messages SET trashed_at = COALESCE(trashed_at, ?) WHERE id = ?', [Date.now(), row.id]);
  } else if (row.mailbox_role === 'trash') {
    // restored from trash by the user: clear the purge clock and protect from re-trashing
    await run("UPDATE messages SET trashed_at = NULL, user_touched = true, disposition = 'keep', delete_at = NULL, keep_reason = 'restored from trash' WHERE id = ?", [row.id]);
  }
  if (realUid > 0) {
    await enqueueOp(row.account_id, 'move', { mailboxId: row.mailbox_id, uid: realUid, targetMailboxId });
  }
  await bumpState();
}

// Set by scheduler wiring to cancel a pending send when its Scheduled message is deleted.
let cancelSchedule: (messageId: string | null) => Promise<boolean> = async () => false;
export function setScheduleCanceller(fn: (messageId: string | null) => Promise<boolean>): void { cancelSchedule = fn; }

/** Delete = move to trash; trash/junk expunge permanently; deleting a Scheduled item cancels the send. */
export async function destroyEmail(userId: number, emailId: string): Promise<void> {
  const row = await getMsgRow(userId, emailId);
  if (!row) return;
  if (row.mailbox_role === 'scheduled') {
    await cancelSchedule(row.message_id);
    if (row.uid > 0) await enqueueOp(row.account_id, 'expunge', { mailboxId: row.mailbox_id, uid: row.uid });
    await deleteMessageRow(row.id);
    await bumpState();
  } else if (row.mailbox_role === 'trash' || row.mailbox_role === 'junk') {
    if (row.uid > 0) await enqueueOp(row.account_id, 'expunge', { mailboxId: row.mailbox_id, uid: row.uid });
    await deleteMessageRow(row.id);
    await bumpState();
  } else {
    await moveEmail(userId, emailId, 'u:trash');
  }
}
