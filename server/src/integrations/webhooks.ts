/**
 * Outgoing webhooks (T5 F-36).
 *
 *   emitEvent ──► subscribeEvents ──► dispatch(): matching webhooks ──► webhook_deliveries row + `webhook.deliver` job
 *   job ──► deliverOnce(): build body, sign, POST via the SSRF guard ──► ok | failed (next attempt scheduled) | giving_up
 *
 * Retries are handled here, not by the job runner's 5-attempt cap: each failed attempt enqueues the next job itself.
 */
import crypto from 'node:crypto';
import type { ApiEmail } from '@seamless/shared';
import { ALL_EVENT_TYPES, type EventRow } from '../events/notifier.ts';
import { subscribeEvents, emitEvent } from '../events/emit.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { q, one, run, insertId } from '../db.ts';
import { encrypt, decrypt, randomToken, LOCAL_KEY } from '../crypto.ts';
import { config } from '../config.ts';
import { getMsgRow, queryEmails, rowToApi } from '../mail/store.ts';
import { getParsed } from '../mail/body.ts';
import { getBlob } from '../s3.ts';
import { safeRequest, SsrfError, validAllowEntry } from './ssrf.ts';
import { CONNECTORS, isConnector, connectorUrl, buildConnectorRequest, ConnectorSkip, type Connector, type ConnectorConfig } from './connectors.ts';

export class WebhookError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** Backoff after failed attempt n (1-based): 1 m, 5 m, 30 m, 2 h, 6 h, 12 h → then give up (7 attempts, ≈ 20.6 h). */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];
export const SNIPPET_MAX = 2048;
const REQUEST_BODY_KEEP = 16_384;
const BLOB_TTL_MS = 3_600_000;
export const INCLUDE_LEVELS = ['metadata', 'body', 'attachments', 'raw'] as const;
type Include = typeof INCLUDE_LEVELS[number];

/** Event types a webhook may subscribe to (webhook.failed is excluded so a broken hook can't feed itself). */
export const WEBHOOK_EVENT_TYPES = ALL_EVENT_TYPES.filter((t) => t !== 'webhook.failed');

interface HookRow {
  id: number; user_id: number; name: string; url: string; secret_enc: string; event_types: string[];
  filter_query: string | null; include: Include; active: boolean; created_at: number | string;
  connector: string | null; connector_config_enc: string | null;
}
interface DeliveryRow {
  id: number | string; webhook_id: number; event_id: number | string; status: string; http_status: number | null; attempts: number;
  next_attempt_at: number | string | null; last_error: string | null; request_body: string | null; response_snippet: string | null; created_at: number | string;
}

export interface ApiWebhook {
  id: number; name: string; url: string; eventTypes: string[]; filterQuery: string | null; include: Include; active: boolean; createdAt: number;
  lastStatus: string | null;
  connector: Connector | null; connectorConfig: { baseUrl: string; projectId: string; hasToken: boolean } | null;
}
export interface ApiDelivery {
  id: number; webhookId: number; eventId: number; eventType: string | null; status: string; httpStatus: number | null; attempts: number;
  nextAttemptAt: number | null; lastError: string | null; requestBody: string | null; responseSnippet: string | null; createdAt: number;
}

const hookToApi = (r: HookRow & { last_status?: string | null }): ApiWebhook => ({
  id: r.id, name: r.name, url: r.url, eventTypes: r.event_types, filterQuery: r.filter_query, include: r.include,
  active: r.active, createdAt: Number(r.created_at), lastStatus: r.last_status ?? null,
  connector: isConnector(r.connector) ? r.connector : null,
  connectorConfig: isConnector(r.connector) ? (() => { const c = readCfg(r.connector_config_enc); return { baseUrl: c.baseUrl ?? '', projectId: c.projectId ?? '', hasToken: !!c.token }; })() : null,
});

function readCfg(enc: string | null): ConnectorConfig {
  if (!enc) return {};
  try { return JSON.parse(decrypt(enc)) as ConnectorConfig; } catch { return {}; }
}

const newSecret = () => `whsec_${randomToken(24)}`;

// ---- CRUD ----

export async function listWebhooks(userId: number): Promise<ApiWebhook[]> {
  const rows = await q<HookRow & { last_status: string | null }>(
    `SELECT w.*, (SELECT d.status FROM webhook_deliveries d WHERE d.webhook_id = w.id ORDER BY d.id DESC LIMIT 1) AS last_status
     FROM webhooks w WHERE w.user_id = ? ORDER BY w.id`, [userId]);
  return rows.map(hookToApi);
}

export interface WebhookInput { connector?: string | null; connectorConfig?: ConnectorConfig; name?: string; url?: string; eventTypes?: string[]; filterQuery?: string | null; include?: string; active?: boolean }

type Valid = { name: string; url: string; eventTypes: string[]; filterQuery: string | null; include: Include; active: boolean; connector: Connector | null; cfgEnc: string | null };

function validate(b: WebhookInput, cur?: HookRow): Valid {
  const name = String(b.name ?? cur?.name ?? '').trim().slice(0, 80);
  if (!name) throw new WebhookError(400, 'name required');
  const kind = cur ? cur.connector : (b.connector ?? null);
  if (kind) {
    if (!isConnector(kind)) throw new WebhookError(400, `connector must be one of ${CONNECTORS.join(', ')}`);
    const old = readCfg(cur?.connector_config_enc ?? null);
    const inp = b.connectorConfig ?? {};
    const cfg: ConnectorConfig = {
      baseUrl: String(inp.baseUrl ?? old.baseUrl ?? '').trim(), projectId: String(inp.projectId ?? old.projectId ?? '').trim(),
      token: inp.token ? String(inp.token) : old.token,
    };
    if (kind !== 'todoist' && !cfg.baseUrl) throw new WebhookError(400, 'enter the base URL of the app');
    if (kind === 'vikunja' && !cfg.projectId) throw new WebhookError(400, 'enter the Vikunja project id');
    if (kind !== 'task-webhook' && !cfg.token) throw new WebhookError(400, 'enter the API token');
    const url = connectorUrl(kind, cfg);
    try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw 0; } catch { throw new WebhookError(400, 'enter a full URL, like https://example.com'); }
    // connectors run from the reading pane or a rule action; subscribing to events is optional
    return { name, url, eventTypes: [], filterQuery: null, include: 'metadata', active: b.active ?? cur?.active ?? true, connector: kind, cfgEnc: encrypt(JSON.stringify(cfg)) };
  }
  const url = String(b.url ?? cur?.url ?? '').trim();
  let u: URL;
  try { u = new URL(url); } catch { throw new WebhookError(400, 'enter a full URL, like https://example.com/hook'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new WebhookError(400, 'only http and https URLs are allowed');
  const eventTypes = (b.eventTypes ?? cur?.event_types ?? []).map(String);
  if (eventTypes.length === 0) throw new WebhookError(400, 'choose at least one event type');
  const bad = eventTypes.find((t) => !WEBHOOK_EVENT_TYPES.includes(t as any));
  if (bad) throw new WebhookError(400, `unknown event type ${bad}`);
  const include = String(b.include ?? cur?.include ?? 'metadata') as Include;
  if (!INCLUDE_LEVELS.includes(include)) throw new WebhookError(400, 'include must be metadata, body, attachments or raw');
  const fq = b.filterQuery !== undefined ? b.filterQuery : cur?.filter_query ?? null;
  const filterQuery = fq && String(fq).trim() ? String(fq).trim().slice(0, 500) : null;
  return { name, url, eventTypes: [...new Set(eventTypes)], filterQuery, include, active: b.active ?? cur?.active ?? true, connector: null, cfgEnc: null };
}

/** Returns the webhook and its signing secret — the only time the secret is visible. */
export async function createWebhook(userId: number, b: WebhookInput): Promise<ApiWebhook & { secret: string }> {
  const v = validate(b);
  const secret = newSecret();
  const id = await insertId(
    `INSERT INTO webhooks(user_id, name, url, secret_enc, event_types, filter_query, include, active, created_at, connector, connector_config_enc) VALUES (?,?,?,?,?::text[],?,?,?,?,?,?)`,
    [userId, v.name, v.url, encrypt(secret), v.eventTypes, v.filterQuery, v.include, v.active, Date.now(), v.connector, v.cfgEnc]);
  return { ...(await getWebhook(userId, id)), secret };
}

export async function getWebhook(userId: number, id: number): Promise<ApiWebhook> {
  const r = (await listWebhooks(userId)).find((w) => w.id === id);
  if (!r) throw new WebhookError(404, 'not found');
  return r;
}

export async function updateWebhook(userId: number, id: number, b: WebhookInput): Promise<ApiWebhook> {
  const cur = await one<HookRow>('SELECT * FROM webhooks WHERE id = ? AND user_id = ?', [id, userId]);
  if (!cur) throw new WebhookError(404, 'not found');
  const v = validate(b, cur);
  await run('UPDATE webhooks SET name=?, url=?, event_types=?::text[], filter_query=?, include=?, active=?, connector_config_enc=COALESCE(?, connector_config_enc) WHERE id=? AND user_id=?',
    [v.name, v.url, v.eventTypes, v.filterQuery, v.include, v.active, v.cfgEnc, id, userId]);
  return getWebhook(userId, id);
}

export async function deleteWebhook(userId: number, id: number): Promise<void> {
  if ((await run('DELETE FROM webhooks WHERE id = ? AND user_id = ?', [id, userId])) === 0) throw new WebhookError(404, 'not found');
}

export async function rotateSecret(userId: number, id: number): Promise<string> {
  const secret = newSecret();
  if ((await run('UPDATE webhooks SET secret_enc = ? WHERE id = ? AND user_id = ?', [encrypt(secret), id, userId])) === 0) throw new WebhookError(404, 'not found');
  return secret;
}

// ---- allow-list (admin) ----

export async function listAllowlist(): Promise<{ id: number; value: string; createdAt: number }[]> {
  return (await q<any>('SELECT id, cidr_or_host, created_at FROM webhook_allowlist ORDER BY id')).map((r) => ({ id: r.id, value: r.cidr_or_host, createdAt: Number(r.created_at) }));
}
export async function addAllow(adminId: number, raw: string): Promise<void> {
  const v = validAllowEntry(raw);
  if (!v) throw new WebhookError(400, 'enter a host name, an IP address or a CIDR range like 10.0.0.0/24');
  await run('INSERT INTO webhook_allowlist(cidr_or_host, created_by, created_at) VALUES (?,?,?) ON CONFLICT (cidr_or_host) DO NOTHING', [v, adminId, Date.now()]);
}
export async function removeAllow(id: number): Promise<void> {
  if ((await run('DELETE FROM webhook_allowlist WHERE id = ?', [id])) === 0) throw new WebhookError(404, 'not found');
}
async function allowValues(): Promise<string[]> { return (await q<{ cidr_or_host: string }>('SELECT cidr_or_host FROM webhook_allowlist')).map((r) => r.cidr_or_host); }

// ---- signed blob URLs ----

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
// 128-bit tag keeps the whole token under Fastify's 100-char path-param limit
const blobMac = (data: string) => crypto.createHmac('sha256', LOCAL_KEY).update(`hook-blob.${data}`).digest('base64url').slice(0, 22);

export interface BlobClaim { u: number; m: number; p: string; exp: number }   // user, message row, part index or "raw"

export function signBlobToken(claim: Omit<BlobClaim, 'exp'>, now = Date.now(), ttl = BLOB_TTL_MS): string {
  const data = b64u(JSON.stringify([claim.u, claim.m, claim.p, now + ttl]));
  return `${data}.${blobMac(data)}`;
}
export function verifyBlobToken(token: string, now = Date.now()): BlobClaim | null {
  const [data, mac] = String(token).split('.');
  if (!data || !mac) return null;
  const want = Buffer.from(blobMac(data)), got = Buffer.from(mac);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const [u, m, p, exp] = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as [number, number, string, number];
    return exp > now ? { u, m, p, exp } : null;
  } catch { return null; }
}
const blobUrl = (c: Omit<BlobClaim, 'exp'>, now: number) => `${config.publicUrl}/api/hooks/blob/${signBlobToken(c, now)}`;

/** Resolve a token to the bytes. The claim's user must still have access to the message. */
export async function readBlob(token: string, now = Date.now()): Promise<{ content: Buffer; contentType: string; filename: string } | null> {
  const c = verifyBlobToken(token, now);
  if (!c) return null;
  const row = await getMsgRow(c.u, `m${c.m}`).catch(() => undefined);
  if (!row?.s3_key) return null;
  if (c.p === 'raw') return { content: await getBlob(row.s3_key), contentType: 'message/rfc822', filename: `${c.m}.eml` };
  const att = (await getParsed(c.m, c.u))?.attachments[Number(c.p)];
  if (!att) return null;
  return { content: att.content, contentType: att.contentType || 'application/octet-stream', filename: att.filename ?? 'attachment' };
}

// ---- dispatch ----

export async function dispatch(ev: EventRow): Promise<number> {
  if (ev.type === 'webhook.failed') return 0;
  const hooks = await q<HookRow>('SELECT * FROM webhooks WHERE user_id = ? AND active = true AND ? = ANY(event_types)', [ev.user_id, ev.type]);
  let n = 0;
  for (const h of hooks) {
    if (h.filter_query) {
      // the filter is the search language; it only means something for events about a message
      if (ev.subject_type !== 'message' || !ev.subject_id) continue;
      const r = await queryEmails(ev.user_id, { filter: { text: h.filter_query, messageId: Number(ev.subject_id), scope: 'unified' }, position: 0, limit: 1 }).catch(() => null);
      if (!r || r.total === 0) continue;
    }
    await createDelivery(h.id, ev.id);
    n++;
  }
  return n;
}

async function createDelivery(webhookId: number, eventId: number, runAt = Date.now(), enqueue = true): Promise<number> {
  const id = await insertId('INSERT INTO webhook_deliveries(webhook_id, event_id, status, next_attempt_at, created_at) VALUES (?,?,?,?,?)',
    [webhookId, eventId, 'pending', runAt, Date.now()]);
  if (enqueue) await enqueueJob(null, 'webhook.deliver', runAt, { deliveryId: id });
  return id;
}

// ---- delivery ----

async function eventData(h: HookRow, ev: EventRow, now: number): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = { ...ev.payload };
  if (ev.subject_type) data.subject = { type: ev.subject_type, id: ev.subject_id };
  if (ev.subject_type !== 'message' || !ev.subject_id) return data;
  const row = await getMsgRow(h.user_id, `m${ev.subject_id}`).catch(() => undefined);
  if (!row) return data;
  const api: ApiEmail = await rowToApi(row, h.user_id);
  const labels = (await q<{ name: string }>('SELECT l.name FROM message_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.message_id = ?', [row.id])).map((l) => l.name);
  data.message = {
    id: api.id, threadId: api.threadId, accountId: api.accountId, messageId: api.messageId,
    from: api.from, to: api.to, cc: api.cc, subject: api.subject, date: api.receivedAt, size: api.size,
    hasAttachment: api.hasAttachment, labels, labelIds: api.labelIds, mailbox: api.mailboxRole,
  };
  const m = data.message as Record<string, unknown>;
  if (h.include === 'metadata') return data;
  const parsed = await getParsed(row.id, h.user_id);
  if (h.include === 'body' || h.include === 'attachments' || h.include === 'raw') {
    m.text = parsed?.text ?? ''; m.html = typeof parsed?.html === 'string' ? parsed.html : null;
  }
  if (h.include === 'attachments' || h.include === 'raw') {
    const atts = (parsed?.attachments ?? []);
    m.attachments = atts.map((a, i) => ({ filename: a.filename ?? 'attachment', contentType: a.contentType, size: a.size, url: blobUrl({ u: h.user_id, m: row.id, p: String(i) }, now) }));
  }
  if (h.include === 'raw') m.rawUrl = blobUrl({ u: h.user_id, m: row.id, p: 'raw' }, now);
  return data;
}

export const signature = (secret: string, ts: string, body: string) => `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

async function giveUp(h: HookRow, d: DeliveryRow, ev: EventRow | undefined, error: string, now: number) {
  await run("UPDATE webhook_deliveries SET status = 'giving_up', next_attempt_at = NULL WHERE id = ?", [d.id]);
  await emitEvent(h.user_id, 'webhook.failed', { type: 'webhook', id: h.id }, { webhookId: h.id, name: h.name, eventType: ev?.type, error, deliveryId: Number(d.id) }).catch(() => {});
}

/** One attempt. Returns the delivery's resulting status. */
export async function deliverOnce(deliveryId: number, now = Date.now()): Promise<string> {
  const d = await one<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE id = ?', [deliveryId]);
  if (!d || (d.status !== 'pending' && d.status !== 'failed')) return d?.status ?? 'gone';
  const h = await one<HookRow>('SELECT * FROM webhooks WHERE id = ?', [d.webhook_id]);
  if (!h) return 'gone';
  const ev = await one<EventRow>('SELECT * FROM events WHERE id = ?', [Number(d.event_id)]);
  const attempts = d.attempts + 1;
  if (!ev) { await run("UPDATE webhook_deliveries SET status='giving_up', last_error='event no longer exists', attempts=? WHERE id=?", [attempts, d.id]); return 'giving_up'; }
  if (!h.active) {
    await run("UPDATE webhook_deliveries SET status='failed', next_attempt_at=NULL, last_error='webhook is turned off', attempts=? WHERE id=?", [attempts, d.id]);
    return 'failed';
  }
  ev.created_at = Number(ev.created_at); ev.id = Number(ev.id);

  let body = '', httpStatus: number | null = null, snippet = '', error: string | null = null;
  try {
    let reqUrl = h.url, method = 'POST', headers: Record<string, string>, payload: string | Buffer;
    if (h.connector) {
      const secret = decrypt(h.secret_enc);
      const built = await buildConnectorRequest(h as any, readCfg(h.connector_config_enc), ev, (ts, b) => ({
        'X-Seamless-Event': ev.type, 'X-Seamless-Delivery': String(d.id), 'X-Seamless-Timestamp': ts, 'X-Seamless-Signature': signature(secret, ts, b),
      }), now);
      reqUrl = built.url; method = built.method; headers = { ...built.headers, 'X-Seamless-Delivery': String(d.id) }; payload = built.body; body = built.summary;
    } else {
      body = JSON.stringify({ id: `evt_${ev.id}`, type: ev.type, created_at: ev.created_at, data: await eventData(h, ev, now) });
      const ts = String(Math.floor(now / 1000));
      payload = body;
      headers = {
        'Content-Type': 'application/json', 'User-Agent': 'Seamless-Webhooks/1',
        'X-Seamless-Event': ev.type, 'X-Seamless-Delivery': String(d.id), 'X-Seamless-Timestamp': ts,
        'X-Seamless-Signature': signature(decrypt(h.secret_enc), ts, body),
      };
    }
    const res = await safeRequest(reqUrl, { method, body: payload, timeoutMs: 10_000, allow: await allowValues(), maxResponseBytes: SNIPPET_MAX, headers });
    httpStatus = res.status; snippet = res.text.slice(0, SNIPPET_MAX);
    if (res.status < 200 || res.status > 299) error = `HTTP ${res.status}`;
  } catch (e: any) {
    if (e instanceof ConnectorSkip) {
      await run("UPDATE webhook_deliveries SET status='giving_up', next_attempt_at=NULL, attempts=?, last_error=? WHERE id=?", [attempts, e.message, d.id]);
      return 'giving_up';
    }
    error = e instanceof SsrfError ? `blocked: ${e.message}` : String(e?.message ?? e).slice(0, 300);
  }
  const keep = body.length > REQUEST_BODY_KEEP ? `${body.slice(0, REQUEST_BODY_KEEP)}… (${body.length} bytes)` : body;

  if (!error) {
    await run("UPDATE webhook_deliveries SET status='ok', http_status=?, attempts=?, next_attempt_at=NULL, last_error=NULL, request_body=?, response_snippet=? WHERE id=?",
      [httpStatus, attempts, keep, snippet, d.id]);
    return 'ok';
  }
  await run('UPDATE webhook_deliveries SET http_status=?, attempts=?, last_error=?, request_body=?, response_snippet=? WHERE id=?',
    [httpStatus, attempts, error, keep, snippet, d.id]);
  const delay = RETRY_DELAYS_MS[attempts - 1];
  if (delay === undefined) { await giveUp(h, d, ev, error, now); return 'giving_up'; }
  const next = now + delay;
  await run("UPDATE webhook_deliveries SET status='failed', next_attempt_at=? WHERE id=?", [next, d.id]);
  await enqueueJob(null, 'webhook.deliver', next, { deliveryId: Number(d.id) });
  return 'failed';
}

/** Insert a synthetic event (not announced to the notifier) and deliver it right away. */
export async function sendTestEvent(userId: number, webhookId: number): Promise<ApiDelivery> {
  const h = await one<HookRow>('SELECT * FROM webhooks WHERE id = ? AND user_id = ?', [webhookId, userId]);
  if (!h) throw new WebhookError(404, 'not found');
  const evId = await insertId("INSERT INTO events(user_id, type, subject_type, subject_id, payload, created_at) VALUES (?,?,?,?,?::jsonb,?)",
    [userId, 'webhook.test', 'webhook', String(h.id), JSON.stringify({ message: 'This is a test event from Seamless.' }), Date.now()]);
  const id = await insertId("INSERT INTO webhook_deliveries(webhook_id, event_id, status, next_attempt_at, created_at) VALUES (?,?,?,?,?)",
    [h.id, evId, 'pending', Date.now(), Date.now()]);
  await deliverOnce(id);
  // a test must not leave a retry chain behind: one attempt, the log shows the result
  await run("UPDATE jobs SET status = 'cancelled' WHERE kind = 'webhook.deliver' AND status = 'pending' AND payload->>'deliveryId' = ?", [String(id)]);
  return (await listDeliveries(userId, webhookId)).find((x) => x.id === id)!;
}

export async function redeliver(userId: number, deliveryId: number): Promise<void> {
  const d = await one<{ id: number }>(
    'SELECT d.id FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ? AND w.user_id = ?', [deliveryId, userId]);
  if (!d) throw new WebhookError(404, 'not found');
  await run("UPDATE jobs SET status = 'cancelled' WHERE kind = 'webhook.deliver' AND status = 'pending' AND payload->>'deliveryId' = ?", [String(deliveryId)]);
  await run("UPDATE webhook_deliveries SET status='pending', attempts=0, next_attempt_at=?, last_error=NULL WHERE id=?", [Date.now(), deliveryId]);
  await enqueueJob(null, 'webhook.deliver', Date.now(), { deliveryId });
}

export async function listDeliveries(userId: number, webhookId: number, limit = 50): Promise<ApiDelivery[]> {
  const rows = await q<DeliveryRow & { event_type: string | null }>(
    `SELECT d.*, e.type AS event_type FROM webhook_deliveries d
     JOIN webhooks w ON w.id = d.webhook_id LEFT JOIN events e ON e.id = d.event_id
     WHERE d.webhook_id = ? AND w.user_id = ? ORDER BY d.id DESC LIMIT ?`, [webhookId, userId, Math.min(200, Math.max(1, limit))]);
  return rows.map((r) => ({
    id: Number(r.id), webhookId: r.webhook_id, eventId: Number(r.event_id), eventType: r.event_type, status: r.status, httpStatus: r.http_status,
    attempts: r.attempts, nextAttemptAt: r.next_attempt_at === null ? null : Number(r.next_attempt_at), lastError: r.last_error,
    requestBody: r.request_body, responseSnippet: r.response_snippet, createdAt: Number(r.created_at),
  }));
}

let inited = false;
/** Hook the dispatcher into the event bus and register the job. Idempotent. */
export function initWebhooks(): void {
  if (inited) return;
  inited = true;
  subscribeEvents(async (ev) => { await dispatch(ev); });
  registerJob('webhook.deliver', async (job) => { await deliverOnce(Number(job.payload.deliveryId)); });
}

// ---- connectors: reading-pane buttons and rule actions ----

async function connectorHooks(userId: number) {
  return q<HookRow>('SELECT * FROM webhooks WHERE user_id = ? AND connector IS NOT NULL AND active = true ORDER BY id', [userId]);
}
/** Pick the target: an explicit webhook id, else the first active one of that kind ("tasks" = any task connector). */
async function pickHook(userId: number, kind: 'dms' | 'bizbooks' | 'tasks' | 'webhook', webhookId?: number): Promise<HookRow | undefined> {
  const hooks = await connectorHooks(userId);
  if (webhookId) return hooks.find((h) => h.id === webhookId);
  return hooks.find((h) => kind === 'tasks' ? ['todoist', 'vikunja', 'task-webhook'].includes(h.connector!) : h.connector === kind);
}

/** Queue one delivery of `rowId` to a connector (or to a plain webhook, as a message.send event). Returns the delivery id. */
export async function queueConnectorSend(userId: number, kind: 'dms' | 'bizbooks' | 'tasks' | 'webhook', rowId: number, webhookId?: number, runNow = false): Promise<{ deliveryId: number; webhookId: number; name: string } | null> {
  let h: HookRow | undefined;
  if (kind === 'webhook') h = (await one<HookRow>('SELECT * FROM webhooks WHERE id = ? AND user_id = ? AND active = true', [webhookId ?? 0, userId])) ?? undefined;
  else h = await pickHook(userId, kind, webhookId);
  if (!h) return null;
  const evId = await insertId('INSERT INTO events(user_id, type, subject_type, subject_id, payload, created_at) VALUES (?,?,?,?,?::jsonb,?)',
    [userId, 'connector.send', 'message', String(rowId), JSON.stringify({ messageId: rowId }), Date.now()]);
  const deliveryId = await createDelivery(h.id, evId, Date.now(), !runNow);   // runNow: deliverOnce schedules its own retry
  if (runNow) await deliverOnce(deliveryId);
  return { deliveryId, webhookId: h.id, name: h.name };
}

/** Reading-pane button: send now and report the outcome for the toast. Retries stay queued if it failed. */
export async function sendMessageTo(userId: number, kind: 'dms' | 'bizbooks' | 'tasks', rowId: number, webhookId?: number): Promise<{ ok: boolean; status: string; message: string; name: string }> {
  if (!(await getMsgRow(userId, `m${rowId}`).catch(() => undefined))) throw new WebhookError(404, 'not found');
  const r = await queueConnectorSend(userId, kind, rowId, webhookId, true);
  if (!r) throw new WebhookError(400, `no ${kind === 'tasks' ? 'task app' : kind.toUpperCase()} connector is set up (Settings → Integrations)`);
  const d = (await listDeliveries(userId, r.webhookId, 5)).find((x) => x.id === r.deliveryId)!;
  const ok = d.status === 'ok';
  return { ok, status: d.status, name: r.name, message: ok ? `Sent to ${r.name}` : `${r.name}: ${d.lastError ?? d.status}${d.status === 'failed' ? ' (will retry)' : ''}` };
}

/** The connectors a user has set up, for showing the reading-pane buttons. */
export async function connectorSummary(userId: number): Promise<{ dms: boolean; bizbooks: boolean; tasks: boolean }> {
  const hooks = await connectorHooks(userId);
  return { dms: hooks.some((h) => h.connector === 'dms'), bizbooks: hooks.some((h) => h.connector === 'bizbooks'), tasks: hooks.some((h) => ['todoist', 'vikunja', 'task-webhook'].includes(h.connector!)) };
}
