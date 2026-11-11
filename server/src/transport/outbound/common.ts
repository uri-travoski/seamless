/** Shared bits for the HTTP API adapters: MIME → neutral message, and HTTP error mapping. */
import { simpleParser } from 'mailparser';
import { TransportError, type TransportTestStep } from '../types.ts';

export type FetchImpl = typeof fetch;
export interface Addr { email: string; name?: string }
export interface NeutralAttachment { filename: string; contentType: string; base64: string; cid?: string; inline: boolean }
export interface NeutralMessage {
  from: Addr; to: Addr[]; cc: Addr[]; bcc: Addr[]; replyTo?: Addr;
  subject: string; html?: string; text?: string;
  attachments: NeutralAttachment[];
  /** Message-ID, In-Reply-To, References and X-Seamless-* (what threading/tracking depend on). */
  headers: Record<string, string>;
}

function addrs(v: any): Addr[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.flatMap((a: any) => (a.value ?? []).map((x: any) => ({ email: String(x.address ?? ''), name: x.name || undefined })))
    .filter((a: Addr) => a.email);
}

export async function toNeutral(raw: Buffer, env: { from: string; to: string[] }): Promise<NeutralMessage> {
  const p = await simpleParser(raw);
  const to = addrs(p.to), cc = addrs(p.cc);
  const listed = new Set([...to, ...cc].map((a) => a.email.toLowerCase()));
  // the envelope recipients that are not in To/Cc were Bcc'd
  const bcc = env.to.filter((e) => !listed.has(e.toLowerCase())).map((email) => ({ email }));
  const from = addrs(p.from)[0] ?? { email: env.from };
  const headers: Record<string, string> = {};
  if (p.messageId) headers['Message-ID'] = p.messageId;
  if (p.inReplyTo) headers['In-Reply-To'] = p.inReplyTo;
  const refs = Array.isArray(p.references) ? p.references.join(' ') : p.references;
  if (refs) headers['References'] = refs;
  for (const [k, v] of p.headers) {
    if (k.startsWith('x-seamless-') && typeof v === 'string') headers['X-Seamless-' + k.slice('x-seamless-'.length).replace(/(^|-)([a-z])/g, (_m, a, b) => a + b.toUpperCase())] = v;
  }
  return {
    from, to, cc, bcc, replyTo: addrs(p.replyTo)[0],
    subject: p.subject ?? '',
    html: typeof p.html === 'string' ? p.html : undefined,
    text: p.text || undefined,
    attachments: p.attachments.map((a) => ({
      filename: a.filename ?? 'attachment', contentType: a.contentType || 'application/octet-stream',
      base64: a.content.toString('base64'), cid: a.cid ? a.cid.replace(/^<|>$/g, '') : undefined,
      inline: a.contentDisposition === 'inline' && !!a.cid,
    })),
    headers,
  };
}

/** 429 / 5xx are worth retrying (or falling back); other 4xx are the caller's problem. */
export function httpError(provider: string, status: number, body: string): TransportError {
  let msg = body;
  try {
    const j = JSON.parse(body);
    msg = j?.errors?.[0]?.message ?? j?.message ?? j?.Message ?? j?.error?.message ?? (typeof j?.error === 'string' ? j.error : body);
  } catch { /* plain text */ }
  msg = String(msg).slice(0, 300) || `HTTP ${status}`;
  return new TransportError(`${provider}: ${msg}`, { retryable: status === 429 || status >= 500, status });
}

/** fetch wrapper: network failures are retryable, non-2xx map through httpError. */
export async function call(provider: string, fetchImpl: FetchImpl, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try { res = await fetchImpl(url, init); }
  catch (err: any) { throw new TransportError(`${provider}: ${err?.message ?? 'network error'}`, { retryable: true }); }
  if (!res.ok) throw httpError(provider, res.status, await res.text().catch(() => ''));
  return res;
}

export async function simpleTest(name: string, fn: () => Promise<unknown>): Promise<{ ok: boolean; steps: TransportTestStep[] }> {
  try { await fn(); return { ok: true, steps: [{ name, ok: true }] }; }
  catch (err: any) { return { ok: false, steps: [{ name, ok: false, detail: err?.message ?? String(err) }] }; }
}

export function need(cfg: Record<string, any>, ...keys: string[]): void {
  for (const k of keys) if (!cfg[k]) throw new Error(`${k} is required`);
}
