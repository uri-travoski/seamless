import type { AiVerdict } from '@seamless/shared';
import { q, one, run, bumpState } from '../db.ts';
import { evaluateRules, baseAddress, type MatchableMessage, type RuleRow } from './rules.ts';
import { getUserSetting, plog } from './settings.ts';
import { getTaskProvider } from '../ai/client.ts';
import { embedText, embeddingInput, embeddingMatch, upsertVector, llmClassify, recordEmbeddingDecision, matchTeachNote } from './ai.ts';
import { enqueueOp } from '../imap/sync.ts';
import { isVipMessage } from '../mail/vip.ts';
import { isViewing } from '../mode.ts';
import { recordDecision, noteAiError, noteEmbedDim, relearnBatch } from './memory.ts';

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
  // VIP senders: labels/AI may still label, but nothing may schedule removal from the Inbox
  if (await isVipMessage(rowId)) {
    await run("UPDATE messages SET disposition = 'keep', delete_at = NULL, keep_reason = 'VIP sender' WHERE id = ?", [rowId]);
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
  id: number; user_id: number; account_id: number; mailbox_id: number; uid: number; date: number;
  from_addr: string; from_name: string; to_json: string; cc_json: string; delivered_to: string | null;
  subject: string; snippet: string; headers_json: string; unread: boolean; mailbox_role: string | null;
}

interface ProcessorNote {
  id: number; scope: string; scope_value: string; note: string;
  label_id: number | null; auto_read: boolean; retention_days: number | null; delete_if_unread: boolean;
}

const RETENTION_DAYS: Record<string, number | null> = { keep: null, delete: 30, keep_1y: 365, keep_2y: 730, keep_3y: 1095 };

async function applyLabel(row: PendingRow, labelId: number): Promise<LabelRetention | null> {
  await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?) ON CONFLICT DO NOTHING', [row.id, labelId]);
  const label = await one<LabelRetention>(
    'SELECT id, name, keep_default, retention_days, protected, auto_mark_read FROM labels WHERE id = ?', [labelId]);
  if (label?.auto_mark_read && row.unread) await markRead(row);
  return label ?? null;
}

async function markRead(row: PendingRow): Promise<void> {
  await run('UPDATE messages SET unread = false WHERE id = ?', [row.id]);
  if (row.uid > 0) await enqueueOp(row.account_id, 'setFlags', { mailboxId: row.mailbox_id, uid: row.uid, add: ['\\Seen'], remove: [] });
  row.unread = false;
}

/** Trust order for retention: protected/keep labels > processor note > AI verdict > label countdown. */
export async function applyVerdictRetention(row: PendingRow, v: AiVerdict): Promise<void> {
  if (await isVipMessage(row.id)) return; // VIP: the verdict may label, never schedule removal
  const cur = await one<{ disposition: string; keep_reason: string | null }>(
    'SELECT disposition, keep_reason FROM messages WHERE id = ?', [row.id]);
  if (!cur) return;
  if (cur.disposition === 'keep' && cur.keep_reason) return; // a keep/protected label or user already decided
  if (cur.disposition === 'delete') {
    // a label already set the countdown — the verdict may only rescue actionable/real documents
    if (v.requires_action || v.is_real_document) {
      await run("UPDATE messages SET disposition = 'keep', delete_at = NULL, keep_reason = ? WHERE id = ?",
        [v.requires_action ? 'AI: requires action' : 'AI: real document', row.id]);
    }
    return;
  }

  if (v.requires_action || (v.retention === 'keep') || (v.worth_keeping && !v.retention?.startsWith('keep_'))) {
    const reason = v.requires_action ? 'AI: requires action' : v.is_real_document ? 'AI: real document' : 'AI: worth keeping';
    await run("UPDATE messages SET disposition = 'keep', delete_at = NULL, keep_reason = ? WHERE id = ?", [reason, row.id]);
    return;
  }
  let days = RETENTION_DAYS[v.retention] ?? null;
  if (v.warranty_months && v.warranty_months > 0) {
    days = Math.max(days ?? 0, Math.round(v.warranty_months * 30.44));
  }
  if (days) {
    await run("UPDATE messages SET disposition = 'delete', delete_at = ?, keep_reason = ? WHERE id = ?",
      [row.date + days * 86_400_000, `AI: ${v.reason ?? v.retention}`, row.id]);
  }
}

/** Classify one message through the cascade: rules -> embeddings -> LLM -> review (DESIGN.md §3). */
export async function classifyMessage(row: PendingRow, rules: RuleRow[]): Promise<void> {
  // only inbox-like folders get the cascade; the rest just leave the pending state
  if (row.mailbox_role && row.mailbox_role !== 'inbox' && row.mailbox_role !== 'archive') {
    await run("UPDATE messages SET classify_state = 'classified' WHERE id = ?", [row.id]);
    return;
  }

  const body = (await one<{ body: string }>('SELECT body FROM message_fts WHERE message_id = ?', [row.id]))?.body ?? '';
  const headers = Object.fromEntries(Object.entries(JSON.parse(row.headers_json || '{}')).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const msg: MatchableMessage = {
    fromAddr: row.from_addr,
    toAddrs: [...JSON.parse(row.to_json), ...JSON.parse(row.cc_json)].map((a: any) => a.email ?? ''),
    deliveredTo: row.delivered_to,
    subject: row.subject,
    body,
    headers,
  };

  // ---- tier 1: deterministic rules ----
  const matched = evaluateRules(msg, rules.filter((r) => r.user_id === row.user_id));
  const guidance: string[] = [];
  let aiRouted = false;
  let labelApplied: LabelRetention | null = null;
  const appliedNames: string[] = [];

  for (const rule of matched) {
    await run('UPDATE rules SET hit_count = hit_count + 1 WHERE id = ?', [rule.id]);
    if (rule.action === 'ai') {
      aiRouted = true;
      if (rule.note) guidance.push(rule.note);
      continue;
    }
    if (rule.label_id) {
      const label = await applyLabel(row, rule.label_id);
      if (label) {
        labelApplied = label; appliedNames.push(label.name);
        await recordDecision(row.user_id, row.id, 'rule', `Rule: ${rule.match_field} ${rule.match_value}`,
          { ruleId: rule.id, matchField: rule.match_field, matchValue: rule.match_value, label: label.name });
      }
    }
  }

  // ---- processor notes: per-sender/domain instructions (highest-priority guidance) ----
  const fromBase = baseAddress(row.from_addr);
  const fromDomain = row.from_addr.split('@')[1]?.toLowerCase() ?? '';
  const notes = await q<ProcessorNote>(`
    SELECT * FROM processor_notes
    WHERE user_id = ? AND active = true
      AND ((scope = 'sender' AND lower(scope_value) = ?) OR (scope = 'domain' AND lower(scope_value) = ?))
  `, [row.user_id, fromBase, fromDomain]);
  for (const n of notes) {
    if (n.note) guidance.push(n.note);
    if (n.label_id) {
      const label = await applyLabel(row, n.label_id);
      if (label) {
        labelApplied = label; appliedNames.push(label.name);
        await recordDecision(row.user_id, row.id, 'note', `Your note for ${n.scope_value}`, { noteId: n.id, scope: n.scope, label: label.name });
      }
    }
    if (n.auto_read && row.unread) await markRead(row);
  }

  // ---- tiers 2+3 for anything rules didn't settle ----
  let needsReview = false;
  let reviewReason: string | null = null;
  let verdict: AiVerdict | null = null;
  let vec: number[] | null = null;
  const embedProvider = await getTaskProvider(row.user_id, 'embed');

  // ---- teach-the-AI tier: match this message to a taught example by content embedding ----
  if (embedProvider && !labelApplied) {
    const anyTeach = await one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM processor_notes WHERE user_id = ? AND scope = 'similar' AND active = true AND embedding IS NOT NULL", [row.user_id]);
    if (anyTeach && anyTeach.c > 0) {
      try {
        vec = await embedText(embedProvider, embeddingInput(row));
        await noteEmbedDim(row.user_id, vec.length);
        const teachThreshold = Number(await getUserSetting(row.user_id, 'teach_threshold')) || 0.86;
        const tm = await matchTeachNote(row.user_id, vec, teachThreshold);
        if (tm) {
          if (tm.note) guidance.push(tm.note);
          if (tm.summary) guidance.push(tm.summary);
          if (tm.labelId) {
            const label = await applyLabel(row, tm.labelId);
            if (label) {
              labelApplied = label; appliedNames.push(label.name);
              await recordDecision(row.user_id, row.id, 'note', 'Similar to a message you taught the AI about', { noteId: tm.id, label: label.name, similarity: tm.sim }, tm.sim);
            }
          }
          if (tm.autoRead && row.unread) await markRead(row);
          await plog(row.user_id, 'classify', `teach-note #${tm.id} matched (sim ${tm.sim.toFixed(2)})`, { emailId: row.id });
        }
      } catch (err: any) {
        await plog(row.user_id, 'classify', `teach tier error: ${err?.message ?? err}`, { emailId: row.id, level: 'warn' });
      }
    }
  }

  if (!labelApplied || aiRouted) {
    // tier 2: embedding similarity (skipped for ai-routed mixed senders — those need content judgment)
    if (!aiRouted && !labelApplied && embedProvider) {
      try {
        vec ??= await embedText(embedProvider, embeddingInput(row));
        await noteEmbedDim(row.user_id, vec.length);
        const threshold = Number(await getUserSetting(row.user_id, 'embed_threshold')) || 0.88;
        const match = await embeddingMatch(row.user_id, vec, threshold);
        if (match) {
          const label = await applyLabel(row, match.labelId);
          if (label) {
            labelApplied = label; appliedNames.push(label.name);
            await recordEmbeddingDecision(row.user_id, row.id, match, label.name);
          }
        }
      } catch (err: any) {
        await noteAiError(row.user_id, `embedding: ${err?.message ?? err}`);
        await plog(row.user_id, 'classify', `embedding tier error: ${err?.message ?? err}`, { emailId: row.id, level: 'warn' });
      }
    }

    // tier 3: cheap LLM with structured output
    if (!labelApplied || aiRouted) {
      try {
        const res = await llmClassify({
          userId: row.user_id, rowId: row.id,
          fromAddr: row.from_addr, fromName: row.from_name, subject: row.subject,
          headers, guidance,
        });
        if (res) {
          await noteAiError(row.user_id, null);
          const threshold = Number(await getUserSetting(row.user_id, 'ai_conf_threshold')) || 0.7;
          if (res.verdict.confidence >= threshold) {
            verdict = res.verdict;
            if (verdict.label) {
              const label = await one<LabelRetention>(
                'SELECT id, name, keep_default, retention_days, protected, auto_mark_read FROM labels WHERE user_id = ? AND lower(name) = lower(?)',
                [row.user_id, verdict.label]);
              if (label) {
                await applyLabel(row, label.id);
                labelApplied = label; appliedNames.push(label.name);
              }
            }
          } else {
            needsReview = true;
            reviewReason = `AI unsure (${Math.round(res.verdict.confidence * 100)}%): ${res.verdict.reason ?? ''}`;
          }
        } else if (aiRouted) {
          needsReview = true;
          reviewReason = 'routed to AI, but no classify provider is configured (Settings > AI)';
        }
      } catch (err: any) {
        await noteAiError(row.user_id, `classify: ${err?.message ?? err}`);
        await plog(row.user_id, 'classify', `LLM tier error: ${err?.message ?? err}`, { emailId: row.id, level: 'warn' });
        if (aiRouted) { needsReview = true; reviewReason = 'AI classification failed'; }
      }
    }
  }

  // ---- disposition: labels, then AI verdict, then processor-note retention (strongest) ----
  await recomputeDisposition(row.id);
  if (verdict && !needsReview) await applyVerdictRetention(row, verdict);
  const vip = await isVipMessage(row.id);
  for (const n of notes) {
    if (n.retention_days && !vip) {
      await run("UPDATE messages SET disposition = 'delete', delete_at = ?, keep_reason = ?, delete_if_unread = ? WHERE id = ? AND user_touched = false",
        [row.date + n.retention_days * 86_400_000, `note: ${n.scope_value}`, n.delete_if_unread, row.id]);
    }
  }

  await run('UPDATE messages SET classify_state = ?, review_reason = ? WHERE id = ?',
    [needsReview ? 'needs_review' : 'classified', reviewReason, row.id]);

  // ---- grow the memory: remember this labelling for the similarity tier ----
  if (labelApplied && embedProvider && !needsReview) {
    try {
      vec ??= await embedText(embedProvider, embeddingInput(row));
      await upsertVector(row.user_id, row.id, labelApplied.id, vec, { model: embedProvider.model });
    } catch { /* embedding memory is best-effort */ }
  }

  if (matched.length > 0 || appliedNames.length > 0 || needsReview || verdict) {
    const d = await one<{ disposition: string; delete_at: number | null }>('SELECT disposition, delete_at FROM messages WHERE id = ?', [row.id]);
    await plog(row.user_id, 'classify',
      `${appliedNames.length ? `labels [${appliedNames.join(', ')}]` : 'no label'}, ${d?.disposition}` +
      (d?.delete_at ? ` at ${new Date(d.delete_at).toISOString().slice(0, 10)}` : '') +
      (verdict ? ` (AI: ${verdict.reason ?? verdict.category})` : '') +
      (needsReview ? ` — needs review: ${reviewReason}` : ''),
      { emailId: row.id });
  }
}

/** Process a batch of pending messages; returns how many were classified. */
export async function processPending(): Promise<number> {
  if (isViewing()) return 0;   // Viewing mode (T8.7/T8.10): the classifier never runs — no AI calls, nothing is re-filed
  const rows = await q<PendingRow>(`
    SELECT m.id, m.user_id, m.account_id, m.mailbox_id, m.uid, m.date, m.from_addr, m.from_name,
           m.to_json, m.cc_json, m.delivered_to, m.subject, m.snippet, m.headers_json, m.unread,
           mb.role AS mailbox_role
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
export async function reclassifyUser(userId: number): Promise<number> {
  const n = await run(`
    UPDATE messages SET classify_state = 'pending'
    WHERE user_id = ? AND classify_state IN ('classified','needs_review')
      AND mailbox_id IN (SELECT id FROM mailboxes WHERE role IN ('inbox','archive') OR role IS NULL)
  `, [userId]);
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
    if (!isViewing()) await relearnBatch();
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
