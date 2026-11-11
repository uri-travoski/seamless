/**
 * Seamless inbound Email Worker (Cloudflare Email Routing -> Seamless push endpoint).
 * Pure pieces are exported so they can be tested without Miniflare.
 */
export interface InboundMessage {
  from: string;
  to: string;
  raw: ReadableStream<Uint8Array> | Uint8Array;
  rawSize: number;
  forward(to: string): Promise<void>;
  setReject(reason: string): void;
}
export interface Env {
  SEAMLESS_URL: string;                 // e.g. https://mail.example.com
  ROUTES: string;                       // JSON: {"domain.com":"<token>", "addr@x.com":"<token>"}
  SECRETS: string;                      // JSON: {"<token>":"<secret>"}  (use `wrangler secret put SECRETS`)
  FALLBACK_ADDRESS?: string;
  MAX_BYTES?: string;
  SPOOL?: { put(key: string, value: Uint8Array): Promise<unknown> };
}
export type FetchImpl = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => Promise<{ status: number }>;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Exact address wins over domain. Returns the inbox token or null. */
export function routeFor(to: string, routesJson: string): string | null {
  let routes: Record<string, string>;
  try { routes = JSON.parse(routesJson); } catch { return null; }
  const addr = to.trim().toLowerCase();
  const domain = addr.slice(addr.lastIndexOf('@') + 1);
  return routes[addr] ?? routes[domain] ?? null;
}

/** `sha256=hex(HMAC(secret, timestamp + "." + body))` — what the Seamless endpoint verifies. */
export async function sign(secret: string, timestamp: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const msg = new Uint8Array(enc.encode(timestamp + '.').length + body.length);
  msg.set(enc.encode(timestamp + '.'), 0);
  msg.set(body, enc.encode(timestamp + '.').length);
  return 'sha256=' + hex(await crypto.subtle.sign('HMAC', key, msg));
}

export async function readRaw(raw: InboundMessage['raw']): Promise<Uint8Array> {
  if (raw instanceof Uint8Array) return raw;
  return new Uint8Array(await new Response(raw as ReadableStream).arrayBuffer());
}

export interface DeliverOpts { fetchImpl?: FetchImpl; delaysMs?: number[]; now?: () => number; sleep?: (ms: number) => Promise<void> }

/** POST with retries (1 s, 4 s, 16 s) on network errors and 5xx/429. Returns true when Seamless accepted it (2xx). */
export async function deliver(
  env: Env, token: string, rcpt: string, body: Uint8Array, opts: DeliverOpts = {},
): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, { ...init, body: init.body as unknown as BodyInit }));
  const delays = opts.delaysMs ?? [1000, 4000, 16000];
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const secret = (JSON.parse(env.SECRETS || '{}') as Record<string, string>)[token];
  if (!secret) return false;
  const url = `${env.SEAMLESS_URL.replace(/\/$/, '')}/api/ingest/${token}`;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const ts = String((opts.now ?? Date.now)());
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'message/rfc822', 'x-seamless-timestamp': ts, 'x-seamless-rcpt': rcpt,
          'x-seamless-signature': await sign(secret, ts, body),
        },
        body,
      });
      if (res.status >= 200 && res.status < 300) return true;
      if (res.status < 500 && res.status !== 429) return false; // 4xx: retrying won't help
    } catch { /* network error: retry */ }
    if (attempt < delays.length) await sleep(delays[attempt]);
  }
  return false;
}

export async function handleEmail(message: InboundMessage, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }, opts: DeliverOpts = {}): Promise<void> {
  const max = Number(env.MAX_BYTES) || 25 * 1024 * 1024;
  if (message.rawSize > max) { message.setReject('Message too large'); return; }
  const token = routeFor(message.to, env.ROUTES);
  if (!token) { message.setReject('Unknown recipient'); return; }
  const body = await readRaw(message.raw);
  if (env.SPOOL) {
    const put = env.SPOOL.put(`${Date.now()}-${token}-${Math.random().toString(36).slice(2)}.eml`, body);
    if (ctx) ctx.waitUntil(put); else await put;
  }
  const ok = await deliver(env, token, message.to, body, opts);
  if (!ok && env.FALLBACK_ADDRESS) await message.forward(env.FALLBACK_ADDRESS);
  else if (!ok) throw new Error('Seamless did not accept the message'); // Cloudflare will bounce/retry per its rules
}

export default {
  async email(message: InboundMessage, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    await handleEmail(message, env, ctx);
  },
};
