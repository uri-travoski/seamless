import type { ApiEmail, ApiMailbox, EmailQueryRequest, EmailQueryResponse, MailboxRole } from '@seamless/shared';
import { q, one, run, bumpState, currentState } from '../db.ts';
import { parseSearch } from './searchparse.ts';
import { enqueueOp } from '../imap/sync.ts';
import { deleteMessageRow } from './ingest.ts';

const UNIFIED_ROLES: MailboxRole[] = ['inbox', 'drafts', 'sent', 'scheduled', 'archive', 'junk', 'trash'];
const UNIFIED_NAMES: Record<string, string> = {
  inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent', scheduled: 'Scheduled', archive: 'Archive', junk: 'Junk', trash: 'Trash',
};

export async function listMailboxes(userId: number): Promise<ApiMailbox[]> {
  const counts = await q<{ mailbox_id: number; total: number; unread: number }>(`
    SELECT m.mailbox_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE m.unread) AS unread
    FROM messages m WHERE m.user_id = ? GROUP BY m.mailbox_id
  `, [userId]);
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
    if (r.role) {
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
  if (r.tracking_token) {
    const t = await one<{ c: number; last: number | null }>(
      'SELECT COUNT(*) AS c, MAX(ts) AS last FROM tracking_opens WHERE token = ?', [r.tracking_token]);
    openCount = t?.c ?? 0;
    lastOpenAt = t?.last ? new Date(t.last).toISOString() : null;
  }
  const hasNote = !!(await one('SELECT 1 FROM notes WHERE user_id = ? AND email_id = ?', [r.user_id, `m${r.id}`]));
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
    lastOpenAt,
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
    `${BASE_SELECT} ${whereSql} ORDER BY m.date DESC, m.id DESC LIMIT ? OFFSET ?`,
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
  if ((add.length || remove.length) && row.uid > 0) {
    await enqueueOp(row.account_id, 'setFlags', { mailboxId: row.mailbox_id, uid: row.uid, add, remove });
  }
  await bumpState();
}

export async function setLabels(userId: number, emailId: string, labelIds: number[]): Promise<void> {
  const row = await getMsgRow(userId, emailId);
  if (!row) return;
  await run('DELETE FROM message_labels WHERE message_id = ?', [row.id]);
  for (const lid of labelIds) {
    await run(`
      INSERT INTO message_labels(message_id, label_id)
      SELECT ?, id FROM labels WHERE id = ? AND user_id = ?
      ON CONFLICT DO NOTHING
    `, [row.id, lid, userId]);
  }
  await bumpState();
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

  const realUid = row.uid;
  // optimistic local move: placeholder uid until the next sync reconciles
  await run('UPDATE messages SET mailbox_id = ?, uid = ? WHERE id = ?', [targetMailboxId, -row.id, row.id]);
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
