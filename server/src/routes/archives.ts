/** Archive old mail (T8.4). Every query is scoped to the signed-in user: someone else's archive is a 404. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { q, one, run } from '../db.ts';
import { uid } from './util.ts';
import { audit } from '../audit/log.ts';
import { ArchiveError, parseOlderThan, previewArchive, sampleArchive, type ArchiveOptions } from '../archive/select.ts';
import { planArchive, getArchive, view, archiveStore, archivePrefix } from '../archive/run.ts';
import { searchArchive, downloadEml, startRestore } from '../archive/restore.ts';
import { getSchedule, saveSchedule } from '../archive/schedule.ts';
import { listTargets } from '../storage/targets.ts';

const fail = (reply: FastifyReply, err: any) => {
  if (err instanceof ArchiveError) return reply.code(err.status).send({ error: err.message });
  throw err;
};
const bool = (v: unknown) => v === true || v === 'true' || v === '1' || v === 1;
const optsOf = (b: any): ArchiveOptions => ({
  includeStarred: bool(b?.includeStarred), includeVip: bool(b?.includeVip), includeSpamBin: bool(b?.includeSpamBin), alsoDeleteFromServer: bool(b?.alsoDeleteFromServer),
});
const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

export function register(app: FastifyInstance): void {
  app.get('/api/archives/preview', async (req, reply) => {
    const b = (req.query ?? {}) as any;
    try {
      const days = parseOlderThan(b);
      return { olderThanDays: days, ...(await previewArchive(uid(req), String(b.scope || 'all'), days, optsOf(b))) };
    } catch (e) { return fail(reply, e); }
  });

  /** Saved backup storage targets, names only — the archive card needs them and the full list is admin-only. */
  app.get('/api/archives/targets', async () => ({
    targets: (await listTargets()).filter((t) => t.role === 'backup').map((t) => ({ id: t.id, name: `${t.bucket}${t.prefix ? ` / ${t.prefix}` : ''}`, provider: t.provider, active: t.active })),
  }));

  app.get('/api/archives/schedule', async (req) => ({ schedule: await getSchedule(uid(req)) }));
  app.put('/api/archives/schedule', async (req, reply) => {
    try { return { schedule: await saveSchedule(uid(req), req.body ?? {}) }; } catch (e) { return fail(reply, e); }
  });

  /** "Older mail may be in an archive": search every finished archive's index for the signed-in user. */
  app.get('/api/archives/search', async (req) => {
    const b = (req.query ?? {}) as any;
    const rows = await q<any>("SELECT id, name FROM mail_archives WHERE user_id = ? AND manifest_key IS NOT NULL AND status IN ('done','restoring') ORDER BY id DESC", [uid(req)]);
    const out: any[] = []; let total = 0;
    for (const a of rows) {
      try {
        const r = await searchArchive(uid(req), a.id, { q: b.q ? String(b.q) : undefined, limit: 50 });
        total += r.total;
        for (const x of r.results) out.push({ ...x, archiveId: a.id, archiveName: a.name });
      } catch { /* an unreachable archive store must not hide the others */ }
    }
    out.sort((x, y) => y.date - x.date);
    return { archives: rows.length, total, results: out.slice(0, 100) };
  });

  app.get('/api/archives', async (req) => {
    const rows = await q<any>('SELECT * FROM mail_archives WHERE user_id = ? ORDER BY id DESC', [uid(req)]);
    return { archives: await Promise.all(rows.map(view)) };
  });

  app.post('/api/archives', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    try {
      const days = parseOlderThan(b);
      const options = optsOf(b.options ?? b);
      if (bool(b.dryRun)) {
        const scope = String(b.scope || 'all');
        return { dryRun: true, olderThanDays: days, ...(await previewArchive(uid(req), scope, days, options)), sample: await sampleArchive(uid(req), scope, days, options) };
      }
      const a = await planArchive(uid(req), { name: b.name, scope: b.scope, mode: b.mode, targetId: num(b.targetId), options, olderThanDays: days });
      return reply.code(201).send(await view(a));
    } catch (e) { return fail(reply, e); }
  });

  app.get('/api/archives/:id', async (req, reply) => {
    const a = await getArchive(uid(req), Number((req.params as any).id));
    return a ? view(a) : reply.code(404).send({ error: 'archive not found' });
  });

  app.post('/api/archives/:id/restore', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    try {
      const jobId = await startRestore(uid(req), Number((req.params as any).id), {
        q: b.q ? String(b.q) : undefined, from: num(b.from), to: num(b.to), keys: Array.isArray(b.keys) ? b.keys.map(String) : undefined,
      });
      return reply.code(202).send({ ok: true, jobId });
    } catch (e) { return fail(reply, e); }
  });

  app.get('/api/archives/:id/search', async (req, reply) => {
    const b = (req.query ?? {}) as any;
    try {
      return await searchArchive(uid(req), Number((req.params as any).id), { q: b.q ? String(b.q) : undefined, from: num(b.from), to: num(b.to), limit: num(b.limit) });
    } catch (e) { return fail(reply, e); }
  });

  app.get('/api/archives/:id/messages/:key/eml', async (req, reply) => {
    const p = req.params as any;
    try {
      const { raw, name } = await downloadEml(uid(req), Number(p.id), String(p.key));
      return reply.header('content-type', 'message/rfc822').header('content-disposition', `attachment; filename="${name}"`).send(raw);
    } catch (e) { return fail(reply, e); }
  });

  /** Deleting an archive removes its objects from the storage target. The body must repeat the archive's name. */
  app.delete('/api/archives/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const a = await getArchive(uid(req), id);
    if (!a) return reply.code(404).send({ error: 'archive not found' });
    if (['running', 'verifying', 'restoring'].includes(a.status)) return reply.code(409).send({ error: 'The archive is busy. Try again when it has finished.' });
    if (String(((req.body ?? {}) as any).confirm ?? '') !== a.name) return reply.code(400).send({ error: 'type the archive name to confirm' });
    try {
      const store = await archiveStore(a);
      for (const k of await store.list(archivePrefix(id))) await store.del(k);
    } catch (e) { return fail(reply, e); }
    await run('DELETE FROM mail_archives WHERE id = ? AND user_id = ?', [id, uid(req)]);
    await audit(req, 'archive.delete', { type: 'archive', id }, { name: a.name });
    return { ok: true };
  });
}
