/** Critical alerts (T8.9): channels (email / Twilio / phone gateway / Telegram), the alert list, thresholds, test buttons. */
import type { FastifyInstance } from 'fastify';
import { q, one, run } from '../db.ts';
import { broadcast } from '../ws.ts';
import { uid, isAdmin } from './util.ts';
import { ChannelError, CHANNEL_KINDS, ADAPTERS, GATEWAY_PRESETS, findChats, makeHttp } from '../alerts/channels/index.ts';
import { listChannels, getOwnChannel, createChannel, updateChannel, deleteChannel, toApi, hasVerifiedChannel, type ChannelRow } from '../alerts/store.ts';
import {
  getAlertSettings, setAlertSettings, sendThroughChannel, raiseTestAlert, type AlertRow, type Delivery,
} from '../alerts/engine.ts';

export interface ApiAlert {
  id: number; kind: string; title: string; body: string; link: string | null; accountId: number | null;
  state: 'open' | 'resolved'; read: boolean; openedAt: number; resolvedAt: number | null;
  sendCount: number; lastSentAt: number | null; deliveries: (Delivery & { channelId: number })[];
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
function toApiAlert(a: AlertRow): ApiAlert {
  return {
    id: Number(a.id), kind: a.kind, title: a.title, body: a.body, link: a.link, accountId: a.account_id, state: a.state, read: a.read_at !== null,
    openedAt: Number(a.opened_at), resolvedAt: n(a.resolved_at), sendCount: a.send_count, lastSentAt: n(a.last_sent_at),
    deliveries: Object.entries(a.deliveries ?? {}).map(([id, d]) => ({ channelId: Number(id), ...d })),
  };
}

const idList = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((x) => Number.isFinite(x)) : []);

/** Unread alerts (open ones, and fixed ones nobody has read yet), newest first. */
export async function activeAlerts(userId: number): Promise<ApiAlert[]> {
  return (await q<AlertRow>('SELECT * FROM alerts WHERE user_id = ? AND read_at IS NULL ORDER BY (state = \'open\') DESC, opened_at DESC, id DESC LIMIT 100', [userId])).map(toApiAlert);
}

export async function alertStatus(userId: number): Promise<{ active: number; open: number; hasChannel: boolean }> {
  const c = await one<{ active: string; open: string }>(`SELECT COUNT(*) AS active, COUNT(*) FILTER (WHERE state = 'open') AS open FROM alerts WHERE user_id = ? AND read_at IS NULL`, [userId]);
  return { active: Number(c?.active ?? 0), open: Number(c?.open ?? 0), hasChannel: await hasVerifiedChannel(userId) };
}

export function register(app: FastifyInstance): void {
  const guard = async (reply: any, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e: any) {
      if (e instanceof ChannelError) return reply.code(400).send({ error: e.message, ssrfHost: e.ssrfHost ?? null });
      throw e;
    }
  };

  // ---- the alerts themselves ----
  app.get('/api/alerts', async (req) => {
    const all = (req.query as any)?.all === '1';
    const items = all
      ? (await q<AlertRow>('SELECT * FROM alerts WHERE user_id = ? ORDER BY id DESC LIMIT 100', [uid(req)])).map(toApiAlert)
      : await activeAlerts(uid(req));
    return { items, status: await alertStatus(uid(req)) };
  });

  app.get('/api/alerts/summary', async (req) => {
    const items = await activeAlerts(uid(req));
    return { items, status: await alertStatus(uid(req)) };
  });

  /** Each alert needs its own "Mark read" — there is deliberately no "all". */
  app.post('/api/alerts/read', async (req) => {
    const ids = idList((req.body as any)?.ids);
    if (ids.length) await run('UPDATE alerts SET read_at = ? WHERE user_id = ? AND id = ANY(?::int[]) AND read_at IS NULL', [Date.now(), uid(req), ids]);
    broadcast({ type: 'notifications' }, uid(req));
    return { ok: true };
  });

  app.post('/api/alerts/test', async (req, reply) => guard(reply, async () => {
    const a = await raiseTestAlert(uid(req));
    return { alert: toApiAlert(a) };
  }));

  // ---- thresholds (instance-wide; admin edits) ----
  app.get('/api/alerts/settings', async () => ({ settings: await getAlertSettings() }));
  app.put('/api/alerts/settings', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const s = await setAlertSettings((req.body ?? {}) as any);
    return { settings: s };
  });

  // ---- channels ----
  app.get('/api/alert-channels', async (req) => {
    const rows = await listChannels(uid(req));
    return {
      items: rows.map((r) => toApi(r, uid(req))),
      kinds: CHANNEL_KINDS.map((k) => ({ kind: k, label: ADAPTERS[k].label, secrets: ADAPTERS[k].secrets })),
      presets: GATEWAY_PRESETS,
      hasVerified: await hasVerifiedChannel(uid(req)),
    };
  });

  app.post('/api/alert-channels', async (req, reply) => guard(reply, async () => {
    const row = await createChannel(uid(req), isAdmin(req), (req.body ?? {}) as any);
    return toApi(row, uid(req));
  }));

  app.put('/api/alert-channels/:id', async (req, reply) => guard(reply, async () => {
    const row = await updateChannel(uid(req), Number((req.params as any).id), (req.body ?? {}) as any);
    if (!row) return reply.code(404).send({ error: 'not found' });
    return toApi(row, uid(req));
  }));

  app.delete('/api/alert-channels/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!(await deleteChannel(uid(req), id))) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  /** Send a test message. Success = the channel counts as "set up" (verified_at). */
  app.post('/api/alert-channels/:id/test', async (req, reply) => {
    const row = await getOwnChannel(uid(req), Number((req.params as any).id));
    if (!row) return reply.code(404).send({ error: 'not found' });
    const text = '[Seamless] Test message — if you can read this, critical alerts will reach you here.';
    try {
      await sendThroughChannel(row, { title: 'Test message', body: 'If you can read this, critical alerts will reach you here.', text, excludeAccountId: null });
      await run('UPDATE alert_channels SET verified_at = ? WHERE id = ?', [Date.now(), row.id]);
      const fresh = (await getOwnChannel(uid(req), row.id))!;
      broadcast({ type: 'stateChange' }, uid(req));
      return { ok: true, channel: toApi(fresh, uid(req)) };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e), ssrfHost: e?.ssrfHost ?? null, channel: toApi((await getOwnChannel(uid(req), row.id)) as ChannelRow, uid(req)) };
    }
  });

  /** Telegram helper: after messaging the bot, list the chats it can see. Uses the typed token or a saved channel's. */
  app.post('/api/alert-channels/telegram/find-chat', async (req, reply) => guard(reply, async () => {
    const b = (req.body ?? {}) as { botToken?: string; channelId?: number };
    let token = String(b.botToken ?? '').trim();
    if (!token && b.channelId) {
      const row = await getOwnChannel(uid(req), Number(b.channelId));
      if (row?.kind === 'telegram') token = (await import('../alerts/store.ts')).readConfig(row).botToken ?? '';
    }
    const allow = (await q<{ cidr_or_host: string }>('SELECT cidr_or_host FROM webhook_allowlist')).map((r) => r.cidr_or_host);
    const http = (await import('../alerts/engine.ts')).testHttp() ?? makeHttp(allow);
    return { chats: await findChats(token, http) };
  }));
}
