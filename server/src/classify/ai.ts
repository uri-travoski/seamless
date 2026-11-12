import type { AiVerdict } from '@seamless/shared';
import { q, one, insertId } from '../db.ts';
import { sha256 } from '../crypto.ts';
import { chatComplete, extractJson, getTaskProvider, type ProviderConfig } from '../ai/client.ts';
import { getParsed } from '../mail/body.ts';
import { htmlToPlain } from '../mail/send.ts';
import { normalizeSubject } from '../mail/threading.ts';

/** Extracted text of the first PDF attachments — the decisive "is this a real invoice" signal. */
export async function attachmentText(rowId: number, maxChars = 4000): Promise<string> {
  const parsed = await getParsed(rowId);
  if (!parsed) return '';
  const pdfs = parsed.attachments.filter((a) => a.contentType === 'application/pdf').slice(0, 2);
  let out = '';
  for (const att of pdfs) {
    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(att.content) });
      const res = await parser.getText();
      out += `\n--- attachment "${att.filename}" ---\n${String(res.text ?? '').slice(0, maxChars)}`;
    } catch { /* scanned/encrypted pdf — skip */ }
  }
  return out.slice(0, maxChars * 2);
}

export async function bodyText(rowId: number, maxLen = 4000): Promise<string> {
  const parsed = await getParsed(rowId);
  if (!parsed) return '';
  const text = parsed.text ?? (parsed.html ? htmlToPlain(String(parsed.html)) : '');
  return text.slice(0, maxLen);
}

// ---------- embeddings tier (3b) ----------

export async function embedText(provider: ProviderConfig, input: string): Promise<number[]> {
  const res = await fetch(`${provider.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
    body: JSON.stringify({ model: provider.model, input }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`embeddings error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  const vec = data.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('embeddings response had no vector');
  return vec;
}

export function embeddingInput(msg: { from_addr: string; subject: string; snippet: string }): string {
  return `from: ${msg.from_addr}\nsubject: ${msg.subject}\n${msg.snippet}`.slice(0, 1500);
}

const vecLiteral = (v: number[]) => '[' + v.map((x) => Number.isFinite(x) ? x.toFixed(6) : '0').join(',') + ']';

export interface EmbeddingMatch { labelId: number; confidence: number; neighbors: number; similarId?: number | null; corrected?: boolean }

/**
 * kNN against the user's labelled history; confident only when the top neighbours agree.
 * T8.10: an example the user corrected by hand (weight > 1) is trusted on its own — one close, corrected
 * neighbour is enough, and it outranks older AI-made neighbours that disagree.
 */
export async function embeddingMatch(userId: number, vec: number[], threshold: number): Promise<EmbeddingMatch | null> {
  const rows = await q<{ message_id: number; label_id: number; sim: number; weight: number; corrected: boolean }>(`
    SELECT message_id, label_id, 1 - (embedding <=> ?::vector) AS sim, weight, corrected
    FROM email_vectors WHERE user_id = ? AND dim = ?
    ORDER BY embedding <=> ?::vector LIMIT 10
  `, [vecLiteral(vec), userId, vec.length, vecLiteral(vec)]);
  const fix = rows.find((r) => r.corrected && r.sim >= threshold);
  if (fix) return { labelId: fix.label_id, confidence: fix.sim, neighbors: 1, similarId: fix.message_id, corrected: true };
  if (rows.length < 3) return null;
  const top = rows[0];
  if (top.sim < threshold) return null;
  const agree = rows.slice(0, 5).filter((r) => r.label_id === top.label_id).length;
  if (agree < 3) return null;
  return { labelId: top.label_id, confidence: top.sim, neighbors: agree, similarId: top.message_id };
}

export interface TeachMatch {
  id: number; note: string; summary: string | null;
  labelId: number | null; autoRead: boolean; retentionDays: number | null; sim: number;
}

/** Match an incoming message's embedding to the closest active "teach the AI" note anchor. */
export async function matchTeachNote(userId: number, vec: number[], threshold: number): Promise<TeachMatch | null> {
  const rows = await q<any>(`
    SELECT id, note, summary, label_id, auto_read, retention_days,
           1 - (embedding <=> ?::vector) AS sim
    FROM processor_notes
    WHERE user_id = ? AND scope = 'similar' AND active = true AND embedding IS NOT NULL AND embed_dim = ?
    ORDER BY embedding <=> ?::vector LIMIT 1
  `, [vecLiteral(vec), userId, vec.length, vecLiteral(vec)]);
  const top = rows[0];
  if (!top || top.sim < threshold) return null;
  return { id: top.id, note: top.note, summary: top.summary, labelId: top.label_id, autoRead: top.auto_read, retentionDays: top.retention_days, sim: top.sim };
}

export async function upsertVector(userId: number, messageId: number, labelId: number, vec: number[], opts: { weight?: number; model?: string; corrected?: boolean } = {}): Promise<void> {
  await q(`
    INSERT INTO email_vectors(message_id, user_id, label_id, dim, embedding, created_at, weight, model, corrected)
    VALUES (?,?,?,?,?::vector,?,?,?,?)
    ON CONFLICT (message_id) DO UPDATE SET label_id = excluded.label_id, dim = excluded.dim, embedding = excluded.embedding,
      weight = GREATEST(email_vectors.weight, excluded.weight), model = excluded.model,
      corrected = email_vectors.corrected OR excluded.corrected
  `, [messageId, userId, labelId, vec.length, vecLiteral(vec), Date.now(), opts.weight ?? 1, opts.model ?? '', !!opts.corrected]);
}

// ---------- LLM tier (3c) ----------

export interface LlmContext {
  userId: number;
  rowId: number;
  fromAddr: string; fromName: string; subject: string;
  headers: Record<string, string>;
  guidance: string[];        // rule notes for ai-routed mail + matching processor notes
}

function verdictValid(v: any): v is AiVerdict {
  return v && typeof v === 'object'
    && typeof v.confidence === 'number'
    && typeof v.is_real_document === 'boolean'
    && typeof v.requires_action === 'boolean'
    && typeof v.worth_keeping === 'boolean';
}

/**
 * Structured verdict with orthogonal fields (DESIGN.md §3c) — this is what separates
 * "payment processed" noise from a real itemised invoice, and a ToS notice from
 * "your account will be suspended".
 */
export async function llmClassify(ctx: LlmContext): Promise<{ verdict: AiVerdict; cached: boolean; model: string } | null> {
  const provider = await getTaskProvider(ctx.userId, 'classify');
  if (!provider) return null;

  const body = await bodyText(ctx.rowId);
  const cacheKey = sha256(`${ctx.fromAddr}|${normalizeSubject(ctx.subject)}|${sha256(body.slice(0, 2000))}`);
  const curPrefVersion = (await one<{ v: number }>('SELECT COALESCE(SUM(version),0)::int AS v FROM preferences WHERE user_id = ? AND active = true AND enabled = true', [ctx.userId]))?.v ?? 0;
  let cached = await one<{ output: string; model: string; created_at: number; preference_version: number | null }>(
    "SELECT output, model, created_at, preference_version FROM ai_decisions WHERE user_id = ? AND cache_key = ? AND tier = 'llm' ORDER BY id DESC LIMIT 1",
    [ctx.userId, cacheKey]);
  // T8.10: a correction for this sender (or any change of the Teach-the-AI guidance) invalidates older verdicts
  if (cached) {
    const dom = ctx.fromAddr.split('@')[1]?.toLowerCase() ?? '';
    const fixed = dom && await one(
      'SELECT 1 FROM corrections WHERE user_id = ? AND from_domain = ? AND undone = false AND remembered = true AND created_at > ? LIMIT 1',
      [ctx.userId, dom, Number(cached.created_at)]);
    if (fixed || (cached.preference_version ?? 0) !== curPrefVersion) cached = undefined;
  }
  if (cached) {
    const v = JSON.parse(cached.output);
    if (verdictValid(v)) return { verdict: v, cached: true, model: cached.model };
  }

  const labels = await q<{ name: string; description: string }>(
    'SELECT name, description FROM labels WHERE user_id = ? ORDER BY name', [ctx.userId]);
  const prefs = await q<{ guidance: string }>(
    'SELECT guidance FROM preferences WHERE user_id = ? AND enabled = true AND active = true ORDER BY id', [ctx.userId]);
  const attText = await attachmentText(ctx.rowId);

  const system = `You classify one email for a personal mail system whose goal is a near-empty inbox: keep only what is worth keeping, everything else expires.
Respond with JSON only, ALL of these orthogonal fields:
{
  "category": "receipt|statement|bill|notification|marketing|travel|school|personal|security|other",
  "label": <best label name from the list, or null>,
  "is_real_document": <true only if an itemised invoice/receipt/statement/ticket is present in the body or attachment text — a bare "payment processed" notice is false>,
  "requires_action": <true if ignoring this email has consequences (account suspension, payment due, deadline)>,
  "worth_keeping": <true if it has reference value beyond about a week>,
  "retention": "keep|delete|keep_1y|keep_2y|keep_3y",
  "warranty_months": <number if a product receipt mentions or implies a warranty, else null>,
  "confidence": <0..1>,
  "reason": "<= 12 words"
}
Available labels:
${labels.map((l) => `- "${l.name}"${l.description ? `: ${l.description}` : ''}`).join('\n')}
${prefs.length ? `\nUser preferences (follow these first):\n${prefs.map((p) => `- ${p.guidance}`).join('\n')}` : ''}
${ctx.guidance.length ? `\nGuidance for this specific sender:\n${ctx.guidance.map((g) => `- ${g}`).join('\n')}` : ''}`;

  const headerLines = Object.entries(ctx.headers).map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`).join('\n');
  const user = `From: ${ctx.fromName} <${ctx.fromAddr}>
Subject: ${ctx.subject}
${headerLines}

${body}${attText}`;

  const started = Date.now();
  const out = await chatComplete(provider, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { json: true, maxTokens: 300 });

  const v = extractJson(out);
  if (!verdictValid(v)) return null;
  v.confidence = Math.max(0, Math.min(1, v.confidence));

  const prefVersion = curPrefVersion;
  await insertId(`
    INSERT INTO ai_decisions(user_id, email_id, tier, model, output, confidence, reason, cache_key, preference_version, latency_ms, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `, [ctx.userId, ctx.rowId, 'llm', provider.model, JSON.stringify(v), v.confidence, v.reason ?? '', cacheKey, prefVersion, Date.now() - started, Date.now()]);

  return { verdict: v, cached: false, model: provider.model };
}

export async function recordEmbeddingDecision(userId: number, rowId: number, match: EmbeddingMatch, labelName: string): Promise<void> {
  let similar: { subject: string; from: string } | null = null;
  if (match.similarId) {
    const m = await one<{ subject: string; from_addr: string }>('SELECT subject, from_addr FROM messages WHERE id = ?', [match.similarId]);
    if (m) similar = { subject: m.subject, from: m.from_addr };
  }
  await insertId(`
    INSERT INTO ai_decisions(user_id, email_id, tier, model, output, confidence, reason, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `, [userId, rowId, 'embedding', '', JSON.stringify({ label: labelName, neighbors: match.neighbors, similarId: match.similarId ?? null, similar, corrected: !!match.corrected }), match.confidence,
      match.corrected ? 'similar to a message you corrected' : `similar to ${match.neighbors} labelled messages`, Date.now()]);
}
