import { syncAccountIdentities } from '../src/business/identities.ts';
import { vi } from 'vitest';

// in-memory S3 stand-in shared by all tests
export const blobStore = new Map<string, Buffer>();

vi.mock('../src/s3.ts', () => {
  // defined inside the factory: vi.mock is hoisted above every top-level const
  const put = async (key: string, body: Buffer) => { blobStore.set(key, body); };
  const get = async (key: string) => {
    const b = blobStore.get(key);
    if (!b) throw new Error(`no blob ${key}`);
    return b;
  };
  const list = async (prefix: string) => [...blobStore.keys()].filter((k) => k.startsWith(prefix)).sort();
  const del = async (key: string) => { blobStore.delete(key); };
  const store = { put, get, list, del, bucket: 'seamless', ensure: async () => {}, headBucket: async () => {} };
  // the mail store is repointable in production; the tests only need it to remember what it
  // was pointed at, so a restore can adopt the config the backup brought back
  let cfg = {
    endpoint: 'http://localhost:9100', region: 'us-east-1', bucket: 'seamless',
    accessKey: 'seamless', secretKey: 'seamless-secret', forcePathStyle: true,
  };
  // the mail store honours cfg.keyPrefix (the backup mirror), the backup store never does
  const mp = () => (cfg as any).keyPrefix ?? '';
  const mput = (k: string, b: Buffer, ct?: string) => put(mp() + k, b);
  const mget = (k: string) => get(mp() + k);
  const mlist = async (p: string) => (await list(mp() + p)).map((k) => k.slice(mp().length));
  const mdel = (k: string) => del(mp() + k);
  const mailStore = { put: mput, get: mget, list: mlist, del: mdel, bucket: 'seamless', ensure: async () => {}, headBucket: async () => {} };
  return {
    ensureBucket: async () => {},
    putBlob: mput, getBlob: mget, listKeys: mlist, deleteBlob: mdel,
    mailStore, backupStore: store, s3Store: mailStore,
    withKeyPrefix: (inner: any, prefix: string) => ({
      ...inner,
      put: (k: string, b: Buffer, ct?: string) => inner.put(prefix + k, b, ct),
      get: (k: string) => inner.get(prefix + k),
      del: (k: string) => inner.del(prefix + k),
      list: async (p: string) => (await inner.list(prefix + p)).map((k: string) => k.slice(prefix.length)),
    }),
    makeStore: () => store,
    backupSharesMailBucket: true,
    mailStoreConfig: () => ({ ...cfg }),
    mailStoreLocation: () => ({ endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, forcePathStyle: cfg.forcePathStyle }),
    setMailStore: (next: typeof cfg) => { cfg = { ...next }; },
    setBackupStore: (_next: typeof cfg) => {},
    backupStoreConfig: () => ({ ...cfg }),
  };
});

import { run, insertId } from '../src/db.ts';
import { encrypt, hashPassword } from '../src/crypto.ts';
import { ingestMessage } from '../src/mail/ingest.ts';

export let TEST_USER = 0;

/** Wipe all data and recreate the default test user. */
export async function resetDb(): Promise<void> {
  // audit_log is append-only by trigger; the test reset is one of the two places allowed to clear it
  const { pool } = await import('../src/db.ts');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL seamless.audit_prune = 'on'");
    await c.query('TRUNCATE audit_log RESTART IDENTITY');
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  await run('TRUNCATE users RESTART IDENTITY CASCADE');
  await run('TRUNCATE tracking_opens, op_queue, scheduled_sends, jobs, storage_targets, storage_migrations, storage_migration_items RESTART IDENTITY');
  await run("DELETE FROM settings WHERE key = 'state' OR key LIKE 'alert:%'");
  TEST_USER = await insertId('INSERT INTO users(email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)',
    ['test@local', 'Test User', hashPassword('password123'), 'admin', Date.now()]);
}

export async function makeUser(email: string, role: 'admin' | 'member' = 'member'): Promise<number> {
  return insertId('INSERT INTO users(email, name, password_hash, role, created_at) VALUES (?,?,?,?,?)',
    [email, email.split('@')[0], hashPassword('password123'), role, Date.now()]);
}

export async function makeAccount(email: string, opts: { aliases?: string[]; name?: string; userId?: number } = {}): Promise<number> {
  const id = await insertId(`
    INSERT INTO accounts(user_id, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc,
      smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [opts.userId ?? TEST_USER, opts.name ?? email.split('@')[0], email, JSON.stringify(opts.aliases ?? []),
    'imap.test', 993, true, email, encrypt('pw'), 'smtp.test', 465, true, email, encrypt('pw'), Date.now()]);
  await syncAccountIdentities(id);
  return id;
}

export async function makeMailbox(accountId: number, path: string, role: string | null): Promise<number> {
  return insertId('INSERT INTO mailboxes(account_id, path, role, name) VALUES (?,?,?,?)', [accountId, path, role, path]);
}

let uidCounter = 100;

export function rawEmail(opts: {
  from: string; to: string; subject: string; body?: string; html?: string;
  messageId?: string; inReplyTo?: string; references?: string[]; deliveredTo?: string; date?: string;
  cc?: string;
}): Buffer {
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Subject: ${opts.subject}`,
    `Date: ${opts.date ?? 'Wed, 08 Jul 2026 10:00:00 +0000'}`,
    `Message-ID: ${opts.messageId ?? `<${Math.random().toString(36).slice(2)}@test>`}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references?.length ? [`References: ${opts.references.join(' ')}`] : []),
    ...(opts.deliveredTo ? [`Delivered-To: ${opts.deliveredTo}`] : []),
  ];
  if (opts.html) {
    lines.push('MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', opts.html);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', opts.body ?? 'hello body');
  }
  return Buffer.from(lines.join('\r\n'));
}

export async function ingest(accountId: number, mailboxId: number, raw: Buffer, opts: {
  flags?: string[]; isLive?: boolean; uid?: number;
} = {}) {
  return ingestMessage({
    accountId,
    mailboxId,
    uid: opts.uid ?? uidCounter++,
    raw,
    flags: new Set(opts.flags ?? []),
    internalDate: new Date(),
    isLive: opts.isLive ?? false,
  });
}
