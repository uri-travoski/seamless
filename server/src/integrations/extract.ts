/**
 * Field extraction for the BizBooks and task connectors (T5.2).
 * An AI call (schema-constrained prompt) fills the fields; deterministic regexes fill whatever the AI left empty,
 * and are the only source when no AI provider is configured.
 */
import { chatComplete, extractJson, getTaskProvider } from '../ai/client.ts';

export interface BillFields {
  supplier: string | null; abn: string | null; total: number | null; gst: number | null;
  dueDate: string | null; invoiceNumber: string | null;
}
export const EMPTY_BILL: BillFields = { supplier: null, abn: null, total: null, gst: null, dueDate: null, invoiceNumber: null };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "5/3/2026", "5 March 2026", "2026-03-05" → "2026-03-05" (day first, as in Australia). */
export function normaliseDate(raw: string): string | null {
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = Number(m[1]), mo = Number(m[2]);
    return d >= 1 && d <= 31 && mo >= 1 && mo <= 12 ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mo >= 0 ? `${m[3]}-${pad(mo + 1)}-${pad(Number(m[1]))}` : null;
  }
  return null;
}

const money = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.replace(/[, ]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** Regex-only extraction. Never throws. */
export function regexBill(text: string, fromName = ''): BillFields {
  const out: BillFields = { ...EMPTY_BILL, supplier: fromName.trim() || null };
  const abn = text.match(/\bABN\b[^0-9]{0,12}((?:\d[ ]?){11})\b/i) ?? text.match(/\b(\d{2} ?\d{3} ?\d{3} ?\d{3})\b/);
  if (abn) { const d = abn[1].replace(/\s/g, ''); if (d.length === 11) out.abn = d; }
  const amt = '\\$?\\s*([0-9][0-9,]*(?:\\.\\d{2})?)';
  const total = text.match(new RegExp(`(?:total\\s+(?:amount\\s+)?(?:due|payable|inc(?:l|luding)?\\.?\\s*gst)?|amount\\s+due|balance\\s+due|total)[^0-9$\\n]{0,20}${amt}`, 'i'));
  out.total = money(total?.[1]);
  const gst = text.match(new RegExp(`\\bgst\\b(?:\\s+(?:amount|included|total))?[^0-9$\\n]{0,20}${amt}`, 'i'));
  out.gst = money(gst?.[1]);
  const due = text.match(/due(?:\s+date)?\s*(?:on|by|:|-)?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4})/i);
  if (due) out.dueDate = normaliseDate(due[1]);
  const inv = text.match(/invoice\s*(?:no\.?|number|#|num)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,24})/i);
  if (inv && /\d/.test(inv[1])) out.invoiceNumber = inv[1];
  return out;
}

export type Extractor = (userId: number, task: 'bill' | 'task', text: string) => Promise<Record<string, unknown> | null>;

/** Default extractor: the user's AI provider (summarize task), JSON-only. Returns null when unavailable or it fails. */
export const aiExtract: Extractor = async (userId, task, text) => {
  const provider = await getTaskProvider(userId, 'summarize').catch(() => null);
  if (!provider) return null;
  const schema = task === 'bill'
    ? '{"supplier": string|null, "abn": string (11 digits)|null, "total": number|null, "gst": number|null, "dueDate": "YYYY-MM-DD"|null, "invoiceNumber": string|null}'
    : '{"dueDate": "YYYY-MM-DD"|null}';
  const system = task === 'bill'
    ? `Extract bill/invoice fields from the email. Respond with JSON only, exactly this shape: ${schema}. Use null when a field is not present. Amounts are plain numbers in dollars.`
    : `If the email states a deadline or due date for something the reader must do, return it. Respond with JSON only: ${schema}. Use null if there is none.`;
  try {
    return extractJson(await chatComplete(provider, [{ role: 'system', content: system }, { role: 'user', content: text.slice(0, 6000) }], { json: true, maxTokens: 300, timeoutMs: 30_000 }));
  } catch { return null; }
};

let extractor: Extractor = aiExtract;
export function setExtractorForTests(fn?: Extractor): void { extractor = fn ?? aiExtract; }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' ? money(v) : null);

export async function extractBill(userId: number, text: string, fromName: string): Promise<BillFields> {
  const re = regexBill(text, fromName);
  const ai = await extractor(userId, 'bill', text).catch(() => null);
  if (!ai) return re;
  const abn = str(ai.abn)?.replace(/\s/g, '') ?? null;
  const due = str(ai.dueDate);
  return {
    supplier: str(ai.supplier) ?? re.supplier,
    abn: abn && /^\d{11}$/.test(abn) ? abn : re.abn,
    total: num(ai.total) ?? re.total,
    gst: num(ai.gst) ?? re.gst,
    dueDate: (due && normaliseDate(due)) || re.dueDate,
    invoiceNumber: str(ai.invoiceNumber) ?? re.invoiceNumber,
  };
}

/** Due date for a task, only when the AI finds one. */
export async function extractTaskDue(userId: number, text: string): Promise<string | null> {
  const ai = await extractor(userId, 'task', text).catch(() => null);
  const d = str(ai?.dueDate);
  return d ? normaliseDate(d) : null;
}
