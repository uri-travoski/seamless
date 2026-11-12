/** Personal API tokens (T5 F-37). Format `sk_sl_<prefix8>_<random32>`; only the sha256 is stored, the token is shown once. */
import crypto from 'node:crypto';
import { q, one, run } from '../db.ts';
import { sha256 } from '../crypto.ts';
import { apiLimiter } from '../security/ratelimit.ts';

export const SCOPES = ['mail:read', 'labels:write', 'mail:send', 'events:subscribe', 'contacts:read'] as const;
export type Scope = typeof SCOPES[number];

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export interface ApiToken { id: number; name: string; prefix: string; scopes: string[]; lastUsedAt: number | null; expiresAt: number | null; createdAt: number; revoked: boolean }
interface Row { id: number; user_id: number; name: string; prefix: string; scopes: string[]; last_used_at: number | string | null; expires_at: number | string | null; created_at: number | string; revoked_at: number | string | null }

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function rand(n: number): string {
  const b = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}
const toApi = (r: Row): ApiToken => ({
  id: r.id, name: r.name, prefix: `sk_sl_${r.prefix}`, scopes: r.scopes,
  lastUsedAt: r.last_used_at == null ? null : Number(r.last_used_at), expiresAt: r.expires_at == null ? null : Number(r.expires_at),
  createdAt: Number(r.created_at), revoked: r.revoked_at != null,
});

export async function listTokens(userId: number): Promise<ApiToken[]> {
  return (await q<Row>('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY id DESC', [userId])).map(toApi);
}

export async function createToken(userId: number, b: { name?: string; scopes?: string[]; expiresInDays?: number | null }, now = Date.now()): Promise<ApiToken & { token: string }> {
  const name = String(b.name ?? '').trim().slice(0, 80);
  if (!name) throw new ApiError(400, 'name required');
  const scopes = [...new Set((b.scopes ?? []).map(String))];
  if (scopes.length === 0) throw new ApiError(400, 'choose at least one scope');
  const bad = scopes.find((s) => !SCOPES.includes(s as Scope));
  if (bad) throw new ApiError(400, `unknown scope ${bad}`);
  const days = b.expiresInDays == null ? null : Number(b.expiresInDays);
  if (days != null && !(days > 0 && days <= 3650)) throw new ApiError(400, 'expiry must be 1–3650 days');
  const prefix = rand(8);
  const token = `sk_sl_${prefix}_${rand(32)}`;
  const r = await one<Row>(
    `INSERT INTO api_tokens(user_id, name, token_hash, prefix, scopes, expires_at, created_at) VALUES (?,?,?,?,?::text[],?,?) RETURNING *`,
    [userId, name, sha256(token), prefix, scopes, days ? now + days * 86_400_000 : null, now]);
  return { ...toApi(r!), token };
}

export async function revokeToken(userId: number, id: number, now = Date.now()): Promise<void> {
  const r = await one('SELECT 1 FROM api_tokens WHERE id = ? AND user_id = ?', [id, userId]);
  if (!r) throw new ApiError(404, 'not found');
  await run('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?', [now, id, userId]);
}

export interface TokenAuth { tokenId: number; userId: number; role: 'admin' | 'member'; scopes: string[] }

/** Resolve a `Authorization` header to a live token. Throws ApiError 401 (bad/revoked/expired) or 429 (rate limit). */
export async function authenticate(header: string | undefined, now = Date.now()): Promise<TokenAuth> {
  const m = /^Bearer\s+(sk_sl_[a-z0-9]{8}_[a-z0-9]{32})\s*$/.exec(header ?? '');
  if (!m) throw new ApiError(401, 'missing or malformed bearer token');
  const r = await one<Row & { role: 'admin' | 'member' }>(
    'SELECT t.*, u.role FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE u.disabled = false AND t.token_hash = ?', [sha256(m[1])]);
  if (!r || r.revoked_at != null) throw new ApiError(401, 'invalid or revoked token');
  if (r.expires_at != null && Number(r.expires_at) <= now) throw new ApiError(401, 'token expired');
  if (!apiLimiter.hit(`t${r.id}`, now)) throw new ApiError(429, 'rate limit: 600 requests per minute per token');
  await run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [now, r.id]);
  return { tokenId: r.id, userId: r.user_id, role: r.role, scopes: r.scopes };
}

/**
 * Audit hook: every v1 call ends up here (token id, route, HTTP status).
 * T6.1 (audit log) replaces this; for now it is a no-op by default (decision: not writing `api.call` events,
 * they would flood the long-poll feed).
 */
type CallHook = (tokenId: number, route: string, status: number) => void | Promise<void>;
let callHook: CallHook = () => {};
export function setApiCallHook(fn: CallHook): void { callHook = fn; }
export function onApiCall(tokenId: number, route: string, status: number): void {
  Promise.resolve(callHook(tokenId, route, status)).catch((e) => console.error('[api] call hook failed:', e?.message ?? e));
}
