/** REST v1 (T5 F-37, bearer tokens only) and the token manager used by Settings → Integrations (cookie session). */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { q, one, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { getBlob } from '../s3.ts';
import { uid } from './util.ts';
import { ApiError, SCOPES, listTokens, createToken, revokeToken, type TokenAuth } from '../api/tokens.ts';
import { openapi } from '../api/openapi.ts';
import { queryEmails, getEmails, getMsgRow, moveEmail, setLabels } from '../mail/store.ts';
import { getEmailBody } from '../mail/body.ts';
import { sendEmail } from '../mail/send.ts';
import { Forbidden } from '../auth/access.ts';
import { listContacts } from '../contacts.ts';
import { subscribeEvents } from '../events/emit.ts';
import { WebhookError, createWebhook, deleteWebhook, listWebhooks } from '../integrations/webhooks.ts';
import type { ComposePayload, ApiAddress } from '@seamless/shared';

const auth = (req: FastifyRequest) => (req as any).apiAuth as TokenAuth;

// ---- long-poll wake-ups ----
const waiters = new Set<() => void>();
let wired = false;
function wire(): void {
  if (wired) return;
  wired = true;
  subscribeEvents(async () => { for (const w of [...waiters]) w(); });
}

const addrs = (v: unknown): ApiAddress[] => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
  .map((x: any) => (typeof x === 'string' ? { name: '', email: x.trim() } : { name: String(x?.name ?? ''), email: String(x?.email ?? '').trim() }))
  .filter((a) => a.email);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function register(app: FastifyInstance): void {
  wire();
  // Errors thrown by handlers → JSON with the right status
  const guard = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e: any) {
      if (e instanceof ApiError || e instanceof WebhookError) return reply.code(e.status).send({ error: e.message });
      if (e instanceof Forbidden) return reply.code(403).send({ error: e.message });
      throw e;
    }
  };
  const need = (req: FastifyRequest, scope: string) => {
    if (!auth(req).scopes.includes(scope)) throw new ApiError(403, `token lacks the ${scope} scope`);
  };
  const v1 = (method: 'get' | 'post' | 'delete', path: string, scope: string, fn: (req: any, reply: FastifyReply) => Promise<unknown>) =>
    app[method](`/api/v1${path}`, async (req, reply) => guard(reply, async () => { need(req, scope); return fn(req, reply); }));

  app.get('/api/v1/openapi.json', async () => openapi);

  v1('get', '/messages', 'mail:read', async (req) => {
    const qs = req.query as any;
    const limit = Math.min(200, Math.max(1, Number(qs.limit) || 50));
    const position = Math.max(0, Number(qs.cursor) || 0);
    const r = await queryEmails(uid(req), { filter: { text: qs.query ? String(qs.query) : undefined, scope: qs.scope ? String(qs.scope) as any : undefined }, position, limit });
    const items = await getEmails(uid(req), r.ids);
    const next = position + r.ids.length;
    return { items, total: r.total, nextCursor: next < r.total ? String(next) : null };
  });

  v1('get', '/messages/:id', 'mail:read', async (req, reply) => {
    const id = String(req.params.id);
    const row = await getMsgRow(uid(req), id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    const [email] = await getEmails(uid(req), [id]);
    const body = await getEmailBody(uid(req), id, false);
    return { ...email, text: body?.text ?? null, html: body?.html ?? null, attachments: body?.attachments ?? [] };
  });

  v1('get', '/messages/:id/raw', 'mail:read', async (req, reply) => {
    const row = await getMsgRow(uid(req), String(req.params.id));
    if (!row || !row.s3_key) return reply.code(404).send({ error: 'not found' });
    reply.header('Content-Type', 'message/rfc822');
    return reply.send(await getBlob(row.s3_key));
  });

  v1('post', '/messages/:id/labels', 'labels:write', async (req, reply) => {
    const id = String(req.params.id);
    const row = await getMsgRow(uid(req), id, 'own');
    if (!row) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as any;
    const cur = (await q<{ label_id: number }>('SELECT label_id FROM message_labels WHERE message_id = ?', [row.id])).map((l) => l.label_id);
    const add = (Array.isArray(b.add) ? b.add : []).map(Number);
    const remove = new Set((Array.isArray(b.remove) ? b.remove : []).map(Number));
    await setLabels(uid(req), id, [...new Set([...cur, ...add])].filter((l) => !remove.has(l)));
    await bumpState(); broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true, labelIds: (await q<{ label_id: number }>('SELECT label_id FROM message_labels WHERE message_id = ?', [row.id])).map((l) => l.label_id) };
  });

  v1('post', '/messages/:id/archive', 'labels:write', async (req, reply) => {
    const id = String(req.params.id);
    if (!(await getMsgRow(uid(req), id, 'write'))) return reply.code(404).send({ error: 'not found' });
    await moveEmail(uid(req), id, 'u:archive');
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  v1('post', '/send', 'mail:send', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const ident = await one<{ account_id: number; email: string }>('SELECT account_id, email FROM identities WHERE id = ? AND user_id = ?', [Number(b.identityId) || 0, uid(req)]);
    if (!ident) return reply.code(400).send({ error: 'unknown identityId' });
    const to = addrs(b.to), cc = addrs(b.cc), bcc = addrs(b.bcc);
    if (to.length + cc.length + bcc.length === 0) return reply.code(400).send({ error: 'add at least one recipient' });
    const html = typeof b.html === 'string' && b.html ? b.html : typeof b.text === 'string' && b.text ? `<div>${esc(b.text).replace(/\r?\n/g, '<br>')}</div>` : '';
    if (!html) return reply.code(400).send({ error: 'html or text required' });
    const payload: ComposePayload = {
      accountId: ident.account_id, fromEmail: ident.email, identityId: Number(b.identityId), to, cc, bcc,
      subject: String(b.subject ?? ''), html, attachmentIds: [], track: false,
    };
    try {
      // API sends skip the undo-send hold: straight to the identity's transport
      await sendEmail(uid(req), payload);
    } catch (e: any) {
      if (e?.statusCode === 403) return reply.code(403).send({ error: e.message });
      return reply.code(502).send({ error: e?.message ?? 'send failed' });
    }
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  v1('get', '/events', 'events:subscribe', async (req) => {
    const qs = req.query as any;
    const since = Math.max(0, Number(qs.since) || 0);
    const limit = Math.min(500, Math.max(1, Number(qs.limit) || 100));
    const waitMs = Math.min(30, Math.max(0, Number(qs.wait) || 0)) * 1000;
    const fetchNew = () => q<any>(
      `SELECT id, type, subject_type, subject_id, payload, created_at FROM events WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`, [uid(req), since, limit]);
    let rows = await fetchNew();
    if (rows.length === 0 && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(t); waiters.delete(done); resolve(); };
        const t = setTimeout(done, waitMs);
        waiters.add(done);
        req.raw.on('close', done);
      });
      rows = await fetchNew();
    }
    const items = rows.map((r) => ({ id: Number(r.id), type: r.type, subject: r.subject_type ? { type: r.subject_type, id: r.subject_id } : null, payload: r.payload, createdAt: Number(r.created_at) }));
    return { items, cursor: items.length ? items[items.length - 1].id : since };
  });

  v1('post', '/subscriptions', 'events:subscribe', async (req) => {
    const b = (req.body ?? {}) as any;
    return createWebhook(uid(req), { name: b.name || 'API subscription', url: b.url, eventTypes: b.eventTypes, filterQuery: b.filterQuery, include: b.include });
  });

  v1('delete', '/subscriptions/:id', 'events:subscribe', async (req, reply) => {
    const id = Number(req.params.id);
    const hook = (await listWebhooks(uid(req))).find((w) => w.id === id && !w.connector);
    if (!hook) return reply.code(404).send({ error: 'not found' });
    await deleteWebhook(uid(req), id);
    return { ok: true };
  });

  v1('get', '/contacts', 'contacts:read', async (req) => ({
    items: (await listContacts(uid(req))).map((c) => ({ id: c.id, displayName: c.display_name, org: c.org, emails: c.emails, sentCount: c.sent_count, receivedCount: c.received_count })),
  }));

  // ---- token manager (cookie session; v1 itself never accepts cookies) ----
  app.get('/api/api-tokens', async (req) => ({ items: await listTokens(uid(req)), scopes: SCOPES }));
  app.post('/api/api-tokens', async (req, reply) => guard(reply, () => createToken(uid(req), (req.body ?? {}) as any)));
  app.delete('/api/api-tokens/:id', async (req, reply) => guard(reply, async () => { await revokeToken(uid(req), Number((req.params as any).id)); return { ok: true }; }));
}
