import { describe, it, expect, beforeEach } from 'vitest';
import { blobStore, resetDb, makeAccount, makeMailbox, ingest, rawEmail, TEST_USER } from './helpers.ts';
import { q, one, run, insertId, migrate } from '../src/db.ts';
import { config } from '../src/config.ts';
import { setMailStore, type BlobStore } from '../src/s3.ts';
import {
  createBackup, restoreBackup, verifyBackup, listBackups, pruneBackups,
} from '../src/backup/engine.ts';
import { isDue, nextDueAt, normalizePrefix, alertRecipients, APP_FOLDER, INTERVAL_HOURS, type BackupConfig } from '../src/backup/schedule.ts';
import { saveMailStoreConfig, loadMailStoreConfig } from '../src/backup/mailref.ts';

/** The same in-memory store the helpers use for .eml blobs, exposed as a BlobStore. */
const store: BlobStore = {
  put: async (key, body) => { blobStore.set(key, body); },
  get: async (key) => {
    const b = blobStore.get(key);
    if (!b) throw new Error(`no blob ${key}`);
    return b;
  },
  list: async (prefix) => [...blobStore.keys()].filter((k) => k.startsWith(prefix)).sort(),
  del: async (key) => { blobStore.delete(key); },
};

const PREFIX = 'backup/';

/** Everything a restore has to bring back: mail, labels, links, rules, vectors, flags. */
async function seedRealisticData() {
  const accountId = await makeAccount('alice@demo.test');
  const inbox = await makeMailbox(accountId, 'INBOX', 'inbox');

  const labelId = await insertId(
    'INSERT INTO labels(user_id, name, color, description, sort) VALUES (?,?,?,?,?)',
    [TEST_USER, 'Receipts', '#2f8ed8', 'purchase receipts', 0]);

  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await ingest(accountId, inbox, rawEmail({
      from: `sender${i}@shop.test`, to: 'alice@demo.test',
      subject: `Invoice ${i} — açaí & ünïcode "quotes"`, body: `body ${i}`,
    }));
    ids.push(res!.rowId);
  }

  await run('UPDATE messages SET unread = false, flagged = true WHERE id = ?', [ids[0]]);
  await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?)', [ids[0], labelId]);
  // provenance lives in ai_decisions, not on the link row
  await run('INSERT INTO ai_decisions(user_id, email_id, tier, model, output, confidence, reason, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [TEST_USER, ids[0], 'llm', 'gemini-2.5-flash-lite', JSON.stringify({ label: 'Receipts' }), 0.93, 'itemised invoice', Date.now()]);
  await run('INSERT INTO rules(user_id, enabled, ord, match_field, match_value, action, label_id, stop, note, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [TEST_USER, true, 1, 'from_domain', 'shop.test', 'label', labelId, true, '', 'manual', Date.now()]);

  // pgvector column: the format that most plausibly breaks a hand-rolled dump
  const embedding = `[${Array.from({ length: 8 }, (_, i) => (i / 10).toFixed(3)).join(',')}]`;
  await run('INSERT INTO email_vectors(message_id, user_id, label_id, dim, embedding, created_at, source) VALUES (?,?,?,?,?,?,?)',
    [ids[0], TEST_USER, labelId, 8, embedding, Date.now(), 'local']);

  return { accountId, inbox, labelId, ids };
}

async function tableCounts(): Promise<Record<string, number>> {
  const tables = await q<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
  const out: Record<string, number> = {};
  for (const t of tables) {
    const row = await one<{ c: number }>(`SELECT COUNT(*)::int c FROM "${t.table_name}"`);
    out[t.table_name] = row?.c ?? 0;
  }
  return out;
}

/** Simulates the disaster properly: not an empty database but NO database — schema,
 *  tables, sequences and the pgvector extension all gone, exactly what a rebuilt box
 *  starts from. restoreBackup has to migrate from nothing before it can replay a row. */
async function wipeDatabase() {
  await run('DROP SCHEMA public CASCADE');
  await run('CREATE SCHEMA public');
}

beforeEach(async () => {
  await migrate();   // a previous test may have dropped the schema to simulate a dead server
  await resetDb();
  blobStore.clear();
  setMailStore({ ...config.s3 });   // the store is module state: a repointing test must not leak
});

describe('backup round-trip', () => {
  it('restores every table, row and value after the database is wiped', async () => {
    const { ids, labelId } = await seedRealisticData();
    const beforeMsg = await one<any>('SELECT * FROM messages WHERE id = ?', [ids[0]]);

    const manifest = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });
    expect(manifest.rows).toBeGreaterThan(0);
    // snapshot AFTER the backup: taking one records the mail-store config in `settings`,
    // so that row is part of what the dump holds and must come back too
    const before = await tableCounts();

    await wipeDatabase();
    expect(Object.keys(await tableCounts())).toHaveLength(0);   // no schema at all, not just empty

    const report = await restoreBackup(manifest.key, { store });

    expect(await tableCounts()).toEqual(before);
    expect(report.rows).toBe(manifest.rows);
    expect(report.skippedColumns).toEqual([]);

    const afterMsg = await one<any>('SELECT * FROM messages WHERE id = ?', [ids[0]]);
    expect(afterMsg).toEqual(beforeMsg);
    expect(afterMsg.subject).toContain('açaí');
    expect(afterMsg.flagged).toBe(true);
    expect(afterMsg.unread).toBe(false);

    // the label link and the AI decision behind it survive, or the learning history is worthless
    expect(await one('SELECT 1 FROM message_labels WHERE message_id = ? AND label_id = ?', [ids[0], labelId])).toBeTruthy();
    const decision = await one<any>('SELECT * FROM ai_decisions WHERE email_id = ?', [ids[0]]);
    expect(decision.tier).toBe('llm');
    expect(Number(decision.confidence)).toBeCloseTo(0.93, 5);
    expect(decision.reason).toBe('itemised invoice');
  });

  it('restores the pgvector embedding intact', async () => {
    const { ids } = await seedRealisticData();
    const before = await one<{ embedding: string; dim: number }>('SELECT embedding, dim FROM email_vectors WHERE message_id = ?', [ids[0]]);

    const manifest = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });
    await wipeDatabase();
    await restoreBackup(manifest.key, { store });

    const after = await one<{ embedding: string; dim: number }>('SELECT embedding, dim FROM email_vectors WHERE message_id = ?', [ids[0]]);
    expect(after).toEqual(before);
    // and it is still a usable vector, not just text that looks like one
    const knn = await one<{ d: number }>(
      "SELECT embedding <=> '[0,0.1,0.2,0.3,0.4,0.5,0.6,0.7]'::vector AS d FROM email_vectors WHERE message_id = ?", [ids[0]]);
    expect(Number(knn!.d)).toBeCloseTo(0, 5);
  });

  it('rebuilds the generated full-text column so search still works', async () => {
    await seedRealisticData();
    const manifest = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });
    await wipeDatabase();
    await restoreBackup(manifest.key, { store });

    // tsv is generated with the 'simple' config (db.ts), so search must use it too
    const hit = await one<{ c: number }>(
      "SELECT COUNT(*)::int c FROM message_fts WHERE tsv @@ plainto_tsquery('simple', 'invoice')");
    expect(hit!.c).toBe(5);
  });

  it('resets sequences so the next insert does not collide with a restored id', async () => {
    const { accountId, inbox } = await seedRealisticData();
    const manifest = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });
    await wipeDatabase();
    await restoreBackup(manifest.key, { store });

    const res = await ingest(accountId, inbox, rawEmail({
      from: 'new@shop.test', to: 'alice@demo.test', subject: 'after restore',
    }));
    expect(res!.rowId).toBeGreaterThan(0);
    const dupes = await one<{ c: number }>('SELECT COUNT(*)::int c FROM messages WHERE id = ?', [res!.rowId]);
    expect(dupes!.c).toBe(1);
  });

  it('restores into a database that still has data, replacing it wholesale', async () => {
    await seedRealisticData();
    const manifest = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });

    // mutate after the backup: these changes must be gone afterwards
    await run("UPDATE labels SET name = 'Renamed' WHERE user_id = ?", [TEST_USER]);
    const extra = await insertId('INSERT INTO labels(user_id, name, color) VALUES (?,?,?)', [TEST_USER, 'Added Later', '#fff']);

    await restoreBackup(manifest.key, { store });

    expect(await one('SELECT 1 FROM labels WHERE id = ?', [extra])).toBeUndefined();
    expect((await one<any>('SELECT name FROM labels WHERE user_id = ?', [TEST_USER]))!.name).toBe('Receipts');
  });
});

describe('separate buckets for mail and backups', () => {
  /** A second, physically distinct store: nothing the mail store holds is visible here.
   *  This is what S3_BACKUP_BUCKET (or a whole other provider) looks like to the engine. */
  const otherBucket = new Map<string, Buffer>();
  const remoteBackupStore: BlobStore = {
    put: async (k, b) => { otherBucket.set(k, b); },
    get: async (k) => {
      const b = otherBucket.get(k);
      if (!b) throw new Error(`no blob ${k}`);
      return b;
    },
    list: async (p) => [...otherBucket.keys()].filter((k) => k.startsWith(p)).sort(),
    del: async (k) => { otherBucket.delete(k); },
  };

  beforeEach(() => otherBucket.clear());

  it('backs up to the backup bucket and restores from it, with mail left in the mail bucket', async () => {
    const { ids } = await seedRealisticData();
    const mailKeysBefore = [...blobStore.keys()];
    expect(mailKeysBefore.some((k) => k.startsWith('msg/'))).toBe(true);

    const manifest = await createBackup({ prefix: PREFIX, store: remoteBackupStore, appVersion: 'test' });

    // the backup landed ONLY in the backup bucket
    expect([...otherBucket.keys()].every((k) => k.startsWith(PREFIX))).toBe(true);
    expect([...blobStore.keys()].some((k) => k.startsWith(PREFIX))).toBe(false);
    // and it copied no mail: the backup is the index, not the archive
    expect([...otherBucket.keys()].some((k) => k.startsWith('msg/'))).toBe(false);

    await wipeDatabase();
    await restoreBackup(manifest.key, { store: remoteBackupStore });

    // rows are back, and their s3_key still points into the untouched mail bucket
    const msg = await one<{ s3_key: string }>('SELECT s3_key FROM messages WHERE id = ?', [ids[0]]);
    expect(msg!.s3_key.startsWith('msg/')).toBe(true);
    expect(blobStore.has(msg!.s3_key)).toBe(true);
    expect([...blobStore.keys()]).toEqual(mailKeysBefore);   // mail bucket never touched
  });

  it('restores even when the mail bucket is gone entirely', async () => {
    await seedRealisticData();
    const manifest = await createBackup({ prefix: PREFIX, store: remoteBackupStore, appVersion: 'test' });

    // lose the mail bucket AND the database: only the backup bucket survives
    blobStore.clear();
    await wipeDatabase();

    const report = await restoreBackup(manifest.key, { store: remoteBackupStore });

    // the database comes back whole — the mail bodies are simply missing until the mail
    // bucket is restored, which is exactly the separation the two buckets buy
    expect(report.rows).toBe(manifest.rows);
    expect((await tableCounts()).messages).toBe(5);
  });
});

describe('self-describing mail store', () => {
  /** Point the (mocked) mail store somewhere distinctive, so credentials in the output are
   *  unmistakably credentials and not just the default strings appearing by coincidence. */
  const pointMailStoreAt = (over: Partial<typeof config.s3> = {}) => setMailStore({
    endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'mail-bucket',
    accessKey: 'AK-distinctive-access', secretKey: 'SK-super-secret-key', forcePathStyle: false, ...over,
  });

  it('records the mail bucket in the manifest, but never its credentials', async () => {
    await seedRealisticData();
    pointMailStoreAt();
    const m = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });

    expect(m.mailStore?.bucket).toBe('mail-bucket');
    expect(m.mailStore?.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
    // the manifest is plaintext, so a credential in it would be a credential in the open
    const manifestText = JSON.stringify(m);
    expect(manifestText).not.toContain('SK-super-secret-key');
    expect(manifestText).not.toContain('AK-distinctive-access');
  });

  it('carries the mail-store credentials inside the encrypted payload, not in the clear', async () => {
    await seedRealisticData();
    pointMailStoreAt();
    const m = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });

    const cipher = blobStore.get(`${m.key}data.ndjson.gz.enc`)!;
    expect(cipher.includes(Buffer.from('SK-super-secret-key'))).toBe(false);   // encrypted at rest
    // and it really is in there: the whole config comes back after a restore
    await wipeDatabase();
    await restoreBackup(m.key, { store });
    const back = await loadMailStoreConfig();
    expect(back?.bucket).toBe('mail-bucket');
    expect(back?.endpoint).toBe('https://acct.r2.cloudflarestorage.com');
    expect(back?.secretKey).toBe('SK-super-secret-key');
  });

  it('reconnects to the mail bucket from the backup and proves the blobs are reachable', async () => {
    const { ids } = await seedRealisticData();
    const m = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });

    await wipeDatabase();
    const report = await restoreBackup(m.key, { store });

    expect(report.mailStore.bucket).toBe(config.s3.bucket);
    expect(report.blobs.checked).toBe(true);
    expect(report.blobs.ok).toBe(true);           // fetched a blob and its checksum matched
    const msg = await one<{ s3_key: string }>('SELECT s3_key FROM messages WHERE id = ?', [ids[0]]);
    expect(report.blobs.key).toBe(msg!.s3_key);
  });

  it('reports the mail bucket as unreachable instead of restoring into a silent 404', async () => {
    await seedRealisticData();
    const m = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });

    await wipeDatabase();
    const mailKeys = [...blobStore.keys()].filter((k) => k.startsWith('msg/'));
    for (const k of mailKeys) blobStore.delete(k);   // mail bucket gone / wrong bucket configured

    const report = await restoreBackup(m.key, { store });

    expect(report.rows).toBe(m.rows);              // the database still comes back whole
    expect(report.blobs.checked).toBe(true);
    expect(report.blobs.ok).toBe(false);           // and the missing mail is reported, not hidden
    expect(report.blobs.error).toBeTruthy();
  });
});

describe('backup integrity', () => {
  it('encrypts the payload: the plaintext subject is not in the uploaded bytes', async () => {
    await seedRealisticData();
    const manifest = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });

    const cipher = blobStore.get(`${manifest.key}data.ndjson.gz.enc`)!;
    expect(cipher.includes(Buffer.from('açaí'))).toBe(false);
    expect(cipher.includes(Buffer.from('alice@demo.test'))).toBe(false);
    // manifest stays readable so backups can be listed without the secret
    expect(JSON.parse(blobStore.get(`${manifest.key}manifest.json`)!.toString()).rows).toBe(manifest.rows);
  });

  it('rejects a corrupted payload instead of restoring garbage', async () => {
    await seedRealisticData();
    const manifest = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });

    const key = `${manifest.key}data.ndjson.gz.enc`;
    const cipher = Buffer.from(blobStore.get(key)!);
    cipher[cipher.length - 5] ^= 0xff;
    blobStore.set(key, cipher);

    await expect(verifyBackup(manifest.key, { store })).rejects.toThrow(/checksum mismatch/);
    await expect(restoreBackup(manifest.key, { store })).rejects.toThrow(/checksum mismatch/);
    // and the live database is untouched by the failed restore
    expect((await tableCounts()).messages).toBe(5);
  });

  it('rejects a truncated payload', async () => {
    await seedRealisticData();
    const manifest = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });
    const key = `${manifest.key}data.ndjson.gz.enc`;
    blobStore.set(key, blobStore.get(key)!.subarray(0, 40));

    await expect(verifyBackup(manifest.key, { store })).rejects.toThrow(/checksum mismatch/);
  });

  it('reports a wrong SEAMLESS_SECRET as such, not as a crypto error', async () => {
    await seedRealisticData();
    const manifest = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });

    // a manifest written under a different secret: its check token will not decrypt
    const mKey = `${manifest.key}manifest.json`;
    const m = JSON.parse(blobStore.get(mKey)!.toString());
    m.secretCheck = Buffer.from('not-a-valid-token-under-this-key').toString('base64');
    blobStore.set(mKey, Buffer.from(JSON.stringify(m)));

    await expect(verifyBackup(manifest.key, { store })).rejects.toThrow(/SEAMLESS_SECRET does not match/);
  });

  it('refuses a backup written by a newer format version', async () => {
    await seedRealisticData();
    const manifest = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });
    const mKey = `${manifest.key}manifest.json`;
    const m = JSON.parse(blobStore.get(mKey)!.toString());
    m.v = 99;
    blobStore.set(mKey, Buffer.from(JSON.stringify(m)));

    await expect(verifyBackup(manifest.key, { store })).rejects.toThrow(/unsupported backup format v99/);
  });
});

describe('retention', () => {
  it('keeps the newest N backups and deletes the rest, blobs and all', async () => {
    await seedRealisticData();
    const keys: string[] = [];
    for (let i = 0; i < 5; i++) {
      // createBackup stamps its directory from the clock; nudge it so keys stay distinct
      const m = await createBackup({ prefix: PREFIX, store, appVersion: 'test' });
      const shifted = m.key.replace(/\/$/, `-${i}/`);
      for (const k of await store.list(m.key)) {
        const body = await store.get(k);
        await store.put(k.replace(m.key, shifted), body);
        await store.del(k);
      }
      const mm = JSON.parse((await store.get(`${shifted}manifest.json`)).toString());
      mm.key = shifted;
      mm.createdAt = Date.now() + i * 1000;
      await store.put(`${shifted}manifest.json`, Buffer.from(JSON.stringify(mm)));
      keys.push(shifted);
    }
    expect(await listBackups({ prefix: PREFIX, store })).toHaveLength(5);

    const pruned = await pruneBackups(2, { prefix: PREFIX, store });

    expect(pruned).toHaveLength(3);
    const left = await listBackups({ prefix: PREFIX, store });
    expect(left).toHaveLength(2);
    expect(left.map((b) => b.key)).toEqual([keys[4], keys[3]]);
    // the deleted runs took their payloads with them, not just their manifests
    expect([...blobStore.keys()].filter((k) => k.startsWith(keys[0]))).toEqual([]);
  });

  it('never deletes anything when keep is larger than the number of backups', async () => {
    await seedRealisticData();
    await createBackup({ prefix: PREFIX, store, appVersion: 'test' });
    expect(await pruneBackups(14, { prefix: PREFIX, store })).toEqual([]);
    expect(await listBackups({ prefix: PREFIX, store })).toHaveLength(1);
  });
});

describe('app-folder namespacing', () => {
  it('derives the app folder from the app name, not a hardcoded string', () => {
    expect(APP_FOLDER).toBe('seamless/');
    expect(config.appFolder).toBe(`${config.appName}/`);
    expect(normalizePrefix('seamless/')).toBe('seamless/');
  });

  it('keeps a backup inside the app folder even when no prefix is passed at all', async () => {
    await seedRealisticData();
    // the caller-forgot-a-prefix path: engine's own default must not be a bare "backup/"
    const m = await createBackup({ store, appVersion: 'test' });
    expect(m.key.startsWith(APP_FOLDER)).toBe(true);
    expect([...blobStore.keys()].some((k) => k.startsWith('backup/'))).toBe(false);
  });

  it('cannot be escaped by an absolute or traversing prefix', () => {
    expect(normalizePrefix('/')).toBe(APP_FOLDER);
    expect(normalizePrefix('//rooted')).toBe('seamless/rooted/');
    expect(normalizePrefix('backup/')).toBe('seamless/backup/');
    // every result stays under the app folder, whatever went in
    for (const p of ['', '/', 'x', 'a/b', 'seamless', 'seamless/x', 'backup/']) {
      expect(normalizePrefix(p).startsWith(APP_FOLDER)).toBe(true);
    }
  });

  it.each([
    ['nightly', 'seamless/nightly/'],
    ['nightly/', 'seamless/nightly/'],
    ['/nightly', 'seamless/nightly/'],
    ['backup/', 'seamless/backup/'],
    ['seamless/nightly/', 'seamless/nightly/'],   // already namespaced: left alone
    ['', 'seamless/'],
    ['/', 'seamless/'],
  ])('normalizes %o -> %o', (input, expected) => {
    expect(normalizePrefix(input)).toBe(expected);
  });

  it('writes a real backup inside the app folder', async () => {
    await seedRealisticData();
    const m = await createBackup({ prefix: normalizePrefix('nightly'), store, appVersion: 'test' });
    expect(m.key.startsWith('seamless/nightly/')).toBe(true);
    const keys = await store.list('seamless/');
    expect(keys.some((k) => k.endsWith('manifest.json'))).toBe(true);
    expect(keys.every((k) => k.startsWith(APP_FOLDER))).toBe(true);
  });
});

describe('failure alert recipients', () => {
  it('accepts a single address', () => {
    expect(alertRecipients('you@example.com')).toEqual(['you@example.com']);
  });

  it('accepts several, comma-separated', () => {
    expect(alertRecipients('a@x.com,b@y.com,c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });

  it.each([
    ['a@x.com, b@y.com', ['a@x.com', 'b@y.com']],                   // comma + space
    ['a@x.com;b@y.com', ['a@x.com', 'b@y.com']],                     // semicolon (Outlook paste)
    ['a@x.com\nb@y.com', ['a@x.com', 'b@y.com']],                    // newline
    ['  a@x.com ,, b@y.com , ', ['a@x.com', 'b@y.com']],             // stray commas and padding
    ['a@x.com, a@x.com', ['a@x.com']],                               // duplicate collapses
    ['a@x.com, not-an-email, b@y.com', ['a@x.com', 'b@y.com']],      // junk dropped, rest survive
    ['', []],
    ['   ', []],
  ])('parses %o', (input, expected) => {
    expect(alertRecipients(input)).toEqual(expected);
  });

  it('drops junk rather than handing the mailer a list it will reject wholesale', () => {
    // one bad address must not cost the good ones their alert
    expect(alertRecipients('garbage, ops@example.com')).toEqual(['ops@example.com']);
  });
});

describe('schedule', () => {
  const cfg = (over: Partial<BackupConfig> = {}): BackupConfig => ({
    enabled: true, frequency: 'daily', hour: 2, keep: 14, prefix: PREFIX, alertEmail: '', everyHours: 6, includeEmails: false, ...over,
  });
  const at = (iso: string) => new Date(iso).getTime();
  const HOUR = 3_600_000;

  it('never fires while disabled', () => {
    expect(isDue(null, cfg({ enabled: false }), at('2026-07-14T02:00:00Z'))).toBe(false);
  });

  it('takes a first backup immediately once enabled', () => {
    expect(isDue(null, cfg(), at('2026-07-14T17:43:00Z'))).toBe(true);
  });

  it('fires in the configured hour once the interval has elapsed', () => {
    const last = at('2026-07-13T02:00:00Z');
    expect(isDue(last, cfg(), at('2026-07-14T02:05:00Z'))).toBe(true);
    // right hour, but not enough time has passed
    expect(isDue(at('2026-07-14T01:30:00Z'), cfg(), at('2026-07-14T02:05:00Z'))).toBe(false);
    // enough time has passed, but it is not the slot hour
    expect(isDue(last, cfg(), at('2026-07-14T09:00:00Z'))).toBe(false);
  });

  it('catches up after a missed slot instead of waiting a full cycle', () => {
    // server was down through 02:00 and only came back at 09:00 two days later
    expect(isDue(at('2026-07-12T02:00:00Z'), cfg(), at('2026-07-14T09:00:00Z'))).toBe(true);
  });

  it('fires twice a day on the hour and twelve hours later', () => {
    const c = cfg({ frequency: 'twice_daily', hour: 2 });
    const last = at('2026-07-14T02:00:00Z');
    expect(isDue(last, c, at('2026-07-14T14:00:00Z'))).toBe(true);   // +12h slot
    expect(isDue(last, c, at('2026-07-14T08:00:00Z'))).toBe(false);  // not a slot
  });

  it.each([
    ['twice_daily', 12], ['daily', 24], ['every_2_days', 48], ['twice_weekly', 84], ['weekly', 168],
  ] as const)('%s waits %i hours between runs', (frequency, hours) => {
    expect(INTERVAL_HOURS[frequency]).toBe(hours);
    const last = at('2026-07-14T02:00:00Z');
    const c = cfg({ frequency, hour: 2 });
    // one minute short of the interval, in a slot hour: still not due
    expect(isDue(last, c, last + hours * HOUR - 60_000)).toBe(false);
  });

  it('reports the next due time in the configured slot', () => {
    const next = nextDueAt(at('2026-07-14T02:00:00Z'), cfg(), at('2026-07-14T10:00:00Z'));
    expect(new Date(next).toISOString()).toBe('2026-07-15T02:00:00.000Z');
  });

  it('reports the nearer of the two twice-daily slots', () => {
    const next = nextDueAt(at('2026-07-14T02:00:00Z'), cfg({ frequency: 'twice_daily' }), at('2026-07-14T10:00:00Z'));
    expect(new Date(next).toISOString()).toBe('2026-07-14T14:00:00.000Z');
  });
});
