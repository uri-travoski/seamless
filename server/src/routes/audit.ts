/** Settings → Audit log: list (admin: everyone, member: own), CSV export (itself audited). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { uid, isAdmin } from './util.ts';
import { audit, queryAudit, auditCsv, retentionDays, type AuditFilter } from '../audit/log.ts';
import { getSetting, setSetting } from '../db.ts';

function filterOf(req: FastifyRequest): AuditFilter {
  const qs = req.query as Record<string, string | undefined>;
  const num = (v?: string) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    actor: num(qs.actor), action: qs.action || undefined, target: qs.target || undefined,
    from: num(qs.from), to: num(qs.to), limit: num(qs.limit), offset: num(qs.offset),
  };
}

export function register(app: FastifyInstance): void {
  app.get('/api/audit', async (req) => {
    const viewer = { userId: uid(req), admin: isAdmin(req) };
    const f = filterOf(req);
    const r = await queryAudit(viewer, { ...f, limit: f.limit ?? 50 });
    return { ...r, scope: viewer.admin ? 'all' : 'own', retentionDays: await retentionDays() };
  });

  app.get('/api/audit/export.csv', async (req, reply) => {
    const viewer = { userId: uid(req), admin: isAdmin(req) };
    const f = filterOf(req);
    const r = await queryAudit(viewer, { ...f, limit: 5000, offset: 0 });
    await audit(req, 'audit.export', { type: 'audit_log' }, { rows: r.items.length, filter: f });
    return reply.header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="audit-log.csv"').send(auditCsv(r.items));
  });

  app.put('/api/audit/retention', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admins only' });
    const days = Math.floor(Number((req.body as any)?.days));
    if (!(days >= 1 && days <= 36500)) return reply.code(400).send({ error: 'days must be between 1 and 36500' });
    const before = await getSetting('audit_retention_days');
    await setSetting('audit_retention_days', String(days));
    await audit(req, 'audit.retention_change', { type: 'instance' }, { from: before, to: days });
    return { retentionDays: days };
  });
}
