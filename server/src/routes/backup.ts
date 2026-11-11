/** Backups (admin) + first-run restore (public, refuses once a user exists). */
import type { FastifyInstance } from 'fastify';
import { one, run } from '../db.ts';
import { plog } from '../classify/settings.ts';
import { config } from '../config.ts';
import { listBackups, verifyBackup, restoreBackup, databaseIsEmpty } from '../backup/engine.ts';
import { getBackupConfig, setBackupConfig, getBackupStatus, runBackup, acknowledgeFailure, listBackupsForUi, normalizePrefix } from '../backup/schedule.ts';
import { makeStore } from '../s3.ts';
import { isAdmin, pkgVersion } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- backup (admin) ----
  app.get('/api/backup', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    // Unreachable storage must not 500 this page: a failing bucket is exactly when the
    // admin needs to reach it to read the failure banner and fix the configuration.
    let backups: Awaited<ReturnType<typeof listBackupsForUi>> = [];
    let storageError = '';
    try {
      backups = await listBackupsForUi();
    } catch (err: any) {
      storageError = err?.message ?? 'cannot read backup storage';
    }
    return { config: await getBackupConfig(), status: await getBackupStatus(), backups, storageError };
  });

  app.put('/api/backup', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    return { config: await setBackupConfig(req.body as any), status: await getBackupStatus() };
  });

  app.post('/api/backup/run', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const res = await runBackup({ appVersion: pkgVersion });
    if (!res.ok) return reply.code(500).send({ error: res.error });
    return { ...res, status: await getBackupStatus(), backups: await listBackupsForUi() };
  });

  app.post('/api/backup/verify', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const key = String((req.body as any)?.key ?? '');
    try {
      const { manifest, rows } = await verifyBackup(key);
      return { ok: true, rows, tables: Object.keys(manifest.tables).length, bytes: manifest.bytes };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'verify failed' });
    }
  });

  app.post('/api/backup/ack', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    await acknowledgeFailure();
    return { ok: true };
  });

  // Restore is deliberately NOT exposed to a logged-in admin: it truncates every
  // table, and the disaster case (empty database, nobody to log in as) is the only
  // one that needs it. Both routes below are public but refuse once a user exists.
  // The backup store's own credentials can never come out of the backup — you need them to
  // read it. So the setup screen may supply them, for a box rebuilt with no S3_BACKUP_* set.
  // (The MAIL bucket needs no such thing: its config travels inside the backup.)
  const backupStoreFrom = (body: any) => {
    const s = body?.store;
    if (!s?.bucket) return undefined;   // fall back to the environment
    return makeStore({
      endpoint: String(s.endpoint ?? config.s3Backup.endpoint),
      region: String(s.region ?? config.s3Backup.region),
      bucket: String(s.bucket),
      accessKey: String(s.accessKey ?? config.s3Backup.accessKey),
      secretKey: String(s.secretKey ?? config.s3Backup.secretKey),
      forcePathStyle: s.forcePathStyle ?? config.s3Backup.forcePathStyle,
    });
  };

  const listSetupBackups = async (body: any) => {
    const store = backupStoreFrom(body);
    const prefix = normalizePrefix(String(body?.prefix ?? (await getBackupConfig()).prefix));
    const backups = await listBackups({ prefix, store });
    return { backups, prefix, bucket: store ? (body.store.bucket as string) : config.s3Backup.bucket };
  };

  app.get('/api/setup/backups', async (req, reply) => {
    if (!(await databaseIsEmpty())) return reply.code(403).send({ error: 'already set up' });
    try {
      return await listSetupBackups(undefined);
    } catch (err: any) {
      // no usable storage config in the environment: the UI then asks the user for it
      return reply.code(400).send({ error: `cannot read backup storage: ${err?.message ?? err}`, needsStorage: true });
    }
  });

  /** Same as the GET, but the caller names the bucket + credentials to look in. */
  app.post('/api/setup/backups', async (req, reply) => {
    if (!(await databaseIsEmpty())) return reply.code(403).send({ error: 'already set up' });
    try {
      return await listSetupBackups(req.body);
    } catch (err: any) {
      return reply.code(400).send({ error: `cannot read that bucket: ${err?.message ?? err}`, needsStorage: true });
    }
  });

  app.post('/api/setup/restore', async (req, reply) => {
    if (!(await databaseIsEmpty())) return reply.code(403).send({ error: 'already set up' });
    const body = req.body as any;
    const key = String(body?.key ?? '');
    if (!key) return reply.code(400).send({ error: 'backup key required' });
    try {
      const report = await restoreBackup(key, { store: backupStoreFrom(body) });
      await plog(null, 'backup', `restored ${report.rows} rows from ${report.key}`, { meta: report });
      return { ok: true, ...report };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'restore failed' });
    }
  });
}
