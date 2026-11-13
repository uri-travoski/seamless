/** Settings → Storage → Database maintenance (T10.3). Admin only. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { uid, isAdmin } from './util.ts';
import { audit } from '../audit/log.ts';
import { TASKS, taskById, indexStats, fullVacuumCandidates } from '../maintenance/tasks.ts';
import {
  allSettings, lastRuns, nextRunAt, updateTaskSettings, runTask, runSafeCleanups, queryLog, logCsv, databaseOverview, type LogRow, type LogFilter,
} from '../maintenance/engine.ts';

const num = (v: unknown) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

function logFilter(req: FastifyRequest): LogFilter {
  const qs = req.query as Record<string, string | undefined>;
  return { task: qs.task || undefined, trigger: qs.trigger || undefined, status: qs.status || undefined, from: num(qs.from), to: num(qs.to), limit: num(qs.limit), offset: num(qs.offset), dryRun: qs.dryRun === 'true' ? true : qs.dryRun === 'false' ? false : undefined };
}

export function register(app: FastifyInstance): void {
  // every route below is for administrators
  const admin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (isAdmin(req)) return true;
    reply.code(403).send({ error: 'admins only' });
    return false;
  };

  app.get('/api/maintenance', async (req, reply) => {
    if (!admin(req, reply)) return;
    const settings = await allSettings();
    const last = await lastRuns();
    const tasks = [];
    for (const t of TASKS) {
      const s = settings[t.id];
      tasks.push({
        id: t.id, name: t.name, removes: t.removes, scheduleText: t.scheduleText, manualOnly: !!t.manualOnly, safe: t.safe,
        retentionLabel: t.retentionLabel, defaultIntervalHours: t.defaultIntervalHours, defaultRetentionDays: t.defaultRetentionDays,
        enabled: s.enabled, intervalHours: s.intervalHours, retentionDays: s.retentionDays, autoDelete: s.autoDelete,
        lastRun: last[t.id] ?? null, nextRunAt: t.manualOnly || !s.enabled ? null : await nextRunAt(t.id),
      });
    }
    const indexes = (await indexStats()).filter((i) => i.bloatPct > 40);
    return { database: await databaseOverview(), tasks, bloatedIndexes: indexes, fullVacuumTables: await fullVacuumCandidates() };
  });

  app.put('/api/maintenance/tasks/:id', async (req, reply) => {
    if (!admin(req, reply)) return;
    const id = String((req.params as any).id);
    if (!taskById(id)) return reply.code(404).send({ error: 'unknown task' });
    const b = (req.body ?? {}) as Record<string, any>;
    try {
      const s = await updateTaskSettings(id, { enabled: b.enabled, intervalHours: b.intervalHours, retentionDays: b.retentionDays, autoDelete: b.autoDelete });
      await audit(req, 'maintenance.settings', { type: 'maintenance', id }, { ...s });
      return { settings: s, nextRunAt: await nextRunAt(id) };
    } catch (e: any) { return reply.code(400).send({ error: e.message }); }
  });

  /** Preview = dry run: nothing changes, the numbers go in the log. */
  app.post('/api/maintenance/tasks/:id/preview', async (req, reply) => {
    if (!admin(req, reply)) return;
    const id = String((req.params as any).id);
    if (!taskById(id)) return reply.code(404).send({ error: 'unknown task' });
    return runTask(id, { trigger: 'manual', userId: uid(req), dryRun: true, opts: ((req.body ?? {}) as any).options ?? {} });
  });

  app.post('/api/maintenance/tasks/:id/run', async (req, reply) => {
    if (!admin(req, reply)) return;
    const id = String((req.params as any).id);
    const def = taskById(id);
    if (!def) return reply.code(404).send({ error: 'unknown task' });
    const b = (req.body ?? {}) as Record<string, any>;
    // the two destructive-by-design tasks need an explicit confirmation in the request
    if ((id === 'vacuum_full' || id === 'orphan_files') && b.confirm !== true) {
      return reply.code(400).send({ error: id === 'vacuum_full' ? 'VACUUM FULL locks tables while it runs: send confirm: true' : 'Deleting orphaned files needs confirm: true' });
    }
    const log = await runTask(id, { trigger: 'manual', userId: uid(req), opts: { tables: b.tables, keys: b.keys } });
    await audit(req, 'maintenance.run', { type: 'maintenance', id }, { status: log.status, rows: log.rowsRemoved, bytes: log.bytesFreed });
    return log;
  });

  app.post('/api/maintenance/run-safe', async (req, reply) => {
    if (!admin(req, reply)) return;
    const logs: LogRow[] = await runSafeCleanups(uid(req));
    await audit(req, 'maintenance.run_all', { type: 'maintenance' }, { tasks: logs.length, rows: logs.reduce((s, l) => s + l.rowsRemoved, 0) });
    return { results: logs, rows: logs.reduce((s, l) => s + l.rowsRemoved, 0), bytes: logs.reduce((s, l) => s + l.bytesFreed, 0) };
  });

  app.get('/api/maintenance/log', async (req, reply) => {
    if (!admin(req, reply)) return;
    const f = logFilter(req);
    return queryLog({ ...f, limit: f.limit ?? 50 });
  });

  app.get('/api/maintenance/log.csv', async (req, reply) => {
    if (!admin(req, reply)) return;
    const r = await queryLog({ ...logFilter(req), limit: 5000, offset: 0 });
    await audit(req, 'maintenance.log_export', { type: 'maintenance' }, { rows: r.items.length });
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="maintenance-log.csv"').send(logCsv(r.items));
  });
}
