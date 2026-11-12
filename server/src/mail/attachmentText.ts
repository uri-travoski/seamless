/**
 * Attachment content search (T6.2 F-41). Text is pulled out of PDF / DOCX / XLSX / CSV / PPTX / TXT / MD / HTML
 * attachments by the `attachments.extract` job and stored in `attachment_text`, which the search joins with the body.
 *
 * OCR is deliberately NOT built (heavy dependency, off by default in the spec). Extension point: add an entry to
 * `pickExtractor` for image/* that returns the recognised text — nothing else needs to change.
 */
import { simpleParser } from 'mailparser';
import { q, one, run } from '../db.ts';
import { getBlob } from '../s3.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { getUserSetting, setUserSetting } from '../classify/settings.ts';

export const MAX_TEXT = 200 * 1024;          // stored per attachment
export const MAX_INPUT = 20 * 1024 * 1024;   // larger attachments are skipped
export const BACKFILL_BATCH = 100;           // messages per backfill run

type Extractor = (buf: Buffer) => Promise<string>;

function stripTags(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

const pdf: Extractor = async (buf) => {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try { return String((await parser.getText()).text ?? ''); } finally { await parser.destroy?.().catch?.(() => {}); }
};
const docx: Extractor = async (buf) => {
  const mammoth = await import('mammoth');
  return String((await (mammoth.default ?? mammoth).extractRawText({ buffer: buf })).value ?? '');
};
const xlsx: Extractor = async (buf) => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    out.push(ws.name);
    ws.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell((c) => {
        const v: any = c.value;
        if (v == null) return;
        cells.push(typeof v === 'object' ? String(v.text ?? v.result ?? (v.richText ? v.richText.map((r: any) => r.text).join('') : '')) : String(v));
      });
      if (cells.length) out.push(cells.join(' '));
    });
  });
  return out.join('\n');
};
const pptx: Extractor = async (buf) => {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const out: string[] = [];
  for (const n of names) {
    const xml = await zip.files[n].async('string');
    out.push([...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  }
  return out.join('\n');
};
const plain: Extractor = async (buf) => buf.toString('utf8');
const html: Extractor = async (buf) => stripTags(buf.toString('utf8'));

/** Which extractor handles an attachment (by extension first, then MIME). null = unsupported, skip. */
export function pickExtractor(filename: string, mime: string): Extractor | null {
  const ext = (filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]) ?? '';
  const m = mime.toLowerCase();
  if (ext === 'pdf' || m === 'application/pdf') return pdf;
  if (ext === 'docx' || m.includes('wordprocessingml')) return docx;
  if (ext === 'xlsx' || m.includes('spreadsheetml')) return xlsx;
  if (ext === 'pptx' || m.includes('presentationml')) return pptx;
  if (ext === 'html' || ext === 'htm' || m === 'text/html') return html;
  if (['txt', 'md', 'csv', 'tsv', 'log', 'json', 'xml'].includes(ext) || m === 'text/plain' || m === 'text/csv' || m === 'text/markdown') return plain;
  return null;   // images (OCR not built), archives, unknown binaries
}

export async function extractText(buf: Buffer, filename: string, mime: string): Promise<string | null> {
  if (buf.length > MAX_INPUT) return null;
  const ex = pickExtractor(filename, mime);
  if (!ex) return null;
  try {
    const text = (await ex(buf)).replace(/\u0000/g, '').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    return text.slice(0, MAX_TEXT);
  } catch { return null; }   // encrypted / corrupt file: not searchable, not an error
}

/** Index every attachment of one message. Returns how many were stored. Idempotent. */
export async function indexMessageAttachments(messageId: number): Promise<number> {
  const row = await one<{ user_id: number; s3_key: string | null; has_attachments: boolean }>(
    'SELECT user_id, s3_key, has_attachments FROM messages WHERE id = ?', [messageId]);
  if (!row || !row.s3_key || !row.has_attachments) return 0;
  const parsed = await simpleParser(await getBlob(row.s3_key));
  let n = 0;
  for (let i = 0; i < parsed.attachments.length; i++) {
    const att = parsed.attachments[i];
    if (att.contentDisposition === 'inline' && att.cid) continue;
    const filename = att.filename ?? `attachment-${i}`;
    const text = await extractText(att.content, filename, att.contentType ?? '');
    if (text === null) continue;
    await run(`
      INSERT INTO attachment_text(user_id, message_id, part_id, filename, mime, text, created_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (message_id, part_id) DO UPDATE SET filename = excluded.filename, mime = excluded.mime, text = excluded.text
    `, [row.user_id, messageId, String(i), filename, att.contentType ?? '', text, Date.now()]);
    n++;
  }
  return n;
}

export async function queueAttachmentIndex(userId: number, messageId: number): Promise<void> {
  await enqueueJob(userId, 'attachments.extract', Date.now(), { messageId });
}

// ---- backfill (admin button on Health): resumable, 100 messages per run, cursor in user_settings ----
const CURSOR = 'attach_backfill_cursor';   // last message id processed
const STATE = 'attach_backfill_state';     // 'running' | 'done' | ''

export async function backfillStatus(userId: number): Promise<{ state: string; processed: number; total: number }> {
  const cursor = Number(await getUserSetting(userId, CURSOR)) || 0;
  const state = await getUserSetting(userId, STATE);
  const total = Number((await one<{ c: string }>('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND has_attachments = true', [userId]))?.c ?? 0);
  const done = Number((await one<{ c: string }>('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND has_attachments = true AND id <= ?', [userId, cursor]))?.c ?? 0);
  return { state, processed: state === 'done' ? total : done, total };
}

export async function startBackfill(userId: number, restart = false): Promise<void> {
  if (restart || (await getUserSetting(userId, STATE)) === 'done') await setUserSetting(userId, CURSOR, '0');
  await setUserSetting(userId, STATE, 'running');
  await enqueueJob(userId, 'attachments.backfill', Date.now(), {});
}

/** One run: the next BACKFILL_BATCH messages after the cursor. Re-enqueues itself until none are left. */
export async function runBackfillBatch(userId: number): Promise<number> {
  const cursor = Number(await getUserSetting(userId, CURSOR)) || 0;
  const rows = await q<{ id: number }>(
    `SELECT id FROM messages WHERE user_id = ? AND has_attachments = true AND id > ? ORDER BY id LIMIT ?`, [userId, cursor, BACKFILL_BATCH]);
  for (const r of rows) {
    await indexMessageAttachments(r.id).catch((err) => console.error('[attachments] index failed:', err?.message ?? err));
    await setUserSetting(userId, CURSOR, String(r.id));   // after each message, so a crash resumes here
  }
  if (rows.length < BACKFILL_BATCH) await setUserSetting(userId, STATE, 'done');
  else await enqueueJob(userId, 'attachments.backfill', Date.now(), {});
  return rows.length;
}

registerJob('attachments.extract', async (job) => { await indexMessageAttachments(Number(job.payload.messageId)); });
registerJob('attachments.backfill', async (job) => { if (job.user_id) await runBackfillBatch(job.user_id); });
