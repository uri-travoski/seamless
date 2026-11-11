/** Outbound transports (T3 F-22): CRUD, test, assign to a mailbox. Secrets are write-only. */
import type { FastifyInstance } from 'fastify';
import type { ApiTransport } from '@seamless/shared';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { encrypt, decrypt } from '../crypto.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';
import { buildTransport, knownKinds } from '../transport/registry.ts';
import { checkDomain, DEFAULT_SELECTORS } from '../transport/dns.ts';

const SECRET_RE = /pass|key|secret|token/i;

function toApi(r: any): ApiTransport {
  const cfg = JSON.parse(decrypt(r.config_enc)) as Record<string, unknown>;
  const pub: Record<string, unknown> = {};
  let hasSecret = false;
  for (const [k, v] of Object.entries(cfg)) {
    if (SECRET_RE.test(k)) { if (v) hasSecret = true; } else pub[k] = v;
  }
  return {
    id: r.id, kind: r.kind, name: r.name, config: pub, hasApiKey: hasSecret,
    fallbackId: r.fallback_id, dailyLimit: r.daily_limit, createdAt: Number(r.created_at),
  };
}

export function register(app: FastifyInstance): void {
  const changed = async (userId: number) => { await bumpState(); broadcast({ type: 'stateChange' }, userId); };
  const mine = (userId: number, id: number) => one<any>('SELECT * FROM transports WHERE id = ? AND user_id = ?', [id, userId]);

  app.get('/api/transports', async (req) =>
    (await q('SELECT * FROM transports WHERE user_id = ? ORDER BY lower(name)', [uid(req)])).map(toApi));

  const save = async (req: any, reply: any, id: number | null) => {
    const userId = uid(req);
    const b = (req.body ?? {}) as { kind?: string; name?: string; config?: Record<string, any>; fallbackId?: number | null; dailyLimit?: number | null };
    const existing = id === null ? null : await mine(userId, id);
    if (id !== null && !existing) return reply.code(404).send({ error: 'not found' });
    const kind = existing ? existing.kind : String(b.kind ?? '');
    if (!knownKinds().includes(kind)) return reply.code(400).send({ error: 'unknown transport kind' });
    const name = String(b.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });

    // blank secrets keep the stored value on edit
    const old = existing ? JSON.parse(decrypt(existing.config_enc)) as Record<string, any> : {};
    const cfg: Record<string, any> = { ...(b.config ?? {}) };
    for (const k of Object.keys(old)) if (SECRET_RE.test(k) && !cfg[k]) cfg[k] = old[k];
    try { buildTransport(kind, cfg); } catch (err: any) { return reply.code(400).send({ error: err.message }); }

    let fallbackId: number | null = b.fallbackId ?? null;
    if (fallbackId !== null) {
      if (fallbackId === id || !(await mine(userId, fallbackId))) return reply.code(400).send({ error: 'invalid fallback transport' });
    }
    const dailyLimit = b.dailyLimit && b.dailyLimit > 0 ? Math.floor(b.dailyLimit) : null;

    if (id === null) {
      const newId = await insertId(`INSERT INTO transports(user_id, kind, name, config_enc, fallback_id, daily_limit, created_at) VALUES (?,?,?,?,?,?,?)`,
        [userId, kind, name, encrypt(JSON.stringify(cfg)), fallbackId, dailyLimit, Date.now()]);
      await changed(userId);
      return { id: newId };
    }
    await run('UPDATE transports SET name=?, config_enc=?, fallback_id=?, daily_limit=? WHERE id=? AND user_id=?',
      [name, encrypt(JSON.stringify(cfg)), fallbackId, dailyLimit, id, userId]);
    await changed(userId);
    return { ok: true };
  };

  app.post('/api/transports', (req, reply) => save(req, reply, null));
  app.put('/api/transports/:id', (req, reply) => save(req, reply, Number((req.params as any).id)));

  app.delete('/api/transports/:id', async (req, reply) => {
    const userId = uid(req);
    const n = await run('DELETE FROM transports WHERE id = ? AND user_id = ?', [Number((req.params as any).id), userId]);
    if (!n) return reply.code(404).send({ error: 'not found' });
    await changed(userId);
    return { ok: true };
  });

  app.post('/api/transports/:id/test', async (req, reply) => {
    const row = await mine(uid(req), Number((req.params as any).id));
    if (!row) return reply.code(404).send({ error: 'not found' });
    try {
      return await buildTransport(row.kind, JSON.parse(decrypt(row.config_enc))).test();
    } catch (err: any) {
      return { ok: false, steps: [{ name: 'Set up', ok: false, detail: err?.message ?? String(err) }] };
    }
  });

  // DNS records for a sending domain (SPF/DKIM/DMARC checked, MX/MTA-STS/TLS-RPT informational)
  app.get('/api/dns-check', async (req, reply) => {
    const userId = uid(req);
    const qs = req.query as { domain?: string; transportId?: string; selectors?: string };
    const domain = String(qs.domain ?? '').trim().toLowerCase();
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) return reply.code(400).send({ error: 'enter a domain like example.com' });
    let kind: string | null = null;
    if (qs.transportId) {
      const t = await mine(userId, Number(qs.transportId));
      if (!t) return reply.code(404).send({ error: 'not found' });
      kind = t.kind;
    }
    const given = String(qs.selectors ?? '').split(',').map((s) => s.trim()).filter((s) => /^[a-z0-9._-]{1,63}$/i.test(s));
    const selectors = given.length ? given : (kind ? DEFAULT_SELECTORS[kind] ?? [] : []);
    return { domain, records: await checkDomain(domain, { transportKind: kind, dkimSelectors: selectors }) };
  });

  app.put('/api/accounts/:id/transport', async (req, reply) => {
    const userId = uid(req);
    const accountId = Number((req.params as any).id);
    const transportId = (req.body as any)?.transportId ?? null;
    if (!(await one('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?', [accountId, userId]))) return reply.code(404).send({ error: 'not found' });
    if (transportId !== null && !(await mine(userId, Number(transportId)))) return reply.code(400).send({ error: 'unknown transport' });
    await run('UPDATE accounts SET outbound_transport_id = ? WHERE id = ? AND user_id = ?', [transportId === null ? null : Number(transportId), accountId, userId]);
    await changed(userId);
    return { ok: true };
  });
}
