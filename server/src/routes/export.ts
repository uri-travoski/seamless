/** Portable export / import (F-28 part 2). Export: admin. Import: full = first-run only (empty DB), settings = admin. */
import type { FastifyInstance } from 'fastify';
import { databaseIsEmpty } from '../backup/engine.ts';
import { createExport, importExport, ExportError } from '../backup/export.ts';
import { emitEvent, emitToAdmins } from '../events/emit.ts';
import { plog } from '../classify/settings.ts';
import { isAdmin, uid, pkgVersion } from './util.ts';

const IMPORT_LIMIT = 4 * 1024 * 1024 * 1024;

export function register(app: FastifyInstance): void {
  // the export file is binary; the password rides in a header so it never lands in a URL or access log
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: IMPORT_LIMIT }, (_req, body, done) => done(null, body));

  const fail = (reply: any, err: any) => {
    const code = err instanceof ExportError ? (err.code === 'not-empty' ? 403 : 400) : 500;
    return reply.code(code).send({ error: err?.message ?? 'failed' });
  };

  app.post('/api/export', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const b = (req.body ?? {}) as { password?: string; includeMail?: boolean };
    try {
      const { file, manifest } = await createExport({ password: String(b.password ?? ''), includeMail: !!b.includeMail, appVersion: pkgVersion });
      await emitEvent(uid(req), 'export.created', { type: 'export', id: manifest.createdAt }, { rows: manifest.rows, blobs: manifest.blobs, includeMail: manifest.includesMail });
      await plog(uid(req), 'backup', `full export created (${manifest.rows} rows, ${manifest.blobs} messages)`, {});
      const stamp = new Date(manifest.createdAt).toISOString().slice(0, 10);
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="seamless-${stamp}.seamless-export"`)
        .header('cache-control', 'no-store')
        .send(file);
    } catch (err) { return fail(reply, err); }
  });

  app.post('/api/import', { bodyLimit: IMPORT_LIMIT }, async (req, reply) => {
    const mode = String((req.query as any)?.mode ?? 'full') === 'settings' ? 'settings' : 'full';
    const password = String(req.headers['x-export-password'] ?? '');
    const file = req.body;
    if (!Buffer.isBuffer(file) || !file.length) return reply.code(400).send({ error: 'send the export file as application/octet-stream' });
    try {
      if (mode === 'full') {
        if (!(await databaseIsEmpty())) return reply.code(403).send({ error: 'already set up: a full import only works on an empty server' });
        const report = await importExport(file, password, { mode: 'full' });
        await emitToAdmins('export.imported', { type: 'export', id: report.manifest.createdAt }, { mode, rows: report.rows });
        return { ok: true, ...report };
      }
      if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
      const report = await importExport(file, password, { mode: 'settings', userId: uid(req) });
      const added = Object.values(report.added ?? {}).reduce((a, b) => a + b, 0);
      const skipped = Object.values(report.skipped ?? {}).reduce((a, b) => a + b, 0);
      await emitEvent(uid(req), 'export.imported', { type: 'export', id: report.manifest.createdAt }, { mode, added, skipped });
      return { ok: true, ...report };
    } catch (err) { return fail(reply, err); }
  });
}
