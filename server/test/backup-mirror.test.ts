import { describe, it, expect, beforeEach } from 'vitest';
import { blobStore, resetDb, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { q, one, run, migrate, setSetting } from '../src/db.ts';
import { config } from '../src/config.ts';
import { setMailStore, getBlob, type BlobStore } from '../src/s3.ts';
import { createBackup, restoreBackup, verifyBackup, listBackups } from '../src/backup/engine.ts';
import { sweepMirror, mirrorPrefix } from '../src/backup/mirror.ts';
import { isDue, nextDueAt, runBackup, getBackupConfig, setBackupConfig, intervalHours, type BackupConfig } from '../src/backup/schedule.ts';

const store: BlobStore = {
  put: async (key, body) => { blobStore.set(key, body); },
  get: async (key) => { const b = blobStore.get(key); if (!b) throw new Error(`no blob ${key}`); return b; },
  list: async (prefix) => [...blobStore.keys()].filter((k) => k.startsWith(prefix)).sort(),
  del: async (key) => { blobStore.delete(key); },
};
const PREFIX = 'backup/';

async function addMail(n: number, tag = 'a') {
  const acct = (await one<{ id: number }>('SELECT id FROM accounts ORDER BY id LIMIT 1'))?.id ?? await makeAccount('alice@demo.test');
  const box = (await one<{ id: number }>('SELECT id FROM mailboxes WHERE account_id = ? LIMIT 1', [acct]))?.id ?? await makeMailbox(acct, 'INBOX', 'inbox');
  for (let i = 0; i < n; i++) {
    await ingest(acct, box, rawEmail({ from: `s${tag}${i}@shop.test`, to: 'alice@demo.test', subject: `Mirror ${tag}${i}`, body: `body ${tag}${i}` }));
  }
}
const mirrored = () => [...blobStore.keys()].filter((k) => k.startsWith(`${PREFIX}blobs/`));
const mailKeys = () => [...blobStore.keys()].filter((k) => k.startsWith('msg/'));

beforeEach(async () => {
  await migrate();
  await resetDb();
  blobStore.clear();
  await run('DELETE FROM backup_blob_index');
  setMailStore({ ...config.s3 });
});

describe('backup email mirror', () => {
  it('first run mirrors N blobs, second run only the new ones', async () => {
    await addMail(3);
    const m1 = await createBackup({ prefix: PREFIX, store, includeEmails: true });
    expect(m1.v).toBe(2);
    expect(m1.blobs).toMatchObject({ mirrored: 3, total: 3, missing: 0 });
    expect(m1.blobs!.verifiedSample).toBe(3);
    expect(mirrored()).toHaveLength(3);

    await addMail(2, 'b');
    const m2 = await createBackup({ prefix: PREFIX, store, includeEmails: true });
    expect(m2.blobs).toMatchObject({ mirrored: 2, total: 5 });
    expect(mirrored()).toHaveLength(5);
    expect((await one<{ c: number }>('SELECT COUNT(*)::int c FROM backup_blob_index'))!.c).toBe(5);
    await verifyBackup(m2.key, { store });
  });

  it('does nothing when includeEmails is off', async () => {
    await addMail(2);
    const m = await createBackup({ prefix: PREFIX, store });
    expect(m.blobs).toBeUndefined();
    expect(mirrored()).toHaveLength(0);
  });

  it('detects a corrupted mirror object during the sample check', async () => {
    await addMail(1);
    await createBackup({ prefix: PREFIX, store, includeEmails: true });
    blobStore.set(mirrored()[0], Buffer.from('tampered'));
    await expect(createBackup({ prefix: PREFIX, store, includeEmails: true })).rejects.toThrow(/mirror verification failed/);
  });

  it('restores messages from the mirror after the primary mail bucket is wiped', async () => {
    await addMail(3);
    const m = await createBackup({ prefix: PREFIX, store, includeEmails: true });
    const before = await q<{ s3_key: string }>('SELECT s3_key FROM messages ORDER BY id');
    for (const k of mailKeys()) blobStore.delete(k);          // primary bucket lost
    await expect(getBlob(before[0].s3_key)).rejects.toThrow();

    const report = await restoreBackup(m.key, { store, mailFromMirror: true });
    expect(report.mailStore.fromMirror).toBe(true);
    expect(report.blobs.ok).toBe(true);
    for (const r of before) expect((await getBlob(r.s3_key)).length).toBeGreaterThan(10);
    setMailStore({ ...config.s3 });
  });

  it('mailFromMirror refuses a backup without a mirror; hints when the primary is missing', async () => {
    await addMail(1);
    const plain = await createBackup({ prefix: PREFIX, store });
    await expect(restoreBackup(plain.key, { store, mailFromMirror: true })).rejects.toThrow(/no mail mirror/);
    const withMirror = await createBackup({ prefix: PREFIX, store, includeEmails: true });
    for (const k of mailKeys()) blobStore.delete(k);
    const r = await restoreBackup(withMirror.key, { store });
    expect(r.blobs.ok).toBe(false);
    expect(r.mirrorAvailable).toBe(true);
  });

  it('version-1 manifests still verify and restore', async () => {
    await addMail(2);
    const m = await createBackup({ prefix: PREFIX, store });
    const v1 = { ...m, v: 1 } as any; delete v1.schemaVersion; delete v1.blobs;
    blobStore.set(`${m.key}manifest.json`, Buffer.from(JSON.stringify(v1)));
    await verifyBackup(m.key, { store });
    const rep = await restoreBackup(m.key, { store });
    expect(rep.rows).toBeGreaterThan(0);
    expect((await listBackups({ prefix: PREFIX, store }))).toHaveLength(1);
  });

  it('mark-and-sweep removes mirror blobs no kept backup references', async () => {
    await addMail(2);
    const m1 = await createBackup({ prefix: PREFIX, store, includeEmails: true });
    const victim = (await q<{ s3_key: string }>('SELECT s3_key FROM messages ORDER BY id LIMIT 1'))[0].s3_key;
    await run('DELETE FROM messages WHERE s3_key = ?', [victim]);
    const m2 = await createBackup({ prefix: PREFIX, store, includeEmails: true });
    // both kept: nothing swept
    expect(await sweepMirror({ store, prefix: PREFIX, keptDirs: [m1.key, m2.key] })).toBe(0);
    // m1 pruned: the victim is only referenced by m1
    expect(await sweepMirror({ store, prefix: PREFIX, keptDirs: [m2.key] })).toBe(1);
    expect(blobStore.has(`${mirrorPrefix(PREFIX)}${victim}`)).toBe(false);
    expect(mirrored()).toHaveLength(1);
  });

  it('runBackup mirrors when configured and sweeps after pruning', async () => {
    await addMail(2);
    await setBackupConfig({ enabled: true, includeEmails: true, keep: 1, prefix: PREFIX });
    const cfg = await getBackupConfig();
    expect(cfg.includeEmails).toBe(true);
    const r = await runBackup({ store });
    expect(r.ok).toBe(true);
    expect([...blobStore.keys()].filter((k) => k.startsWith(mirrorPrefix(cfg.prefix)))).toHaveLength(2);
    await setBackupConfig({ includeEmails: false });
  });
});

describe('schedule: every N hours + monthly', () => {
  const cfg = (over: Partial<BackupConfig> = {}): BackupConfig => ({
    enabled: true, frequency: 'daily', hour: 2, keep: 14, prefix: PREFIX, alertEmail: '', everyHours: 6, includeEmails: false, ...over,
  });
  const H = 3_600_000;
  const at = (iso: string) => new Date(iso).getTime();

  it('every_n_hours is due once N hours passed, at any hour of the day', () => {
    const c = cfg({ frequency: 'every_n_hours', everyHours: 3 });
    const last = at('2026-03-10T05:30:00Z');
    expect(isDue(last, c, last + 2 * H)).toBe(false);
    expect(isDue(last, c, last + 3 * H)).toBe(true);
    expect(nextDueAt(last, c, last + H)).toBe(at('2026-03-10T09:00:00Z'));
  });

  it('clamps everyHours to 1–24', () => {
    expect(intervalHours({ frequency: 'every_n_hours', everyHours: 0 })).toBe(6);
    expect(intervalHours({ frequency: 'every_n_hours', everyHours: 99 })).toBe(24);
    expect(intervalHours({ frequency: 'every_n_hours', everyHours: 1 })).toBe(1);
  });

  it('monthly = 30 days at the slot hour', () => {
    const c = cfg({ frequency: 'monthly', hour: 2 });
    const last = at('2026-03-01T02:00:00Z');
    expect(isDue(last, c, at('2026-03-20T02:00:00Z'))).toBe(false);
    expect(isDue(last, c, at('2026-03-31T02:00:00Z'))).toBe(true);
    expect(nextDueAt(last, c, at('2026-03-02T00:00:00Z'))).toBe(at('2026-03-31T02:00:00Z'));
  });

  it('persists everyHours and monthly through the settings', async () => {
    await setBackupConfig({ frequency: 'monthly', everyHours: 12 });
    const c = await getBackupConfig();
    expect(c.frequency).toBe('monthly');
    expect(c.everyHours).toBe(12);
    await setBackupConfig({ frequency: 'daily' });
  });
});

describe('backup.failed event', () => {
  it('a failing run emits backup.failed to admins and records the error', async () => {
    const broken: BlobStore = { ...store, put: async () => { throw new Error('bucket unreachable'); } };
    const r = await runBackup({ store: broken });
    expect(r.ok).toBe(false);
    const ev = await q<{ type: string }>("SELECT type FROM events WHERE type = 'backup.failed' AND user_id = ?", [TEST_USER]);
    expect(ev).toHaveLength(1);
    const n = await q<{ title: string }>("SELECT title FROM notifications WHERE user_id = ? AND title = 'Backup failed'", [TEST_USER]);
    expect(n.length).toBeGreaterThan(0);
  });

  it('a good run emits backup.ok', async () => {
    const r = await runBackup({ store });
    expect(r.ok).toBe(true);
    expect((await q("SELECT 1 FROM events WHERE type = 'backup.ok'")).length).toBe(1);
  });
});
