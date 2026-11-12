/**
 * AI transparency + sticky corrections (T8.10).
 *
 *   why?      what filed this message (rule / similar mail / AI), how sure, and what it matched
 *   Fix it    a correction = labels + decision(tier 'user', confidence 1) + a heavy labelled vector + user_touched,
 *             optionally a guidance line; everything needed to undo it is kept on the `corrections` row
 *   health    "12 waiting · 0 failed · last verdict 2 min ago", re-learning count, stuck-backlog detection
 *   relearn   vectors made by another embedding model/dimension are re-embedded lazily
 */
import { q, one, run, insertId, bumpState } from '../db.ts';
import { getTaskProvider } from '../ai/client.ts';
import { embedText, embeddingInput, upsertVector } from './ai.ts';
import { getUserSetting, setUserSetting, plog } from './settings.ts';
import { isViewing } from '../mode.ts';
import { getMsgRow, type MsgRow } from '../mail/store.ts';

export const CORRECTION_WEIGHT = 3;
export const RULE_OFFER_AFTER = 3;
const DAY = 86_400_000;

export class MemoryError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// ---------- decisions written by the engine ----------
export async function recordDecision(userId: number, rowId: number, tier: 'rule' | 'note' | 'user', reason: string, output: unknown, confidence = 1, model = ''): Promise<number> {
  return insertId(`INSERT INTO ai_decisions(user_id, email_id, tier, model, output, confidence, reason, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    [userId, rowId, tier, model, JSON.stringify(output), confidence, reason, Date.now()]);
}

// ---------- 1. Why is this here? ----------
export interface WhyInfo {
  visible: boolean;
  filedBy?: 'rule' | 'similar' | 'ai' | 'note';
  corrected?: boolean;
  confidence?: number;
  reason?: string;
  model?: string;
  at?: number;
  rule?: { id: number | null; field: string; value: string } | null;
  similar?: { subject: string; from: string; corrected: boolean } | null;
  labels?: { id: number; name: string }[];
  retention?: { disposition: string; deleteAt: number | null; keepReason: string | null };
  correctionId?: number | null;
  offerRule?: { suggestionId: number; matchField: string; matchValue: string; labelId: number; evidence: number } | null;
  canFix?: boolean;
}

export async function whyForMessage(userId: number, row: MsgRow): Promise<WhyInfo> {
  if (row.user_id !== userId) return { visible: false };   // shared mail: the owner's memory is not shown to others
  const decs = await q<any>('SELECT * FROM ai_decisions WHERE email_id = ? ORDER BY id DESC LIMIT 20', [row.id]);
  const machine = decs.find((d) => d.tier !== 'user');
  if (!machine) return { visible: false };       // nothing decided yet, or filed by hand
  const latest = decs[0];
  const out = (() => { try { return JSON.parse(machine.output); } catch { return {}; } })();
  const labels = await q<{ id: number; name: string }>('SELECT l.id, l.name FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = ? ORDER BY l.name', [row.id]);
  const m = await one<{ disposition: string; delete_at: number | null; keep_reason: string | null }>('SELECT disposition, delete_at, keep_reason FROM messages WHERE id = ?', [row.id]);
  const corr = await one<{ id: number }>('SELECT id FROM corrections WHERE email_id = ? AND user_id = ? AND undone = false ORDER BY id DESC LIMIT 1', [row.id, userId]);
  const filedBy = machine.tier === 'rule' ? 'rule' : machine.tier === 'note' ? 'note' : machine.tier === 'embedding' ? 'similar' : 'ai';
  const sug = corr ? await one<any>(
    `SELECT s.* FROM rule_suggestions s JOIN corrections c ON c.user_id = s.user_id AND c.to_label_id = s.label_id
     WHERE s.user_id = ? AND s.status = 'pending' AND c.email_id = ? AND c.undone = false ORDER BY s.evidence DESC LIMIT 1`, [userId, row.id]) : undefined;
  return {
    visible: true, filedBy, corrected: latest.tier === 'user',
    confidence: Number(machine.confidence), reason: machine.reason || out.reason || '', model: machine.model || '', at: Number(machine.created_at),
    rule: filedBy === 'rule' ? { id: out.ruleId ?? null, field: out.matchField ?? '', value: out.matchValue ?? '' } : null,
    similar: filedBy === 'similar' && out.similar ? { subject: out.similar.subject, from: out.similar.from, corrected: !!out.corrected } : null,
    labels, retention: { disposition: m?.disposition ?? 'keep', deleteAt: m?.delete_at != null ? Number(m.delete_at) : null, keepReason: m?.keep_reason ?? null },
    correctionId: corr?.id ?? null,
    offerRule: sug ? { suggestionId: sug.id, matchField: sug.match_field, matchValue: sug.match_value, labelId: sug.label_id, evidence: sug.evidence } : null,
    canFix: true,
  };
}

// ---------- 2. corrections ----------
interface UndoSnapshot {
  labels: number[]; disposition: string; deleteAt: number | null; keepReason: string | null; userTouched: boolean;
  classifyState: string; reviewReason: string | null;
  vector: { labelId: number; weight: number; corrected: boolean; model: string } | null;
  decisionId: number | null; prefId: number | null;
}

async function snapshot(rowId: number): Promise<UndoSnapshot> {
  const m = await one<any>('SELECT disposition, delete_at, keep_reason, user_touched, classify_state, review_reason FROM messages WHERE id = ?', [rowId]);
  const v = await one<any>('SELECT label_id, weight, corrected, model FROM email_vectors WHERE message_id = ?', [rowId]);
  return {
    labels: (await q<{ label_id: number }>('SELECT label_id FROM message_labels WHERE message_id = ?', [rowId])).map((l) => l.label_id),
    disposition: m.disposition, deleteAt: m.delete_at != null ? Number(m.delete_at) : null, keepReason: m.keep_reason, userTouched: m.user_touched,
    classifyState: m.classify_state, reviewReason: m.review_reason,
    vector: v ? { labelId: v.label_id, weight: Number(v.weight), corrected: v.corrected, model: v.model } : null,
    decisionId: null, prefId: null,
  };
}

/** Store the corrected example as a heavy labelled vector (best effort: needs an embedding provider). */
async function rememberVector(userId: number, row: MsgRow, labelId: number): Promise<boolean> {
  if (isViewing()) return false;   // Viewing mode makes no AI calls
  const provider = await getTaskProvider(userId, 'embed');
  if (!provider) return false;
  try {
    const vec = await embedText(provider, embeddingInput(row));
    await upsertVector(userId, row.id, labelId, vec, { weight: CORRECTION_WEIGHT, model: provider.model, corrected: true });
    await noteEmbedDim(userId, vec.length);
    return true;
  } catch (err: any) {
    await plog(userId, 'classify', `could not remember correction: ${err?.message ?? err}`, { emailId: row.id, level: 'warn' });
    return false;
  }
}

export interface CorrectionInput {
  labelId?: number | null;                  // null / undefined = no label
  retention?: { mode: 'keep' } | { mode: 'delete'; days: number } | null;
  remember?: boolean;                       // default true
  why?: string;
}
export interface CorrectionResult {
  ok: true; correctionId: number; remembered: boolean; offerRule: WhyInfo['offerRule'];
}

const fromDomainOf = (a: string) => a.split('@')[1]?.toLowerCase() ?? '';

/** After a correction toward `labelId`: bump the "3 similar corrections" suggestion, return it when it is due. */
export async function suggestionAfter(userId: number, fromDomain: string, labelId: number | null): Promise<WhyInfo['offerRule']> {
  if (!fromDomain || !labelId) return null;
  const ev = await one<{ c: number }>(
    'SELECT COUNT(*) AS c FROM corrections WHERE user_id = ? AND from_domain = ? AND to_label_id = ? AND undone = false AND created_at > ?',
    [userId, fromDomain, labelId, Date.now() - 90 * DAY]);
  const n = Number(ev?.c ?? 0);
  const hasRule = await one('SELECT 1 FROM rules WHERE user_id = ? AND match_field = ? AND lower(match_value) = ? AND label_id = ?', [userId, 'from_domain', fromDomain, labelId]);
  if (n < RULE_OFFER_AFTER || hasRule) return null;
  await run(`
    INSERT INTO rule_suggestions(user_id, match_field, match_value, label_id, evidence, status, created_at)
    VALUES (?,?,?,?,?,'pending',?)
    ON CONFLICT (user_id, match_field, match_value, label_id)
    DO UPDATE SET evidence = excluded.evidence, status = CASE WHEN rule_suggestions.status = 'dismissed' THEN 'dismissed' ELSE 'pending' END
  `, [userId, 'from_domain', fromDomain, labelId, n, Date.now()]);
  const s = await one<any>("SELECT * FROM rule_suggestions WHERE user_id = ? AND match_field = 'from_domain' AND match_value = ? AND label_id = ? AND status = 'pending'", [userId, fromDomain, labelId]);
  return s ? { suggestionId: s.id, matchField: s.match_field, matchValue: s.match_value, labelId: s.label_id, evidence: s.evidence } : null;
}

/** "Wrong? Fix it": the explicit correction from the reading pane. */
export async function correctMessage(userId: number, emailId: string, input: CorrectionInput): Promise<CorrectionResult> {
  const row = await getMsgRow(userId, emailId, 'own');
  if (!row) throw new MemoryError(404, 'message not found');
  let labelId: number | null = null;
  if (input.labelId != null) {
    const l = await one<{ id: number }>('SELECT id FROM labels WHERE id = ? AND user_id = ?', [Number(input.labelId), userId]);
    if (!l) throw new MemoryError(400, 'unknown label');
    labelId = l.id;
  }
  const ret = input.retention ?? null;
  if (ret && ret.mode === 'delete' && !(Number(ret.days) > 0 && Number(ret.days) <= 3650)) throw new MemoryError(400, 'days must be 1–3650');
  const remember = input.remember !== false;
  const why = String(input.why ?? '').trim().slice(0, 500);
  const before = await snapshot(row.id);
  const fromDomain = fromDomainOf(row.from_addr);

  await run('DELETE FROM message_labels WHERE message_id = ?', [row.id]);
  if (labelId) await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?) ON CONFLICT DO NOTHING', [row.id, labelId]);

  const { recomputeDisposition } = await import('./engine.ts');
  await run('UPDATE messages SET user_touched = true, classify_state = ?, review_reason = NULL WHERE id = ?', ['classified', row.id]);
  await recomputeDisposition(row.id);
  if (ret?.mode === 'delete') {
    // an explicit "delete after N days" must stay sweepable: the sweep skips user_touched mail, so that flag is cleared
    await run("UPDATE messages SET user_touched = false, disposition = 'delete', delete_at = ?, keep_reason = ? WHERE id = ?",
      [Number(row.date) + Math.round(Number(ret.days)) * DAY, 'you chose: delete after ' + Math.round(Number(ret.days)) + ' days', row.id]);
  } else if (ret?.mode === 'keep') {
    await run("UPDATE messages SET disposition = 'keep', delete_at = NULL, keep_reason = 'you chose: keep' WHERE id = ?", [row.id]);
  }

  const snap = before;
  snap.decisionId = await recordDecision(userId, row.id, 'user', why || 'corrected by you',
    { label: labelId, retention: ret, remembered: remember }, 1);
  let remembered = false;
  if (remember && labelId) remembered = await rememberVector(userId, row, labelId);
  if (remember && !labelId) await run('DELETE FROM email_vectors WHERE message_id = ? AND user_id = ?', [row.id, userId]);   // "no label" = forget the old example
  if (why) {
    snap.prefId = await insertId('INSERT INTO preferences(user_id, enabled, guidance, version, active, created_at) VALUES (?,?,?,1,true,?)', [userId, true, why, Date.now()]);
  }
  const corrId = await insertId(
    `INSERT INTO corrections(user_id, email_id, from_domain, from_label_id, to_label_id, kind, created_at, source, remembered, why, undo_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [userId, row.id, fromDomain, before.labels[0] ?? null, labelId, 'relabel', Date.now(), 'fix', remember, why, JSON.stringify(snap)]);
  const offerRule = remember ? await suggestionAfter(userId, fromDomain, labelId) : null;
  await bumpState();
  await plog(userId, 'classify', `corrected by user -> ${labelId ?? 'no label'}${remember ? ' (remembered)' : ''}`, { emailId: row.id });
  return { ok: true, correctionId: corrId, remembered, offerRule };
}

/** A label or move done by hand = a quiet correction (same storage, no prompt). Called from the mail store. */
export async function recordHandCorrection(userId: number, row: MsgRow, added: number[], removed: number[], kind: 'relabel' | 'move', movedTo?: string): Promise<void> {
  const machine = await one('SELECT 1 FROM ai_decisions WHERE email_id = ? AND tier <> \'user\' LIMIT 1', [row.id]);
  if (kind === 'move' && !machine) return;           // moving mail nobody filed is just moving
  const fromDomain = fromDomainOf(row.from_addr);
  const snap = await snapshot(row.id);
  if (kind === 'relabel') {                          // the labels are already changed: reconstruct "before" from the diff
    snap.labels = [...snap.labels.filter((l) => !added.includes(l)), ...removed];
  }
  snap.decisionId = await recordDecision(userId, row.id, 'user', kind === 'move' ? `moved by you to ${movedTo}` : 'labelled by you',
    kind === 'move' ? { movedTo } : { label: added[0] ?? null }, 1);
  let remembered = false;
  if (kind === 'relabel' && added[0]) {
    remembered = await rememberVector(userId, row, added[0]);
    if (!remembered) await run('UPDATE email_vectors SET label_id = ? WHERE message_id = ?', [added[0], row.id]);   // the memory follows the correction
  }
  await insertId(
    `INSERT INTO corrections(user_id, email_id, from_domain, from_label_id, to_label_id, kind, created_at, source, remembered, why, undo_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [userId, row.id, fromDomain, removed[0] ?? null, added[0] ?? null, kind === 'move' ? 'delete' : 'relabel', Date.now(), kind === 'move' ? 'move' : 'label', remembered, '', JSON.stringify(snap)]);
  if (kind === 'relabel') await suggestionAfter(userId, fromDomain, added[0] ?? null);
}

export async function listCorrections(userId: number, limit = 100) {
  const rows = await q<any>(`
    SELECT c.*, m.subject, m.from_addr, lf.name AS from_name, lt.name AS to_name
    FROM corrections c LEFT JOIN messages m ON m.id = c.email_id
    LEFT JOIN labels lf ON lf.id = c.from_label_id LEFT JOIN labels lt ON lt.id = c.to_label_id
    WHERE c.user_id = ? AND c.undone = false ORDER BY c.id DESC LIMIT ?`, [userId, limit]);
  return rows.map((c) => ({
    id: c.id, emailId: c.email_id ? `m${c.email_id}` : null, subject: c.subject ?? '', from: c.from_addr ?? '', fromLabel: c.from_name ?? null, toLabel: c.to_name ?? null,
    source: c.source, remembered: c.remembered, why: c.why, createdAt: Number(c.created_at),
  }));
}

/** Undo one correction: labels, retention, flags, the heavy vector, the guidance line and the decision row all go back. */
export async function undoCorrection(userId: number, id: number): Promise<boolean> {
  const c = await one<any>('SELECT * FROM corrections WHERE id = ? AND user_id = ? AND undone = false', [id, userId]);
  if (!c) return false;
  const snap: UndoSnapshot | null = c.undo_json ? JSON.parse(c.undo_json) : null;
  const msg = c.email_id ? await one('SELECT id FROM messages WHERE id = ? AND user_id = ?', [c.email_id, userId]) : null;
  if (snap && msg) {
    const rowId = Number(c.email_id);
    await run('DELETE FROM message_labels WHERE message_id = ?', [rowId]);
    for (const lid of snap.labels) await run('INSERT INTO message_labels(message_id, label_id) SELECT ?, id FROM labels WHERE id = ? AND user_id = ? ON CONFLICT DO NOTHING', [rowId, lid, userId]);
    await run('UPDATE messages SET disposition = ?, delete_at = ?, keep_reason = ?, user_touched = ?, classify_state = ?, review_reason = ? WHERE id = ?',
      [snap.disposition, snap.deleteAt, snap.keepReason, snap.userTouched, snap.classifyState, snap.reviewReason, rowId]);
    if (snap.vector) {
      await run('UPDATE email_vectors SET label_id = ?, weight = ?, corrected = ?, model = ? WHERE message_id = ?', [snap.vector.labelId, snap.vector.weight, snap.vector.corrected, snap.vector.model, rowId]);
    } else {
      await run('DELETE FROM email_vectors WHERE message_id = ? AND user_id = ? AND corrected = true', [rowId, userId]);
    }
  }
  if (snap?.decisionId) await run('DELETE FROM ai_decisions WHERE id = ? AND user_id = ?', [snap.decisionId, userId]);
  if (snap?.prefId) await run('UPDATE preferences SET active = false, version = version + 1 WHERE id = ? AND user_id = ?', [snap.prefId, userId]);
  await run('UPDATE corrections SET undone = true WHERE id = ?', [id]);
  await bumpState();
  return true;
}

// ---------- 3. health ----------
export async function noteEmbedDim(userId: number, dim: number): Promise<void> {
  if (Number(await getUserSetting(userId, 'embed_dim')) !== dim) await setUserSetting(userId, 'embed_dim', String(dim));
}
export async function noteAiError(userId: number, message: string | null): Promise<void> {
  if (message) await setUserSetting(userId, 'ai_last_error', JSON.stringify({ at: Date.now(), message: message.slice(0, 300) }));
  else if (await getUserSetting(userId, 'ai_last_error')) await setUserSetting(userId, 'ai_last_error', '');
}

export const STUCK_AFTER_MS = 30 * 60_000;

export async function aiHealth(userId: number, now = Date.now()) {
  const waiting = Number((await one<{ c: string }>("SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND classify_state = 'pending'", [userId]))?.c ?? 0);
  const failed = Number((await one<{ c: string }>("SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND classify_state = 'needs_review' AND (review_reason ILIKE '%failed%' OR review_reason ILIKE '%no classify provider%')", [userId]))?.c ?? 0);
  const last = await one<{ t: string }>("SELECT MAX(created_at) AS t FROM ai_decisions WHERE user_id = ? AND tier IN ('llm','embedding')", [userId]);
  const oldest = await one<{ t: string }>("SELECT MIN(created_at) AS t FROM messages WHERE user_id = ? AND classify_state = 'pending'", [userId]);
  const dim = Number(await getUserSetting(userId, 'embed_dim')) || 0;
  const relearning = dim ? Number((await one<{ c: string }>('SELECT COUNT(*) AS c FROM email_vectors v JOIN messages m ON m.id = v.message_id WHERE v.user_id = ? AND v.dim <> ?', [userId, dim]))?.c ?? 0) : 0;
  let lastError: { at: number; message: string } | null = null;
  try { const raw = await getUserSetting(userId, 'ai_last_error'); if (raw) lastError = JSON.parse(raw); } catch { /* ignore */ }
  const oldestAt = oldest?.t ? Number(oldest.t) : null;
  const stuck = !!(oldestAt && now - oldestAt > STUCK_AFTER_MS && lastError && now - lastError.at < 2 * STUCK_AFTER_MS);
  const providers = Number((await one<{ c: string }>("SELECT COUNT(*) AS c FROM ai_tasks WHERE user_id = ? AND task = 'classify' AND enabled = true", [userId]))?.c ?? 0);
  return {
    waiting, failed, lastVerdictAt: last?.t ? Number(last.t) : null, relearning, stuck, lastError,
    configured: providers > 0, status: (stuck ? 'red' : failed > 0 || relearning > 0 ? 'warn' : 'ok') as 'ok' | 'warn' | 'red',
  };
}

/** Manual "Retry now": failed reviews go back to the queue and the classifier runs immediately. */
export async function retryAi(userId: number): Promise<number> {
  const n = await run(
    "UPDATE messages SET classify_state = 'pending', review_reason = NULL WHERE user_id = ? AND classify_state = 'needs_review' AND (review_reason ILIKE '%failed%' OR review_reason ILIKE '%no classify provider%')", [userId]);
  const { kickClassifier } = await import('./engine.ts');
  kickClassifier();
  return Number(n);
}

// ---------- 4. lazy re-embedding after a provider/dimension change ----------
export async function relearnBatch(limit = 20): Promise<number> {
  let done = 0;
  const users = await q<{ user_id: number; value: string }>("SELECT user_id, value FROM user_settings WHERE key = 'embed_dim' AND value <> ''");
  for (const u of users) {
    if (done >= limit) break;
    const dim = Number(u.value);
    const provider = await getTaskProvider(u.user_id, 'embed');
    if (!provider || !dim) continue;
    const rows = await q<any>(`
      SELECT v.message_id, v.label_id, v.weight, v.corrected, m.from_addr, m.subject, m.snippet
      FROM email_vectors v JOIN messages m ON m.id = v.message_id
      WHERE v.user_id = ? AND v.dim <> ? ORDER BY v.message_id LIMIT ?`, [u.user_id, dim, limit - done]);
    for (const r of rows) {
      try {
        const vec = await embedText(provider, embeddingInput(r));
        if (vec.length !== dim) { await setUserSetting(u.user_id, 'embed_dim', String(vec.length)); break; }
        await run('UPDATE email_vectors SET embedding = ?::vector, dim = ?, model = ? WHERE message_id = ?',
          ['[' + vec.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',') + ']', vec.length, provider.model, r.message_id]);
        done++;
      } catch (err: any) { await noteAiError(u.user_id, `re-embedding failed: ${err?.message ?? err}`); break; }
    }
  }
  return done;
}
