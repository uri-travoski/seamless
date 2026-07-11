import { q, one, run, bumpState } from '../db.ts';
import { evaluateRules, type MatchableMessage, type RuleRow } from './rules.ts';
import { plog } from './settings.ts';
import { enqueueOp } from '../imap/sync.ts';

const TICK_MS = 20_000;
const BATCH = 200;

export interface LabelRetention {
  id: number; name: string; keep_default: boolean; retention_days: number | null; protected: boolean; auto_mark_read: boolean;
}

let broadcastChange: (userId: number) => void = () => {};
export function onClassified(fn: (userId: number) => void): void { broadcastChange = fn; }

/**
 * Recompute a message's disposition from its labels (DESIGN.md §4).
 * protected / keep_default -> keep; else the shortest labelled retention wins.
 * user_touched always wins: hands off.
 */
export async function recomputeDisposition(rowId: number): Promise<void> {
  const msg = await one<{ id: number; date: number; user_touched: boolean }>(
    'SELECT id, date, user_touched FROM messages WHERE id = ?', [rowId]);
  if (!msg) return;
  const labels = await q<LabelRetention>(`
    SELECT l.id, l.name, l.keep_default, l.retention_days, l.protected, l.auto_mark_read
    FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = ?
  `, [rowId]);

  if (msg.user_touched) {
    await run("UPDATE messages SET disposition = 'keep', delete_at = NULL, keep_reason = 'user touched' WHERE id = ?", [rowId]);
    return;
  }
  const keeper = labels.find((l) => l.protected || l.keep_default);
  if (keeper) {
    await run("UPDATE messages SET disposition = 'keep', delete_at = NULL, keep_reason = ? WHERE id = ?",
      [`label: ${keeper.name}`, rowId]);
    return;
  }
  const days = labels.map((l) => l.retention_days).filter((d): d is number => d !== null && d > 0);
  if (days.length > 0) {
    const min = Math.min(...days);
    await run("UPDATE messages SET disposition = 'delete', delete_at = ?, keep_reason = NULL WHERE id = ?",
      [msg.date + min * 86_400_000, rowId]);
    return;
  }
  await run("UPDATE messages SET disposition = 'keep', delete_at = NULL, keep_reason = NULL WHERE id = ?", [rowId]);
}

interface PendingRow {
  id: number; user_id: number; account_id: number; mailbox_id: number; uid: number;
  from_addr: string; to_json: string; cc_json: string; delivered_to: string | null;
  subject: string; headers_json: string; unread: boolean; mailbox_role: string | null;
}

/** Classify one message through the deterministic rules tier. */
export async function classifyMessage(row: PendingRow, rules: RuleRow[]): Promise<void> {
  // only inbox-like folders get rules applied; the rest just leave the pending state
  if (row.mailbox_role && row.mailbox_role !== 'inbox' && row.mailbox_role !== 'archive') {
    await run("UPDATE messages SET classify_state = 'classified' WHERE id = ?", [row.id]);
    return;
  }

  const body = (await one<{ body: string }>('SELECT body FROM message_fts WHERE message_id = ?', [row.id]))?.body ?? '';
  const msg: MatchableMessage = {
    fromAddr: row.from_addr,
    toAddrs: [...JSON.parse(row.to_json), ...JSON.parse(row.cc_json)].map((a: any) => a.email ?? ''),
    deliveredTo: row.delivered_to,
    subject: row.subject,
    body,
    headers: Object.fromEntries(Object.entries(JSON.parse(row.headers_json || '{}')).map(([k, v]) => [k.toLowerCase(), String(v)])),
  };

  const matched = evaluateRules(msg, rules.filter((r) => r.user_id === row.user_id));
  let needsReview = false;
  const appliedLabels: string[] = [];

  for (const rule of matched) {
    await run('UPDATE rules SET hit_count = hit_count + 1 WHERE id = ?', [rule.id]);
    if (rule.action === 'ai') {
      // AI tier lands in phase 3 — surface these in the review lane instead of guessing
      needsReview = true;
      continue;
    }
    if (rule.label_id) {
      await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?) ON CONFLICT DO NOTHING', [row.id, rule.label_id]);
      const label = await one<LabelRetention>('SELECT id, name, keep_default, retention_days, protected, auto_mark_read FROM labels WHERE id = ?', [rule.label_id]);
      if (label) {
        appliedLabels.push(label.name);
        if (label.auto_mark_read && row.unread) {
          await run('UPDATE messages SET unread = false WHERE id = ?', [row.id]);
          if (row.uid > 0) await enqueueOp(row.account_id, 'setFlags', { mailboxId: row.mailbox_id, uid: row.uid, add: ['\\Seen'], remove: [] });
        }
      }
    }
  }

  await recomputeDisposition(row.id);
  await run('UPDATE messages SET classify_state = ?, review_reason = ? WHERE id = ?',
    [needsReview ? 'needs_review' : 'classified', needsReview ? 'routed to AI (not configured yet)' : null, row.id]);

  if (matched.length > 0) {
    const d = await one<{ disposition: string; delete_at: number | null }>('SELECT disposition, delete_at FROM messages WHERE id = ?', [row.id]);
    await plog(row.user_id, 'classify',
      `rules matched [${matched.map((m) => m.id).join(',')}] -> labels [${appliedLabels.join(', ') || 'none'}], ${d?.disposition}${d?.delete_at ? ' at ' + new Date(d.delete_at).toISOString().slice(0, 10) : ''}${needsReview ? ', needs review' : ''}`,
      { emailId: row.id });
  }
}

/** Process a batch of pending messages; returns how many were classified. */
export async function processPending(): Promise<number> {
  const rows = await q<PendingRow>(`
    SELECT m.id, m.user_id, m.account_id, m.mailbox_id, m.uid, m.from_addr, m.to_json, m.cc_json,
           m.delivered_to, m.subject, m.headers_json, m.unread, mb.role AS mailbox_role
    FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.classify_state = 'pending'
    ORDER BY m.id
    LIMIT ${BATCH}
  `);
  if (rows.length === 0) return 0;

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const rules = await q<RuleRow>('SELECT * FROM rules WHERE enabled = true AND user_id = ANY(?)', [userIds]);

  for (const row of rows) {
    try {
      await classifyMessage(row, rules);
    } catch (err: any) {
      await run("UPDATE messages SET classify_state = 'classified' WHERE id = ?", [row.id]);
      await plog(row.user_id, 'classify', `error: ${err?.message ?? err}`, { emailId: row.id, level: 'error' });
    }
  }
  await bumpState();
  for (const uid of userIds) broadcastChange(uid);
  return rows.length;
}

/** Re-run classification for a user (after rule edits / import). */
export async function reclassifyUser(userId: number, opts: { includeReviewed?: boolean } = {}): Promise<number> {
  const states = opts.includeReviewed ? ['classified', 'needs_review'] : ['classified', 'needs_review'];
  const n = await run(`
    UPDATE messages SET classify_state = 'pending'
    WHERE user_id = ? AND classify_state = ANY(?)
      AND mailbox_id IN (SELECT id FROM mailboxes WHERE role IN ('inbox','archive') OR role IS NULL)
  `, [userId, states]);
  await plog(userId, 'classify', `reclassification queued for ${n} messages`);
  kickClassifier();
  return n;
}

let classifyTimer: NodeJS.Timeout | null = null;
let running = false;

export function kickClassifier(): void {
  if (classifyTimer) { clearTimeout(classifyTimer); classifyTimer = null; }
  void loop();
}

async function loop(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // drain in batches until nothing is pending
    while ((await processPending()) === BATCH) { /* keep draining */ }
  } catch (err: any) {
    console.error('[classify] loop error:', err?.message ?? err);
  } finally {
    running = false;
    classifyTimer = setTimeout(() => { classifyTimer = null; void loop(); }, TICK_MS);
  }
}

export function startClassifier(): void {
  setTimeout(() => void loop(), 3_000);
}
