/** Lead capture (T5.4 F-38): sources, capture-on-ingest, dedupe, status, first-reply timing, stats. Everything scoped by user_id. */
import type { ParsedMail } from 'mailparser';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { queryEmails, getEmails } from '../mail/store.ts';
import { emitEvent } from '../events/emit.ts';
import { upsertContact } from '../contacts.ts';
import { chatComplete, extractJson, getTaskProvider } from '../ai/client.ts';
import { htmlToLines, parseLead, hasContact, normaliseAuPhone, EMPTY_LEAD, type LeadFields } from './parse.ts';

export class LeadError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export const LEAD_STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost', 'spam'] as const;
export const REPEAT_WINDOW_MS = 30 * 86_400_000;

// ---------- AI fallback (only when the parser found neither an email nor a phone) ----------
export type LeadExtractor = (userId: number, text: string) => Promise<Partial<Record<string, unknown>> | null>;

export const aiLeadExtract: LeadExtractor = async (userId, text) => {
  const provider = await getTaskProvider(userId, 'summarize').catch(() => null);
  if (!provider) return null;
  const system = 'Extract the enquirer\'s details from this web-form notification email. Respond with JSON only, exactly: '
    + '{"name": string|null, "email": string|null, "phone": string|null, "suburb": string|null, "service": string|null, "message": string|null, "preferred_date": string|null, "budget": string|null, "source_page": string|null, "utm": object}. '
    + 'Use null for anything not present. Do not use the form plugin\'s or website\'s own address as the email.';
  try {
    return extractJson(await chatComplete(provider, [{ role: 'system', content: system }, { role: 'user', content: text.slice(0, 6000) }], { json: true, maxTokens: 400, timeoutMs: 30_000 }));
  } catch { return null; }
};
let extractor: LeadExtractor = aiLeadExtract;
export function setLeadExtractorForTests(fn?: LeadExtractor): void { extractor = fn ?? aiLeadExtract; }

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);

/** Parse a message into lead fields; calls the AI extractor only when the deterministic parse has no email and no phone. */
export async function extractLead(userId: number, parsed: ParsedMail, opts: { useAi?: boolean } = {}): Promise<{ fields: LeadFields; usedAi: boolean }> {
  const replyTo = (parsed.replyTo?.value?.[0]?.address ?? null);
  const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase() ?? null;
  const fallback = replyTo && replyTo.toLowerCase() !== fromAddr ? replyTo : null;   // the form robot's own address is never the lead
  const html = typeof parsed.html === 'string' ? parsed.html : null;
  let fields = parseLead({ text: parsed.text ?? null, html, replyTo: fallback });
  if (fields.email && fields.email === fromAddr) fields = { ...fields, email: null };
  if (hasContact(fields) || opts.useAi === false) return { fields, usedAi: false };
  const text = (parsed.text?.trim() ? parsed.text : html ? htmlToLines(html) : '') || '';
  const ai = await extractor(userId, `Subject: ${parsed.subject ?? ''}\n\n${text}`).catch(() => null);
  if (!ai) return { fields, usedAi: true };
  const email = s(ai.email)?.toLowerCase() ?? null;
  const phone = s(ai.phone);
  const utm = ai.utm && typeof ai.utm === 'object' ? Object.fromEntries(Object.entries(ai.utm as Record<string, unknown>).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, String(v)])) : {};
  return {
    usedAi: true,
    fields: {
      ...fields, name: fields.name ?? s(ai.name), email: email && email !== fromAddr ? email : fields.email, phone: phone ? normaliseAuPhone(phone) : fields.phone,
      suburb: fields.suburb ?? s(ai.suburb), service: fields.service ?? s(ai.service), message: fields.message ?? s(ai.message),
      preferredDate: fields.preferredDate ?? s(ai.preferred_date), budget: fields.budget ?? s(ai.budget), sourcePage: fields.sourcePage ?? s(ai.source_page),
      utm: { ...utm, ...fields.utm },
    },
  };
}

// ---------- sources ----------
export interface LeadSource { id: number; businessId: number | null; name: string; query: string; enabled: boolean }
interface SourceRow { id: number; business_id: number | null; name: string; query: string; enabled: boolean }
const srcApi = (r: SourceRow): LeadSource => ({ id: r.id, businessId: r.business_id, name: r.name, query: r.query, enabled: r.enabled });

export async function listSources(userId: number): Promise<LeadSource[]> {
  return (await q<SourceRow>('SELECT id, business_id, name, query, enabled FROM lead_sources WHERE user_id = ? ORDER BY lower(name), id', [userId])).map(srcApi);
}

async function checkBusiness(userId: number, businessId: unknown): Promise<number | null> {
  if (businessId == null || businessId === '') return null;
  const id = Number(businessId);
  if (!(await one('SELECT id FROM businesses WHERE id = ? AND user_id = ?', [id, userId]))) throw new LeadError(400, 'unknown business');
  return id;
}

export interface SourceInput { name?: string; query?: string; businessId?: number | null; enabled?: boolean }

export async function createSource(userId: number, b: SourceInput): Promise<LeadSource> {
  const name = String(b.name ?? '').trim().slice(0, 80);
  const query = String(b.query ?? '').trim();
  if (!name) throw new LeadError(400, 'name required');
  if (!query) throw new LeadError(400, 'query required');
  const businessId = await checkBusiness(userId, b.businessId);
  const id = await insertId('INSERT INTO lead_sources(user_id, business_id, name, query, enabled, created_at) VALUES (?,?,?,?,?,?)',
    [userId, businessId, name, query, b.enabled ?? true, Date.now()]);
  return srcApi((await one<SourceRow>('SELECT id, business_id, name, query, enabled FROM lead_sources WHERE id = ?', [id]))!);
}

export async function updateSource(userId: number, id: number, b: SourceInput): Promise<LeadSource> {
  const cur = await one<SourceRow>('SELECT id, business_id, name, query, enabled FROM lead_sources WHERE id = ? AND user_id = ?', [id, userId]);
  if (!cur) throw new LeadError(404, 'not found');
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 80) : cur.name;
  const query = b.query !== undefined ? String(b.query).trim() : cur.query;
  if (!name || !query) throw new LeadError(400, 'name and query are required');
  const businessId = b.businessId !== undefined ? await checkBusiness(userId, b.businessId) : cur.business_id;
  await run('UPDATE lead_sources SET name=?, query=?, business_id=?, enabled=? WHERE id=? AND user_id=?', [name, query, businessId, b.enabled ?? cur.enabled, id, userId]);
  return srcApi((await one<SourceRow>('SELECT id, business_id, name, query, enabled FROM lead_sources WHERE id = ?', [id]))!);
}

export async function deleteSource(userId: number, id: number): Promise<void> {
  if ((await run('DELETE FROM lead_sources WHERE id = ? AND user_id = ?', [id, userId])) === 0) throw new LeadError(404, 'not found');
}

async function matches(userId: number, query: string, messageId: number): Promise<boolean> {
  const r = await queryEmails(userId, { filter: { text: query, scope: 'unified', messageId }, position: 0, limit: 1 }).catch(() => null);
  return !!r && r.total > 0;
}

/** "Test against recent mail": the 25 most recent messages the query matches, with what the parser would extract. */
export async function testSource(userId: number, query: string): Promise<{ matches: { id: string; subject: string; from: string; date: string; fields: LeadFields; usedAi: boolean }[]; total: number }> {
  const text = String(query ?? '').trim();
  if (!text) throw new LeadError(400, 'query required');
  const r = await queryEmails(userId, { filter: { text, scope: 'unified' }, position: 0, limit: 25 }).catch(() => { throw new LeadError(400, 'could not run that search'); });
  const { getParsed } = await import('../mail/body.ts');
  const out = [];
  for (const e of await getEmails(userId, r.ids)) {
    const rowId = Number(String(e.id).replace(/^m/, ''));
    const parsed = await getParsed(rowId, userId).catch(() => null);
    if (!parsed) continue;
    const { fields, usedAi } = await extractLead(userId, parsed, { useAi: false });
    out.push({ id: e.id, subject: e.subject, from: e.from[0]?.email ?? '', date: e.receivedAt, fields, usedAi });
  }
  return { matches: out, total: r.total };
}

// ---------- leads ----------
export interface ApiLead {
  id: number; businessId: number | null; businessName: string | null; messageId: string | null; source: string; sourceId: number | null;
  name: string | null; email: string | null; phone: string | null; suburb: string | null; service: string | null; details: string | null;
  fields: Record<string, unknown>; status: string; repeatCount: number; firstReplyAt: number | null; createdAt: number; updatedAt: number;
}
interface LeadRow {
  id: number; business_id: number | null; message_id: number | null; source_id: number | null; source: string; name: string | null; email: string | null; phone: string | null;
  suburb: string | null; service: string | null; details: string | null; fields: Record<string, unknown>; status: string; repeat_count: number;
  first_reply_at: number | string | null; created_at: number | string; updated_at: number | string; business_name?: string | null;
}
const LEAD_COLS = 'l.*, b.name AS business_name';
const leadApi = (r: LeadRow): ApiLead => ({
  id: r.id, businessId: r.business_id, businessName: r.business_name ?? null, messageId: r.message_id ? `m${r.message_id}` : null, source: r.source, sourceId: r.source_id,
  name: r.name, email: r.email, phone: r.phone, suburb: r.suburb, service: r.service, details: r.details, fields: r.fields ?? {}, status: r.status,
  repeatCount: r.repeat_count, firstReplyAt: r.first_reply_at == null ? null : Number(r.first_reply_at), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});

const tell = async (userId: number) => { await bumpState(); broadcast({ type: 'stateChange' }, userId); };

/** Called from ingest for fresh Inbox mail. Returns the lead (new or merged repeat) or null when no enabled source matches. */
export async function captureLead(userId: number, rowId: number, parsed: ParsedMail): Promise<{ lead: ApiLead; repeat: boolean } | null> {
  const sources = await q<SourceRow>('SELECT id, business_id, name, query, enabled FROM lead_sources WHERE user_id = ? AND enabled = true ORDER BY id', [userId]);
  let source: SourceRow | null = null;
  for (const src of sources) if (await matches(userId, src.query, rowId)) { source = src; break; }
  if (!source) return null;
  if (await one('SELECT id FROM leads WHERE user_id = ? AND message_id = ?', [userId, rowId])) return null;

  const { fields } = await extractLead(userId, parsed);
  const now = Date.now();
  const phone = fields.phone ? normaliseAuPhone(fields.phone) : null;
  const payloadFields = { ...fields.extra, ...(fields.utm && Object.keys(fields.utm).length ? { utm: fields.utm } : {}),
    ...(fields.preferredDate ? { preferredDate: fields.preferredDate } : {}), ...(fields.budget ? { budget: fields.budget } : {}), ...(fields.sourcePage ? { sourcePage: fields.sourcePage } : {}) };

  // duplicate: same email or phone, same user, last 30 days → merge into the existing lead
  const dup = (fields.email || phone) ? await one<LeadRow>(
    `SELECT * FROM leads WHERE user_id = ? AND created_at > ? AND ((? <> '' AND lower(email) = ?) OR (? <> '' AND phone = ?)) ORDER BY created_at DESC LIMIT 1`,
    [userId, now - REPEAT_WINDOW_MS, fields.email ?? '', fields.email ?? '', phone ?? '', phone ?? '']) : undefined;
  let id: number;
  if (dup) {
    id = dup.id;
    await run(`UPDATE leads SET repeat_count = repeat_count + 1, message_id = ?, updated_at = ?, fields = fields || ?::jsonb,
      name = COALESCE(name, ?), phone = COALESCE(phone, ?), email = COALESCE(email, ?), suburb = COALESCE(suburb, ?), service = COALESCE(service, ?)
      WHERE id = ? AND user_id = ?`,
      [rowId, now, JSON.stringify(payloadFields), fields.name, phone, fields.email, fields.suburb, fields.service, id, userId]);
  } else {
    id = await insertId(`INSERT INTO leads(user_id, business_id, message_id, source_id, source, name, email, phone, suburb, service, details, fields, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?::jsonb,'new',?,?)`,
      [userId, source.business_id, rowId, source.id, source.name, fields.name, fields.email, phone, fields.suburb, fields.service, fields.message, JSON.stringify(payloadFields), now, now]);
  }
  // the contact is the lead's own address, never the form robot
  if (fields.email) await upsertContact(userId, fields.email, fields.name ?? '', 'received', now).catch(() => {});
  const lead = (await getLead(userId, id))!;
  const msg = await one<{ account_id: number }>('SELECT account_id FROM messages WHERE id = ?', [rowId]);
  await emitEvent(userId, 'lead.captured', { type: 'lead', id }, {
    leadId: id, messageId: rowId, accountId: msg?.account_id, name: lead.name, email: lead.email, phone: lead.phone, suburb: lead.suburb, service: lead.service,
    details: lead.details, source: lead.source, businessId: lead.businessId, businessName: lead.businessName, repeat: !!dup, repeatCount: lead.repeatCount,
  });
  await tell(userId);
  return { lead, repeat: !!dup };
}

export async function getLead(userId: number, id: number): Promise<ApiLead | null> {
  const r = await one<LeadRow>(`SELECT ${LEAD_COLS} FROM leads l LEFT JOIN businesses b ON b.id = l.business_id WHERE l.id = ? AND l.user_id = ?`, [id, userId]);
  return r ? leadApi(r) : null;
}

export interface LeadFilter { business?: string; status?: string; service?: string; from?: number; to?: number; q?: string; limit?: number; offset?: number }

export async function listLeads(userId: number, f: LeadFilter): Promise<{ items: ApiLead[]; total: number; services: string[] }> {
  const where = ['l.user_id = ?']; const params: unknown[] = [userId];
  if (f.business === 'none') where.push('l.business_id IS NULL');
  else if (f.business) { where.push('l.business_id = ?'); params.push(Number(f.business)); }
  if (f.status) { where.push('l.status = ?'); params.push(f.status); }
  if (f.service) { where.push('lower(l.service) = lower(?)'); params.push(f.service); }
  if (f.from) { where.push('l.created_at >= ?'); params.push(f.from); }
  if (f.to) { where.push('l.created_at < ?'); params.push(f.to); }
  if (f.q) { where.push(`(l.name ILIKE ? OR l.email ILIKE ? OR l.phone ILIKE ? OR l.suburb ILIKE ? OR l.details ILIKE ?)`); const like = `%${f.q}%`; params.push(like, like, like, like, like); }
  const w = where.join(' AND ');
  const total = await one<{ n: number | string }>(`SELECT count(*) AS n FROM leads l WHERE ${w}`, params);
  const rows = await q<LeadRow>(`SELECT ${LEAD_COLS} FROM leads l LEFT JOIN businesses b ON b.id = l.business_id WHERE ${w} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`,
    [...params, Math.min(Math.max(f.limit ?? 100, 1), 500), Math.max(f.offset ?? 0, 0)]);
  const services = await q<{ service: string }>(`SELECT DISTINCT service FROM leads WHERE user_id = ? AND service IS NOT NULL AND service <> '' ORDER BY service`, [userId]);
  return { items: rows.map(leadApi), total: Number(total?.n ?? 0), services: services.map((x) => x.service) };
}

export async function setLeadStatus(userId: number, id: number, status: string): Promise<ApiLead> {
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) throw new LeadError(400, 'unknown status');
  if ((await run('UPDATE leads SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?', [status, Date.now(), id, userId])) === 0) throw new LeadError(404, 'not found');
  await tell(userId);
  return (await getLead(userId, id))!;
}

export async function deleteLead(userId: number, id: number): Promise<void> {
  if ((await run('DELETE FROM leads WHERE id = ? AND user_id = ?', [id, userId])) === 0) throw new LeadError(404, 'not found');
  await tell(userId);
}

/** What the "Reply" button needs: the lead's own address (not the form robot's), a subject and the business's identity. */
export async function replyDraft(userId: number, id: number): Promise<{ to: { name: string; email: string }[]; subject: string; accountId: number | null; identityId: number | null; fromEmail: string | null; inReplyToEmailId: string | null }> {
  const lead = await one<LeadRow>('SELECT * FROM leads WHERE id = ? AND user_id = ?', [id, userId]);
  if (!lead) throw new LeadError(404, 'not found');
  if (!lead.email) throw new LeadError(409, 'this lead has no email address');
  const msg = lead.message_id ? await one<{ account_id: number; subject: string }>('SELECT account_id, subject FROM messages WHERE id = ? AND user_id = ?', [lead.message_id, userId]) : undefined;
  let ident = lead.business_id
    ? await one<{ id: number; account_id: number; email: string }>(
      `SELECT id, account_id, email FROM identities WHERE user_id = ? AND business_id = ? ORDER BY (account_id = ?) DESC, is_default DESC, id LIMIT 1`, [userId, lead.business_id, msg?.account_id ?? 0])
    : undefined;
  if (!ident && msg) ident = await one(`SELECT id, account_id, email FROM identities WHERE user_id = ? AND account_id = ? ORDER BY is_default DESC, id LIMIT 1`, [userId, msg.account_id]);
  const base = lead.service ? `Your ${lead.service} enquiry` : (msg?.subject || 'Your enquiry');
  return {
    to: [{ name: lead.name ?? '', email: lead.email }], subject: /^re:/i.test(base) ? base : `Re: ${base}`,
    accountId: ident?.account_id ?? msg?.account_id ?? null, identityId: ident?.id ?? null, fromEmail: ident?.email ?? null,
    inReplyToEmailId: null,   // the form robot's message is deliberately not the reply target
  };
}

/** A message was sent to these addresses at `when`: stamp first_reply_at on leads waiting for a reply (and move new → contacted). */
export async function markLeadReplies(userId: number, recipients: string[], when: number): Promise<number> {
  const emails = [...new Set(recipients.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0) return 0;
  const n = await run(`UPDATE leads SET first_reply_at = ?, status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, updated_at = ?
    WHERE user_id = ? AND first_reply_at IS NULL AND created_at <= ? AND lower(email) = ANY(?::text[])`, [when, Date.now(), userId, when, emails]);
  if (n > 0) await tell(userId);
  return n;
}

// ---------- stats ----------
export interface LeadStatRow { businessId: number | null; businessName: string | null; source: string; month: string; count: number; won: number; wonPct: number; medianFirstReplyMs: number | null; replied: number }

export async function leadStats(userId: number, months = 12): Promise<LeadStatRow[]> {
  const since = Date.now() - Math.max(1, Math.min(months, 36)) * 31 * 86_400_000;
  const rows = await q<any>(`
    SELECT l.business_id, b.name AS business_name, l.source,
      to_char(to_timestamp(l.created_at / 1000.0) AT TIME ZONE 'Australia/Perth', 'YYYY-MM') AS month,
      count(*) AS n, count(*) FILTER (WHERE l.status = 'won') AS won, count(l.first_reply_at) AS replied,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY (l.first_reply_at - l.created_at)) FILTER (WHERE l.first_reply_at IS NOT NULL) AS median_ms
    FROM leads l LEFT JOIN businesses b ON b.id = l.business_id
    WHERE l.user_id = ? AND l.created_at >= ?
    GROUP BY l.business_id, b.name, l.source, month ORDER BY month DESC, b.name NULLS LAST, l.source`, [userId, since]);
  return rows.map((r) => ({
    businessId: r.business_id, businessName: r.business_name, source: r.source, month: r.month, count: Number(r.n), won: Number(r.won),
    wonPct: Number(r.n) ? Math.round((Number(r.won) / Number(r.n)) * 1000) / 10 : 0, replied: Number(r.replied),
    medianFirstReplyMs: r.median_ms == null ? null : Math.round(Number(r.median_ms)),
  }));
}

export { EMPTY_LEAD };
