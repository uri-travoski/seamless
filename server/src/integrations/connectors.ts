/**
 * Connector presets on top of webhooks (T5.2): DMS, BizBooks and task apps.
 * A connector is a `webhooks` row with `connector` set; instead of the generic JSON body, `buildConnectorRequest`
 * shapes the request for that app. Delivery, retries, logging and the SSRF guard are the webhook machinery.
 *
 * ASSUMPTIONS: the DMS (`POST <base>/api/inbox/upload`) and BizBooks (`POST <base>/api/bills-inbox`) endpoints do not
 * exist yet — the shapes below are what those apps must accept (docs/integrations/*.md). Todoist and Vikunja shapes
 * follow their public REST docs (not re-checked against live docs in this unattended run).
 */
import crypto from 'node:crypto';
import type { EventRow } from '../events/notifier.ts';
import { config } from '../config.ts';
import { getMsgRow } from '../mail/store.ts';
import { getParsed } from '../mail/body.ts';
import { extractBill, extractTaskDue } from './extract.ts';

export const CONNECTORS = ['dms', 'bizbooks', 'todoist', 'vikunja', 'task-webhook'] as const;
export type Connector = typeof CONNECTORS[number];
export const TASK_CONNECTORS: readonly string[] = ['todoist', 'vikunja', 'task-webhook'];
export const isConnector = (s: unknown): s is Connector => CONNECTORS.includes(s as any);

export interface ConnectorConfig { baseUrl?: string; token?: string; projectId?: string }

/** Raised when a delivery can never succeed (nothing to send): the delivery is parked as giving_up without retries. */
export class ConnectorSkip extends Error {}

export const TODOIST_URL = 'https://api.todoist.com/rest/v2/tasks';
const PDF_INLINE_MAX = 5 * 1024 * 1024;

export interface BuiltRequest { url: string; method: string; headers: Record<string, string>; body: Buffer; summary: string }

/** The URL a connector posts to, from its config (what the webhook row's `url` column shows). */
export function connectorUrl(kind: Connector, cfg: ConnectorConfig): string {
  const base = (cfg.baseUrl ?? '').trim().replace(/\/+$/, '');
  switch (kind) {
    case 'dms': return `${base}/api/inbox/upload`;
    case 'bizbooks': return `${base}/api/bills-inbox`;
    case 'todoist': return base ? `${base}/rest/v2/tasks` : TODOIST_URL;
    case 'vikunja': return `${base}/api/v1/projects/${encodeURIComponent(cfg.projectId ?? '')}/tasks`;
    case 'task-webhook': return base;
  }
}

const sanitiseFilename = (n: string) => n.replace(/[\r\n"\\]/g, '_').slice(0, 200) || 'attachment';

function multipart(fields: { name: string; value: string }[], files: { name: string; filename: string; contentType: string; content: Buffer }[]) {
  const boundary = `----seamless${crypto.randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const f of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\nContent-Type: application/json\r\n\r\n${f.value}\r\n`));
  }
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${sanitiseFilename(f.filename)}"\r\nContent-Type: ${f.contentType.replace(/[\r\n]/g, '')}\r\n\r\n`));
    parts.push(f.content, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const messageLink = (rowId: number) => `${config.publicUrl}/mail/msg/m${rowId}`;

export async function buildConnectorRequest(
  h: { user_id: number; url: string; connector: string },
  cfg: ConnectorConfig, ev: EventRow, secretSig?: (ts: string, body: string) => Record<string, string>, now = Date.now(),
): Promise<BuiltRequest> {
  const kind = h.connector as Connector;
  if (ev.subject_type !== 'message' || !ev.subject_id) throw new ConnectorSkip('this connector needs an email');
  const row = await getMsgRow(h.user_id, `m${ev.subject_id}`).catch(() => undefined);
  if (!row) throw new ConnectorSkip('the email no longer exists or is no longer visible to you');
  const parsed = await getParsed(row.id, h.user_id);
  const text = parsed?.text ?? '';
  const auth: Record<string, string> = cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {};
  const base = { 'User-Agent': 'Seamless-Connector/1' };
  const date = new Date(Number(row.date)).toISOString();

  if (kind === 'dms') {
    const atts = (parsed?.attachments ?? []).filter((a) => a.content?.length);
    if (atts.length === 0) throw new ConnectorSkip('this email has no attachments to send to the DMS');
    const metadata = {
      sender: row.from_addr, senderName: row.from_name, subject: row.subject, date, messageId: row.message_id,
      documentType: null as string | null,   // no document classification is stored yet; the field is reserved for it
      link: messageLink(row.id),
    };
    const m = multipart([{ name: 'metadata', value: JSON.stringify(metadata) }],
      atts.map((a) => ({ name: 'file', filename: a.filename ?? 'attachment', contentType: a.contentType || 'application/octet-stream', content: a.content })));
    return {
      url: h.url, method: 'POST', body: m.body, headers: { ...base, ...auth, 'Content-Type': m.contentType },
      summary: JSON.stringify({ metadata, files: atts.map((a) => ({ filename: a.filename, size: a.size })) }),
    };
  }

  if (kind === 'bizbooks') {
    const f = await extractBill(h.user_id, `${row.subject}\n${text}`, row.from_name || row.from_addr);
    const pdf = (parsed?.attachments ?? []).find((a) => a.content?.length && (/pdf/i.test(a.contentType ?? '') || /\.pdf$/i.test(a.filename ?? '')));
    const out: Record<string, unknown> = { ...f, messageId: row.message_id, subject: row.subject, from: row.from_addr, date, link: messageLink(row.id) };
    if (pdf) {
      out.filename = pdf.filename ?? 'invoice.pdf';
      if (pdf.content.length <= PDF_INLINE_MAX) out.pdfBase64 = pdf.content.toString('base64');
      else {
        const { signBlobToken } = await import('./webhooks.ts');
        const idx = (parsed?.attachments ?? []).indexOf(pdf);
        out.pdfUrl = `${config.publicUrl}/api/hooks/blob/${signBlobToken({ u: h.user_id, m: row.id, p: String(idx) }, now)}`;
      }
    }
    const body = JSON.stringify(out);
    return {
      url: h.url, method: 'POST', body: Buffer.from(body), headers: { ...base, ...auth, 'Content-Type': 'application/json' },
      summary: JSON.stringify({ ...out, pdfBase64: out.pdfBase64 ? `(${pdf!.content.length} bytes)` : undefined }),
    };
  }

  // tasks
  const title = (row.subject || '(no subject)').slice(0, 300);
  const link = messageLink(row.id);
  const due = await extractTaskDue(h.user_id, `${row.subject}\n${text}`);
  let payload: Record<string, unknown>, method = 'POST';
  const extra: Record<string, string> = {};
  if (kind === 'todoist') {
    payload = { content: title, description: link, ...(due ? { due_date: due } : {}), ...(cfg.projectId ? { project_id: cfg.projectId } : {}) };
  } else if (kind === 'vikunja') {
    method = 'PUT';
    payload = { title, description: link, ...(due ? { due_date: `${due}T00:00:00Z` } : {}) };
  } else {
    payload = { title, description: link, url: link, ...(due ? { dueDate: due } : {}), messageId: row.message_id };
  }
  const body = JSON.stringify(payload);
  if (kind === 'task-webhook' && secretSig) {
    Object.assign(extra, secretSig(String(Math.floor(now / 1000)), body));
  }
  return { url: h.url, method, body: Buffer.from(body), headers: { ...base, ...auth, ...extra, 'Content-Type': 'application/json' }, summary: body };
}
