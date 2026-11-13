/**
 * Firebase Cloud Messaging, HTTP v1 (T9.1). No SDK: a service-account JSON signs a short JWT (RS256, Node crypto),
 * Google's token endpoint turns it into an OAuth2 access token (cached ~55 min), and messages go to
 * https://fcm.googleapis.com/v1/projects/<id>/messages:send. `fetch` is injectable so tests use a local fake.
 *
 * The service-account JSON is entered by an admin (Settings → Integrations → Mobile push) and stored encrypted;
 * it is never returned by the API.
 */
import crypto from 'node:crypto';
import { getSetting, setSetting, run } from '../db.ts';
import { encrypt, decrypt } from '../crypto.ts';

const SETTING = 'fcm_service_account';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_TTL_MS = 55 * 60_000;

export interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }
type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init) as any;
let nowImpl: () => number = () => Date.now();
let cache: { token: string; expiresAt: number; key: string } | null = null;

/** Tests only: swap the network and the clock. */
export function setFcmTestHooks(h: { fetch?: FetchLike | null; now?: (() => number) | null }): void {
  fetchImpl = h.fetch ?? ((url, init) => fetch(url, init) as any);
  nowImpl = h.now ?? (() => Date.now());
  cache = null;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Parse + sanity-check a service-account JSON text. Throws a plain-words Error. */
export function parseServiceAccount(text: string): ServiceAccount {
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error('That is not valid JSON. Paste the whole file you downloaded from Firebase.'); }
  if (!j || typeof j !== 'object' || j.type !== 'service_account' || !j.project_id || !j.client_email || !j.private_key) {
    throw new Error('This does not look like a Firebase service-account key (it needs project_id, client_email and private_key).');
  }
  try { crypto.createPrivateKey(j.private_key); } catch { throw new Error('The private key in this file could not be read.'); }
  return { project_id: String(j.project_id), client_email: String(j.client_email), private_key: String(j.private_key), token_uri: j.token_uri ? String(j.token_uri) : undefined };
}

export async function saveServiceAccount(text: string): Promise<ServiceAccount> {
  const sa = parseServiceAccount(text);
  await setSetting(SETTING, encrypt(JSON.stringify(sa)));
  cache = null;
  return sa;
}

export async function clearServiceAccount(): Promise<void> {
  await run('DELETE FROM settings WHERE key = ?', [SETTING]);
  cache = null;
}

export async function loadServiceAccount(): Promise<ServiceAccount | null> {
  const raw = await getSetting(SETTING);
  if (!raw) return null;
  try { return JSON.parse(decrypt(raw)) as ServiceAccount; } catch { return null; }
}

/** What the UI may see: never the key. */
export async function fcmStatus(): Promise<{ configured: boolean; projectId: string | null; clientEmail: string | null }> {
  const sa = await loadServiceAccount();
  return { configured: !!sa, projectId: sa?.project_id ?? null, clientEmail: sa?.client_email ?? null };
}

export async function pushConfigured(): Promise<boolean> { return !!(await loadServiceAccount()); }

/** The signed JWT assertion Google exchanges for an access token. */
export function buildAssertion(sa: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), sa.private_key);
  return `${head}.${body}.${b64url(sig)}`;
}

export async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = nowImpl();
  const key = `${sa.client_email}|${sa.project_id}`;
  if (cache && cache.key === key && cache.expiresAt > now) return cache.token;
  const res = await fetchImpl(sa.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: buildAssertion(sa, now) }).toString(),
  });
  if (!res.ok) throw new Error(`Google refused the service-account key (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = await res.json();
  if (!j?.access_token) throw new Error('Google did not return an access token');
  cache = { token: String(j.access_token), expiresAt: now + Math.min(TOKEN_TTL_MS, Math.max(60_000, (Number(j.expires_in) || 3600) * 1000 - 300_000)), key };
  return cache.token;
}

export type FcmResult = 'ok' | 'unregistered';

/** Send one data-only message to one device token. 'unregistered' means delete the token. Throws on other failures. */
export async function sendFcm(token: string, data: Record<string, string>, opts: { collapseKey?: string; sa?: ServiceAccount } = {}): Promise<FcmResult> {
  const sa = opts.sa ?? (await loadServiceAccount());
  if (!sa) throw new Error('Mobile push is not set up');
  const send = async (accessToken: string) => fetchImpl(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ...(opts.collapseKey ? { collapse_key: opts.collapseKey } : {}) } } }),
  });
  let res = await send(await getAccessToken(sa));
  if (res.status === 401) { cache = null; res = await send(await getAccessToken(sa)); }
  if (res.ok) return 'ok';
  const text = await res.text().catch(() => '');
  let status = '';
  try { status = JSON.parse(text)?.error?.status ?? ''; } catch { /* not JSON */ }
  if (res.status === 404 || status === 'NOT_FOUND' || status === 'UNREGISTERED' || /UNREGISTERED/.test(text)) return 'unregistered';
  throw new Error(`FCM error ${res.status}: ${text.slice(0, 200)}`);
}
