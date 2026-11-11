/** Disposable addresses (F-25). All per-user. */
import type { FastifyInstance } from 'fastify';
import type { ApiDisposable } from '@seamless/shared';
import { uid } from './util.ts';
import {
  createDisposable, listDisposable, listDomains, getDisposable, updateDisposable, setStatus, stats, UNDO_WINDOW_MS,
  type DisposableRow, type Generator,
} from '../mail/disposable.ts';

export function view(r: DisposableRow): ApiDisposable {
  const disposedAt = r.disposed_at ? Number(r.disposed_at) : null;
  return {
    id: r.id, accountId: r.account_id, address: r.address, label: r.label, purpose: r.purpose, status: r.status,
    expiresAt: r.expires_at ? Number(r.expires_at) : null, notify: r.notify, receivedCount: r.received_count,
    droppedCount: r.dropped_count, lastReceivedAt: r.last_received_at ? Number(r.last_received_at) : null,
    lastSender: r.last_sender, signupDomain: r.signup_domain, leakDomains: r.leak_domains, disposedAt,
    createdAt: Number(r.created_at), canUndo: r.status === 'disposed' && !!disposedAt && Date.now() - disposedAt <= UNDO_WINDOW_MS,
  };
}

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

  for (const [action, status] of [['pause', 'paused'], ['resume', 'active'], ['dispose', 'disposed'], ['undispose', 'active']] as const) {
    app.post(`/api/disposable/:id/${action}`, async (req, reply) => {
      try {
        const row = await setStatus(uid(req), Number((req.params as any).id), status);
        return row ? view(row) : reply.code(404).send({ error: 'not found' });
      } catch (err: any) { return reply.code(409).send({ error: err?.message ?? 'failed' }); }
    });
  }

  /** Bulk dispose / pause / resume. Ids that aren't yours are ignored. */
  app.post('/api/disposable/bulk', async (req, reply) => {
    const b = (req.body ?? {}) as { ids?: number[]; action?: string };
    const status = ({ dispose: 'disposed', pause: 'paused', resume: 'active' } as Record<string, 'disposed' | 'paused' | 'active'>)[String(b.action)];
    if (!status || !Array.isArray(b.ids)) return reply.code(400).send({ error: 'ids and action (dispose|pause|resume) required' });
    let n = 0;
    for (const id of b.ids.slice(0, 500)) { if (await setStatus(uid(req), Number(id), status).catch(() => null)) n++; }
    return { updated: n };
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
