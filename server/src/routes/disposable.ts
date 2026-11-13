/** Disposable addresses (F-25). All per-user. */
import type { FastifyInstance } from 'fastify';
import type { ApiDisposable } from '@seamless/shared';
import { uid } from './util.ts';
import {
  createDisposable, listDisposable, listDomains, getDisposable, updateDisposable, stopAddress, startAddress, keepMessage, keepAllFrom, stats,
  type DisposableRow, type Generator,
} from '../mail/disposable.ts';
import { getUserSetting, setUserSetting } from '../classify/settings.ts';

export function view(r: DisposableRow): ApiDisposable {
  return {
    id: r.id, accountId: r.account_id, address: r.address, label: r.label, purpose: r.purpose, status: r.status,
    expiresAt: r.expires_at ? Number(r.expires_at) : null, notify: r.notify, receivedCount: r.received_count,
    lastReceivedAt: r.last_received_at ? Number(r.last_received_at) : null,
    lastSender: r.last_sender, signupDomain: r.signup_domain, leakDomains: r.leak_domains,
    stoppedAt: r.stopped_at ? Number(r.stopped_at) : null, stoppedStored: r.stopped_stored, keepAll: r.keep_all,
    createdAt: Number(r.created_at),
  };
}

const SETTING_KEYS = { stopBinDays: 'stop_bin_days', stopCap: 'stop_cap', expireDays: 'disposable_expire_days', stoppedDeleteDays: 'stopped_delete_days' } as const;
const RANGES: Record<keyof typeof SETTING_KEYS, [number, number]> = { stopBinDays: [1, 365], stopCap: [1, 10000], expireDays: [1, 90], stoppedDeleteDays: [0, 3650] };

export function register(app: FastifyInstance): void {
  app.get('/api/disposable', async (req) => ({
    addresses: (await listDisposable(uid(req))).map(view),
    domains: await listDomains(uid(req)),
  }));

  app.post('/api/disposable', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const gen: Generator = ['random', 'words', 'prefix'].includes(b.generator) ? b.generator : 'random';
    try {
      const row = await createDisposable(uid(req), {
        domain: String(b.domain ?? ''), generator: gen, prefix: String(b.prefix ?? ''), address: b.address ? String(b.address) : undefined,
        label: String(b.label ?? ''), purpose: String(b.purpose ?? ''),
        expiresInDays: b.expiresInDays ? Number(b.expiresInDays) : null, notify: b.notify !== false,
      });
      return view(row);
    } catch (err: any) { return reply.code(400).send({ error: err?.message ?? 'could not create' }); }
  });

  app.put('/api/disposable/:id', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const row = await updateDisposable(uid(req), Number((req.params as any).id), {
      label: b.label !== undefined ? String(b.label) : undefined, purpose: b.purpose !== undefined ? String(b.purpose) : undefined,
      notify: b.notify !== undefined ? !!b.notify : undefined, expiresAt: b.expiresAt === undefined ? undefined : b.expiresAt === null ? null : Number(b.expiresAt),
    });
    return row ? view(row) : reply.code(404).send({ error: 'not found' });
  });

  app.post('/api/disposable/:id/stop', async (req, reply) => {
    const row = await stopAddress(uid(req), Number((req.params as any).id));
    return row ? view(row) : reply.code(404).send({ error: 'not found' });
  });
  app.post('/api/disposable/:id/start', async (req, reply) => {
    const row = await startAddress(uid(req), Number((req.params as any).id));
    return row ? view(row) : reply.code(404).send({ error: 'not found' });
  });
  // the old Pause / Dispose actions are gone (T10.2): Stop / Start replace them
  for (const old of ['pause', 'resume', 'dispose', 'undispose']) {
    app.post(`/api/disposable/:id/${old}`, async (_req, reply) => reply.code(410).send({ error: `"${old}" was removed: use stop / start` }));
  }

  /** Bulk stop / start. Ids that aren't yours are ignored. */
  app.post('/api/disposable/bulk', async (req, reply) => {
    const b = (req.body ?? {}) as { ids?: number[]; action?: string };
    const fn = b.action === 'stop' ? stopAddress : b.action === 'start' ? startAddress : null;
    if (!fn || !Array.isArray(b.ids)) return reply.code(400).send({ error: 'ids and action (stop|start) required' });
    let n = 0;
    for (const id of b.ids.slice(0, 500)) { if (await fn(uid(req), Number(id)).catch(() => null)) n++; }
    return { updated: n };
  });

  app.post('/api/disposable/:id/keep-all', async (req, reply) => {
    const n = await keepAllFrom(uid(req), Number((req.params as any).id));
    return n === null ? reply.code(404).send({ error: 'not found' }) : { kept: n };
  });
  app.post('/api/messages/:id/keep', async (req, reply) =>
    (await keepMessage(uid(req), Number((req.params as any).id))) ? { kept: 1 } : reply.code(404).send({ error: 'not found' }));
  app.post('/api/messages/keep', async (req, reply) => {
    const b = (req.body ?? {}) as { ids?: number[] };
    if (!Array.isArray(b.ids)) return reply.code(400).send({ error: 'ids required' });
    let n = 0;
    for (const id of b.ids.slice(0, 500)) { if (await keepMessage(uid(req), Number(id))) n++; }
    return { kept: n };
  });

  app.get('/api/disposable/settings', async (req) => {
    const out: Record<string, number> = {};
    for (const [k, key] of Object.entries(SETTING_KEYS)) out[k] = Number(await getUserSetting(uid(req), key));
    return out;
  });
  app.put('/api/disposable/settings', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    for (const [k, key] of Object.entries(SETTING_KEYS) as [keyof typeof SETTING_KEYS, string][]) {
      if (b[k] === undefined) continue;
      const n = Number(b[k]); const [lo, hi] = RANGES[k];
      if (!Number.isInteger(n) || n < lo || n > hi) return reply.code(400).send({ error: `${k} must be ${lo}–${hi}` });
      await setUserSetting(uid(req), key, String(n));
    }
    const out: Record<string, number> = {};
    for (const [k, key] of Object.entries(SETTING_KEYS)) out[k] = Number(await getUserSetting(uid(req), key));
    return out;
  });

  app.get('/api/disposable/:id/stats', async (req, reply) => {
    const s = await stats(uid(req), Number((req.params as any).id));
    return s ?? reply.code(404).send({ error: 'not found' });
  });

  app.get('/api/disposable/:id', async (req, reply) => {
    const r = await getDisposable(uid(req), Number((req.params as any).id));
    return r ? view(r) : reply.code(404).send({ error: 'not found' });
  });
}
