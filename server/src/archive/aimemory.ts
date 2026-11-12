/**
 * AI memory in archives (T8.10): `ai/ai_decisions.jsonl`, `ai/email_vectors.jsonl` (for the archived messages) and
 * `ai/memory.json` (preferences, rules, label retention, newsletter sender choices — never provider keys).
 * Import merges: nothing local is overwritten, items are de-duplicated by a stable key.
 */
import { gunzipSync } from 'node:zlib';
import { q, one, run, insertId } from '../db.ts';
import type { BlobStore } from '../s3.ts';

export const AI_FORMAT = 'seamless-ai-memory';
const CHUNK = 2000;

const dec = (x: any) => x;

export interface AiExportInfo { decisions: number; vectors: number; embeddingModel: string; files: string[] }

export async function writeAiMemory(userId: number, prefix: string, store: BlobStore, messageIds: number[]): Promise<AiExportInfo> {
  const decLines: string[] = []; const vecLines: string[] = [];
  let model = '';
  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const ids = messageIds.slice(i, i + CHUNK);
    for (const d of await q<any>('SELECT * FROM ai_decisions WHERE user_id = ? AND email_id = ANY(?::int[]) ORDER BY id', [userId, ids])) {
      decLines.push(JSON.stringify({ messageKey: `M${d.email_id}`, tier: d.tier, model: d.model, output: d.output, confidence: d.confidence, reason: d.reason, cacheKey: d.cache_key, preferenceVersion: d.preference_version, createdAt: Number(d.created_at) }));
    }
    for (const v of await q<any>('SELECT message_id, label_id, dim, embedding::text AS emb, weight, model, corrected, created_at FROM email_vectors WHERE user_id = ? AND message_id = ANY(?::int[]) ORDER BY message_id', [userId, ids])) {
      if (v.model) model = v.model;
      vecLines.push(JSON.stringify({ messageKey: `M${v.message_id}`, labelKey: `L${v.label_id}`, dim: v.dim, embedding: JSON.parse(v.emb), weight: Number(v.weight), model: v.model, corrected: v.corrected, createdAt: Number(v.created_at) }));
    }
  }
  const files: string[] = [];
  const put = async (name: string, body: Buffer) => { await store.put(`${prefix}ai/${name}`, body, name.endsWith('.json') ? 'application/json' : 'application/x-ndjson'); files.push(`${prefix}ai/${name}`); };
  await put('ai_decisions.jsonl', Buffer.from(decLines.join('\n') + (decLines.length ? '\n' : '')));
  await put('email_vectors.jsonl', Buffer.from(vecLines.join('\n') + (vecLines.length ? '\n' : '')));

  const labels = await q<any>('SELECT id, name, keep_default, retention_days, protected, auto_mark_read FROM labels WHERE user_id = ? ORDER BY id', [userId]);
  const mem = {
    format: AI_FORMAT, version: 1, createdAt: Date.now(), embeddingModel: model,
    preferences: (await q<any>('SELECT guidance, enabled, version FROM preferences WHERE user_id = ? AND active = true ORDER BY id', [userId])).map((p) => ({ guidance: p.guidance, enabled: p.enabled, version: p.version })),
    rules: (await q<any>('SELECT * FROM rules WHERE user_id = ? ORDER BY ord, id', [userId])).map((r) => ({
      enabled: r.enabled, matchField: r.match_field, matchValue: r.match_value, excludeContains: r.exclude_contains, action: r.action,
      labelKey: r.label_id ? `L${r.label_id}` : null, stop: r.stop, note: r.note, source: r.source })),
    labelRetention: labels.map((l) => ({ labelKey: `L${l.id}`, name: l.name, retentionDays: l.retention_days, keepDefault: l.keep_default, protected: l.protected, autoMarkRead: l.auto_mark_read })),
    newsletterSenders: (await q<any>('SELECT sender, choice FROM newsletter_senders WHERE user_id = ? ORDER BY id', [userId])).map((n) => ({ sender: n.sender, choice: n.choice })),
  };
  await put('memory.json', Buffer.from(JSON.stringify(mem)));
  return { decisions: decLines.length, vectors: vecLines.length, embeddingModel: model, files };
}

async function readText(store: BlobStore, path: string): Promise<string | null> {
  try { const b = await store.get(path); return (path.endsWith('.gz') ? gunzipSync(b) : b).toString('utf8'); } catch { return null; }
}
const lines = (t: string | null) => (t ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

export const hasAiMemory = (m: any) => m?.ai_memory === true;

/** preferences, rules, label retention, newsletter senders. Merge only. */
export async function importAiSettings(userId: number, store: BlobStore, rb: (p: string) => string, m: any, labels: Map<string, number>, opts: { rules?: boolean } = {}): Promise<{ created: number; skipped: number }> {
  const res = { created: 0, skipped: 0 };
  const text = await readText(store, rb(`${String(m.ai?.prefix ?? '')}ai/memory.json`));
  let mem: any; try { mem = JSON.parse(text ?? 'null'); } catch { mem = null; }
  if (!mem || mem.format !== AI_FORMAT) return res;
  const now = Date.now();
  for (const p of mem.preferences ?? []) {
    const g = String(p.guidance ?? '').trim();
    if (!g) continue;
    if (await one('SELECT 1 FROM preferences WHERE user_id = ? AND active = true AND lower(guidance) = lower(?)', [userId, g])) { res.skipped++; continue; }
    await insertId('INSERT INTO preferences(user_id, enabled, guidance, version, active, created_at) VALUES (?,?,?,?,true,?)', [userId, p.enabled !== false, g, 1, now]);
    res.created++;
  }
  for (const r of opts.rules === false ? [] : mem.rules ?? []) {   // the Rules tick-box still decides about rules
    const labelId = r.labelKey ? labels.get(r.labelKey) ?? null : null;
    if (r.action === 'label' && !labelId) { res.skipped++; continue; }
    if (await one('SELECT 1 FROM rules WHERE user_id = ? AND match_field = ? AND lower(match_value) = lower(?) AND action = ? AND label_id IS NOT DISTINCT FROM ?', [userId, r.matchField, r.matchValue, r.action, labelId])) { res.skipped++; continue; }
    const ord = ((await one<{ n: number }>('SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM rules WHERE user_id = ?', [userId]))?.n) ?? 1;
    await run(`INSERT INTO rules(user_id, enabled, ord, match_field, match_value, exclude_contains, action, label_id, stop, note, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'imported', ?)`,
      [userId, !!r.enabled, ord, r.matchField, r.matchValue, r.excludeContains ?? '', r.action, labelId, !!r.stop, r.note ?? '', now]);
    res.created++;
  }
  for (const l of mem.labelRetention ?? []) {
    const id = labels.get(l.labelKey);
    if (!id) continue;
    // only fill what the local label has not decided yet
    const n = await one<{ id: number }>('UPDATE labels SET retention_days = ?, keep_default = ?, protected = ?, auto_mark_read = ? WHERE id = ? AND user_id = ? AND retention_days IS NULL AND NOT keep_default AND NOT protected AND NOT auto_mark_read RETURNING id',
      [l.retentionDays ?? null, !!l.keepDefault, !!l.protected, !!l.autoMarkRead, id, userId]);
    if (n && (l.retentionDays != null || l.keepDefault || l.protected || l.autoMarkRead)) res.created++; else res.skipped++;
  }
  for (const n of mem.newsletterSenders ?? []) {
    if (!['inbox', 'read_later', 'unsubscribed'].includes(n.choice)) continue;
    const r = await one<{ id: number }>('INSERT INTO newsletter_senders(user_id, sender, choice, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING RETURNING id', [userId, String(n.sender).toLowerCase(), n.choice, now]);
    if (r) res.created++; else res.skipped++;
  }
  return res;
}

/** decisions + vectors of the imported messages (needs the new message ids). Idempotent. */
export async function importAiMessages(userId: number, store: BlobStore, rb: (p: string) => string, m: any, importId: number, labels: Map<string, number>): Promise<{ decisions: number; vectors: number }> {
  const out = { decisions: 0, vectors: 0 };
  const idOf = new Map<string, number>();
  for (const r of await q<{ message_key: string; message_id: number }>("SELECT message_key, message_id FROM mail_archive_imports WHERE import_id = ? AND state = 'imported' AND message_id IS NOT NULL", [importId])) idOf.set(r.message_key, r.message_id);
  const base = String(m.ai?.prefix ?? '');
  for (const d of lines(await readText(store, rb(`${base}ai/ai_decisions.jsonl`)))) {
    const id = idOf.get(d.messageKey); if (!id) continue;
    const r = await one<{ id: number }>(
      `INSERT INTO ai_decisions(user_id, email_id, tier, model, output, confidence, reason, cache_key, preference_version, created_at)
       SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM ai_decisions WHERE email_id = ? AND tier = ? AND created_at = ?) RETURNING id`,
      [userId, id, d.tier, d.model ?? '', typeof d.output === 'string' ? d.output : JSON.stringify(dec(d.output)), d.confidence ?? 0, d.reason ?? '', d.cacheKey ?? null, d.preferenceVersion ?? null, d.createdAt, id, d.tier, d.createdAt]);
    if (r) out.decisions++;
  }
  for (const v of lines(await readText(store, rb(`${base}ai/email_vectors.jsonl`)))) {
    const id = idOf.get(v.messageKey); const lid = labels.get(v.labelKey);
    if (!id || !lid || !Array.isArray(v.embedding)) continue;
    const lit = '[' + v.embedding.map((x: number) => (Number.isFinite(x) ? x.toFixed(6) : '0')).join(',') + ']';
    const r = await one<{ message_id: number }>(
      `INSERT INTO email_vectors(message_id, user_id, label_id, dim, embedding, created_at, weight, model, corrected) VALUES (?,?,?,?,?::vector,?,?,?,?) ON CONFLICT DO NOTHING RETURNING message_id`,
      [id, userId, lid, v.dim, lit, v.createdAt ?? Date.now(), v.weight ?? 1, v.model ?? '', !!v.corrected]);
    if (r) out.vectors++;
  }
  return out;
}
