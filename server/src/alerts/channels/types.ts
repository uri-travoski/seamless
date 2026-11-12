/** Alert channel adapters (T8.9): each turns one alert message into a request to an outside service.
 *  Network access is injectable (`deps.http`, `deps.sendMail`) so tests talk to local fakes. */
import { safeRequest } from '../../integrations/ssrf.ts';

export type ChannelKind = 'email' | 'twilio' | 'sms_gateway' | 'telegram';

export interface AlertMessage {
  /** short headline, e.g. "Mailbox alice@x.com stopped syncing" */
  title: string;
  /** one or two sentences of detail */
  body: string;
  /** compact single-line form for SMS / chat */
  text: string;
  /** the mailbox the alert is about, so the email channel can avoid sending through it */
  excludeAccountId?: number | null;
}

export interface HttpRequest { method: string; headers?: Record<string, string>; body?: string }
export interface HttpResult { status: number; text: string }
export type HttpFn = (url: string, req: HttpRequest) => Promise<HttpResult>;

export interface ChannelDeps {
  http: HttpFn;
  /** the user the channel belongs to (email channel picks a healthy mailbox of theirs) */
  userId: number;
  sendMail?: (userId: number, to: string[], msg: AlertMessage, excludeAccountId: number | null) => Promise<void>;
}

export class ChannelError extends Error {
  /** host the SSRF guard refused, so the UI can offer "allow this host" */
  ssrfHost?: string;
  constructor(message: string, opts: { ssrfHost?: string } = {}) { super(message); this.name = 'ChannelError'; this.ssrfHost = opts.ssrfHost; }
}

export interface ChannelAdapter {
  kind: ChannelKind;
  label: string;
  /** names of config fields that are secrets: encrypted at rest, never returned by the API */
  secrets: string[];
  /** throws ChannelError with a user-facing message */
  validate(config: Record<string, any>): Record<string, any>;
  send(config: Record<string, any>, msg: AlertMessage, deps: ChannelDeps): Promise<void>;
  /** one-line description for lists (no secrets) */
  describe(config: Record<string, any>): string;
}

/** Default HTTP: SSRF-guarded, pinned to the vetted address; `allow` is the admin allow-list. */
export function makeHttp(allow: string[]): HttpFn {
  return async (url, req) => {
    const r = await safeRequest(url, { method: req.method, headers: req.headers, body: req.body, allow, timeoutMs: 10_000, maxResponseBytes: 16_384 });
    return { status: r.status, text: r.text };
  };
}

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** "+61 400 000 000" → "+61400000000"; null if it doesn't look like an international number. */
export function phone(v: unknown): string | null {
  const s = str(v).replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

export function phoneList(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : String(v ?? '').split(/[,;\n]/);
  const out: string[] = [];
  for (const p of parts) {
    if (!str(p)) continue;
    const n = phone(p);
    if (!n) throw new ChannelError(`"${str(p)}" is not a phone number in international format (like +61400000000)`);
    out.push(n);
  }
  return out;
}

export function apiBase(v: unknown, dflt: string): string {
  const s = str(v) || dflt;
  return s.replace(/\/+$/, '');
}

/** Wrap an HTTP failure from the SSRF guard into a ChannelError with the host. */
export function wrapNet(e: any, url: string): never {
  if (e instanceof ChannelError) throw e;
  const msg = String(e?.message ?? e);
  if (e?.name === 'SsrfError' || e?.constructor?.name === 'SsrfError') {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    throw new ChannelError(msg, { ssrfHost: host });
  }
  throw new ChannelError(`could not reach the service: ${msg}`);
}
