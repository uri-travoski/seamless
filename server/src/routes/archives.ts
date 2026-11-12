/** Archive old mail (T8.4). Every query is scoped to the signed-in user: someone else's archive is a 404. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { q, one, run } from '../db.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { uid, isAdmin } from './util.ts';
import { config } from '../config.ts';
import { audit } from '../audit/log.ts';
import { ArchiveError, parseOlderThan, previewArchive, sampleArchive, type ArchiveOptions } from '../archive/select.ts';
import { planArchive, getArchive, view, archiveStore, archivePrefix } from '../archive/run.ts';
import { searchArchive, downloadEml, startRestore } from '../archive/restore.ts';
import { getSchedule, saveSchedule } from '../archive/schedule.ts';
import { listTargets, listSourceTargets, getTarget, insertTarget, recordTest, toS3Config, view as targetView, PROVIDERS } from '../storage/targets.ts';
import { sourceStore, scanSource, testSource, dirOf, type ImportSourceRef } from '../archive/source.ts';
import { queueImport, getImport, importView, pauseImport, resumeImport, retryImport, removeImport, listFailures, CATEGORIES, type ImportRow } from '../archive/import.ts';

const fail = (reply: FastifyReply, err: any) => {
  if (err instanceof ArchiveError) return reply.code(err.status).send({ error: err.message });
  throw err;
};
const bool = (v: unknown) => v === true || v === 'true' || v === '1' || v === 1;
const optsOf = (b: any): ArchiveOptions => ({
  includeStarred: bool(b?.includeStarred), includeVip: bool(b?.includeVip), includeSpamBin: bool(b?.includeSpamBin), alsoDeleteFromServer: bool(b?.alsoDeleteFromServer),
});
const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

const importsDir = () => path.join(config.dataDir, 'imports');
const tokenRe = /^[a-f0-9]{32}$/;

export function register(app: FastifyInstance): void {
  registerImportRoutes(app);
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

/** Open an archive in another instance (T8.6). Administrators only; the source is only ever read. */
function registerImportRoutes(app: FastifyInstance): void {
  const guard = (req: any, reply: any) => (isAdmin(req) ? false : (reply.code(403).send({ error: 'admin only' }), true));
  const srcFrom = async (b: any): Promise<ImportSourceRef> => {
    if (b.kind === 'zip') {
      if (!tokenRe.test(String(b.uploadId ?? ''))) throw new ArchiveError(400, 'uploadId is missing');
      const file = path.join(importsDir(), `${b.uploadId}.zip`);
      if (!fs.existsSync(file)) throw new ArchiveError(404, 'that upload is gone, upload the .zip again');
      return { kind: 'zip', targetId: null, ref: file };
    }
    if (b.kind === 'folder') {
      const dir = path.resolve(String(b.folder ?? ''));
      if (!b.folder || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ArchiveError(400, 'that folder does not exist on the server');
      return { kind: 'folder', targetId: null, ref: dir };
    }
    const t = await getTarget(Number(b.targetId));
    if (!t || t.role !== 'archive_source') throw new ArchiveError(404, 'attached bucket not found');
    return { kind: 'bucket', targetId: t.id, ref: '' };
  };
  const parseSource = (b: any) => {
    const provider = String(b.provider ?? 'other');
    if (!PROVIDERS[provider]) throw new ArchiveError(400, 'unknown provider');
    const endpoint = String(b.endpoint ?? '').trim();
    if (!/^https?:\/\/[^\s/]+/i.test(endpoint)) throw new ArchiveError(400, 'endpoint must be a full URL (https://…)');
    const bucket = String(b.bucket ?? '').trim();
    if (!bucket) throw new ArchiveError(400, 'bucket is required');
    if (!b.accessKey || !b.secretKey) throw new ArchiveError(400, 'access key and secret key are required');
    return {
      provider, endpoint, bucket, region: String(b.region ?? 'us-east-1').trim() || 'us-east-1', prefix: String(b.prefix ?? ''),
      forcePathStyle: b.forcePathStyle ?? PROVIDERS[provider].pathStyle, accessKey: String(b.accessKey), secretKey: String(b.secretKey),
    };
  };

  app.get('/api/archives/sources', async (req, reply) => {
    if (guard(req, reply)) return;
    return { sources: (await listSourceTargets()).map(targetView), providers: PROVIDERS };
  });

  /** Test a bucket that is not saved yet: 7 read-only checks. */
  app.post('/api/archives/sources/test', async (req, reply) => {
    if (guard(req, reply)) return;
    try {
      const i = parseSource(req.body ?? {});
      return await testSource({ endpoint: i.endpoint, region: i.region, bucket: i.bucket, accessKey: i.accessKey, secretKey: i.secretKey, forcePathStyle: !!i.forcePathStyle }, { prefix: i.prefix });
    } catch (e) { return fail(reply, e); }
  });

  app.post('/api/archives/sources', async (req, reply) => {
    if (guard(req, reply)) return;
    try {
      const i = parseSource(req.body ?? {});
      const test = await testSource({ endpoint: i.endpoint, region: i.region, bucket: i.bucket, accessKey: i.accessKey, secretKey: i.secretKey, forcePathStyle: !!i.forcePathStyle }, { prefix: i.prefix });
      if (!test.ok) return reply.code(400).send({ error: 'The connection test failed, so nothing was saved.', test });
      const id = await insertTarget({ role: 'archive_source', ...i }, false, test);
      await audit(req, 'archive.source_attach', { type: 'storage_target', id }, { bucket: i.bucket, prefix: i.prefix });
      return reply.code(201).send({ target: targetView((await getTarget(id))!), test });
    } catch (e) { return fail(reply, e); }
  });

  app.post('/api/archives/sources/:id/test', async (req, reply) => {
    if (guard(req, reply)) return;
    const t = await getTarget(Number((req.params as any).id));
    if (!t || t.role !== 'archive_source') return reply.code(404).send({ error: 'not found' });
    const res = await testSource(toS3Config(t), { prefix: t.prefix });
    await recordTest(t.id, res);
    return res;
  });

  app.delete('/api/archives/sources/:id', async (req, reply) => {
    if (guard(req, reply)) return;
    const t = await getTarget(Number((req.params as any).id));
    if (!t || t.role !== 'archive_source') return reply.code(404).send({ error: 'not found' });
    if (await one("SELECT 1 FROM archive_imports WHERE target_id = ? AND status IN ('queued','running')", [t.id])) return reply.code(409).send({ error: 'An import from this bucket is running. Pause or finish it first.' });
    await run('DELETE FROM storage_targets WHERE id = ?', [t.id]);
    await audit(req, 'archive.source_detach', { type: 'storage_target', id: t.id }, { bucket: t.bucket });
    return { ok: true };
  });

  /** What is in an attached bucket / uploaded zip / folder: archives (greyed with a reason when unsupported) and full backups. */
  app.post('/api/archives/sources/scan', async (req, reply) => {
    if (guard(req, reply)) return;
    try { return await scanSource(await sourceStore(await srcFrom((req.body ?? {}) as any))); } catch (e) { return fail(reply, e); }
  });

  /** Stream an uploaded archive .zip to disk, then list what is inside. */
  app.post('/api/archives/imports/upload', async (req, reply) => {
    if (guard(req, reply)) return;
    const file = await (req as any).file({ limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
    if (!file) return reply.code(400).send({ error: 'file required' });
    fs.mkdirSync(importsDir(), { recursive: true });
    const token = randomBytes(16).toString('hex');
    const dest = path.join(importsDir(), `${token}.zip`);
    await pipeline(file.file, fs.createWriteStream(dest));
    if (file.file.truncated) { fs.rmSync(dest, { force: true }); return reply.code(413).send({ error: 'the file is too large' }); }
    try {
      const found = await scanSource(await sourceStore({ kind: 'zip', targetId: null, ref: dest }));
      if (!found.archives.length && !found.backups.length) { fs.rmSync(dest, { force: true }); return reply.code(400).send({ error: 'No archive found in that .zip (it must contain an archive folder with manifest.json).' }); }
      return { uploadId: token, ...found };
    } catch { fs.rmSync(dest, { force: true }); return reply.code(400).send({ error: 'That file is not a readable .zip' }); }
  });

  app.get('/api/archives/imports', async (req, reply) => {
    if (guard(req, reply)) return;
    const rows = await q<ImportRow>('SELECT * FROM archive_imports WHERE user_id = ? ORDER BY id DESC', [uid(req)]);
    return { imports: rows.map(importView), categories: CATEGORIES };
  });

  app.post('/api/archives/imports', async (req, reply) => {
    if (guard(req, reply)) return;
    const b = (req.body ?? {}) as any;
    try {
      const src = await srcFrom(b);
      const store = await sourceStore(src);
      let dirs: string[] = Array.isArray(b.archives) ? b.archives.map(String) : [];
      if (b.archives === 'all' || b.all) dirs = (await scanSource(store)).archives.filter((a) => a.supported).map((a) => a.path);
      if (!dirs.length) throw new ArchiveError(400, 'choose at least one archive');
      const imports = await queueImport(uid(req), src, dirs.map((d) => (d && !d.endsWith('/') ? `${d}/` : d)), { accounts: b.accounts, categories: b.categories });
      return reply.code(202).send({ imports: imports.map(importView) });
    } catch (e) { return fail(reply, e); }
  });

  app.get('/api/archives/imports/:id', async (req, reply) => {
    if (guard(req, reply)) return;
    const imp = await getImport(uid(req), Number((req.params as any).id));
    if (!imp) return reply.code(404).send({ error: 'import not found' });
    return { ...importView(imp), failures: (await listFailures(imp.id)).map((f) => ({ key: f.message_key, error: f.error })) };
  });

  for (const [verb, fn] of [['pause', pauseImport], ['resume', resumeImport], ['retry', retryImport]] as const) {
    app.post(`/api/archives/imports/:id/${verb}`, async (req, reply) => {
      if (guard(req, reply)) return;
      return (await fn(uid(req), Number((req.params as any).id))) ? { ok: true } : reply.code(409).send({ error: `Cannot ${verb} this import right now` });
    });
  }

  app.delete('/api/archives/imports/:id', async (req, reply) => {
    if (guard(req, reply)) return;
    const r = await removeImport(uid(req), Number((req.params as any).id));
    return r ? { ok: true, ...r } : reply.code(404).send({ error: 'import not found' });
  });
}
