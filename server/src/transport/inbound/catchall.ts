import { assertLive } from '../../mode.ts';
/**
 * Catch-all mailbox for disposable addresses (T10.1). An IMAP or POP3 account flagged `catchall` is not synced
 * as a normal mailbox. Every message in it is read, its original recipient found (mail/recipient.ts), and the
 * message routed through the same path as pushed mail (`ingestPush`) into the destination push inbox:
 *   active address → Inbox · stopped → as before · unknown address → the domain's policy (quarantine/deliver/drop).
 * The provider copy is only moved / deleted after the message is verifiably stored, and a message that was
 * stored but not yet moved is never stored twice (catchall_seen + the push dedupe key).
 */
import { ImapFlow } from 'imapflow';
import { q, one, run } from '../../db.ts';
import { decrypt } from '../../crypto.ts';
import { getBlob } from '../../s3.ts';
import { accountAuth } from '../../oauth.ts';
import { detectRecipient } from '../../mail/recipient.ts';
import { purgeQuarantine } from '../../mail/unknown.ts';
import { syncManager, type AccountRow } from '../../imap/sync.ts';
import { ingestPush, type PushInboxRow } from './push.ts';
import { pop3ClientFor } from './pop3.ts';

export const PROCESSED_FOLDER = 'Seamless processed';
export const POP3_EVERY_MS = 2 * 60_000;
const IMAP_POLL_MS = 45_000;
const DAY = 86_400_000;

/** Test hook: throw here to simulate a crash after the message was saved but before it was moved/deleted. */
export const hooks: { beforeFinish?: () => void } = {};

/** Results of "send yourself a test mail" probes, by token. */
export const testResults = new Map<string, { accountId: number; address: string; source: string; at: number }>();
export const TEST_LOCAL = /^seamless-test-([a-z0-9]{8})$/;

export const destInboxFor = (sourceAccountId: number) =>
  one<PushInboxRow>('SELECT * FROM push_inboxes WHERE source_account_id = ?', [sourceAccountId]);

async function verifiedStored(rowId: number | null | undefined): Promise<boolean> {
  if (!rowId) return false;
  const row = await one<{ s3_key: string | null }>('SELECT s3_key FROM messages WHERE id = ?', [rowId]);
  if (!row?.s3_key) return false;
  try { await getBlob(row.s3_key); return true; } catch { return false; }
}

export interface RouteResult { ok: boolean; outcome: string }

/** Route one raw message from the catch-all mailbox. ok=false → leave it at the provider and retry later. */
export async function routeMessage(dest: PushInboxRow, raw: Buffer): Promise<RouteResult> {
  try {
    const known = (await q<{ address: string }>('SELECT address FROM disposable_addresses WHERE account_id = ?', [dest.account_id])).map((r) => r.address);
    const rec = detectRecipient(raw, known, dest.domains);
    const probe = rec ? TEST_LOCAL.exec(rec.address.split('@')[0])?.[1] : null;
    if (probe && rec) {   // a "send yourself a test mail": prove routing, store nothing
      testResults.set(probe, { accountId: dest.account_id, address: rec.address, source: rec.source, at: Date.now() });
      return { ok: true, outcome: 'test' };
    }
    const out = await ingestPush(dest, raw, rec?.address ?? null);
    if (out.status === 500) return { ok: false, outcome: out.error };
    if ('dropped' in out) return { ok: true, outcome: `dropped:${out.reason}` };
    if ('quarantined' in out) return { ok: true, outcome: 'quarantined' };
    if (out.status === 202 || 'duplicate' in out) {
      const id = out.status === 202 ? out.id : out.id;
      if (!(await verifiedStored(id))) return { ok: false, outcome: 'stored message could not be verified' };
      return { ok: true, outcome: out.status === 202 ? 'delivered' : 'duplicate' };
    }
    return { ok: false, outcome: 'unexpected' };
  } catch (err: any) {
    return { ok: false, outcome: String(err?.message || err?.code || err || 'connection failed') };
  }
}

const markSeen = (accountId: number, key: string, handled: boolean, outcome: string) => run(
  `INSERT INTO catchall_seen(account_id, source_key, handled, outcome, created_at) VALUES (?,?,?,?,?)
   ON CONFLICT (account_id, source_key) DO UPDATE SET handled = excluded.handled, outcome = excluded.outcome`,
  [accountId, key, handled, outcome, Date.now()]);

/** One pass at a time per mailbox: the background loop and "Check now" must not route the same message twice. */
const chains = new Map<number, Promise<unknown>>();
export function serialized<T>(accountId: number, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(accountId) ?? Promise.resolve()).catch(() => {}).then(fn);
  chains.set(accountId, next);
  return next;
}

export interface PassResult { routed: number; finished: number; failed: number }

// ---------------------------------------------------------------- IMAP

export function imapPass(client: ImapFlow, acct: AccountRow, dest: PushInboxRow): Promise<PassResult> {
  return serialized(acct.id, () => imapPassNow(client, acct, dest));
}

async function imapPassNow(client: ImapFlow, acct: AccountRow, dest: PushInboxRow): Promise<PassResult> {
  const res: PassResult = { routed: 0, finished: 0, failed: 0 };
  const after = acct.catchall_after ?? 'move';
  const lock = await client.getMailboxLock('INBOX');
  try {
    const mbox = client.mailbox;
    const validity = mbox && typeof mbox !== 'boolean' ? String(mbox.uidValidity ?? 0) : '0';
    const uids = (await client.search({ all: true }, { uid: true })) || [];
    const seen = new Map((await q<{ source_key: string; handled: boolean }>('SELECT source_key, handled FROM catchall_seen WHERE account_id = ?', [acct.id])).map((r) => [r.source_key, r.handled]));
    let processedFolderReady = false;
    for (const uid of uids) {
      const key = `imap:${validity}:${uid}`;
      const done = seen.get(key);
      if (done === true) continue;
      if (done === undefined) {   // not routed yet
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const r = await routeMessage(dest, Buffer.from(msg.source));
        if (!r.ok) { res.failed++; console.error(`[catchall:${acct.email}] uid ${uid} not routed: ${r.outcome}`); continue; }
        await markSeen(acct.id, key, after === 'leave', r.outcome);
        res.routed++;
        if (after === 'leave') continue;
      }
      // saved and verified: now (and only now) touch the provider copy
      try {
        hooks.beforeFinish?.();
        if (after === 'move') {
          if (!processedFolderReady) { await client.mailboxCreate(PROCESSED_FOLDER).catch(() => {}); processedFolderReady = true; }
          await client.messageMove(String(uid), PROCESSED_FOLDER, { uid: true });
        } else {
          await client.messageDelete(String(uid), { uid: true });
        }
        await run('UPDATE catchall_seen SET handled = true WHERE account_id = ? AND source_key = ?', [acct.id, key]);
        res.finished++;
      } catch (err: any) {
        res.failed++;
        console.error(`[catchall:${acct.email}] could not finish uid ${uid}: ${err?.message ?? err}`);
      }
    }
  } finally { lock.release(); }
  return res;
}

/** Delete messages in the processed folder older than N days (provider-side housekeeping). */
export async function cleanProcessed(client: ImapFlow, days: number): Promise<number> {
  if (!(await client.list()).some((m) => m.path === PROCESSED_FOLDER)) return 0;
  const lock = await client.getMailboxLock(PROCESSED_FOLDER);
  try {
    const uids = (await client.search({ before: new Date(Date.now() - days * DAY) }, { uid: true })) || [];
    if (uids.length) await client.messageDelete(uids.join(','), { uid: true });
    return uids.length;
  } finally { lock.release(); }
}

const imapOf = async (acct: AccountRow) => new ImapFlow({
  host: acct.imap_host, port: acct.imap_port, secure: !!acct.imap_secure, auth: await accountAuth(acct), logger: false,
});

// ---------------------------------------------------------------- POP3

export function pop3Pass(accountId: number): Promise<PassResult & { error: string | null }> {
  return serialized(accountId, () => pop3PassNow(accountId));
}

async function pop3PassNow(accountId: number): Promise<PassResult & { error: string | null }> {
  assertLive('receiving mail');
  const acct = await one<AccountRow>("SELECT * FROM accounts WHERE id = ? AND catchall = true AND inbound_kind = 'pop3'", [accountId]);
  const dest = acct ? await destInboxFor(accountId) : null;
  const res = { routed: 0, finished: 0, failed: 0, error: null as string | null };
  if (!acct || !dest) return { ...res, error: 'not a POP3 catch-all mailbox' };
  const del = acct.catchall_after === 'delete';   // POP3 has no folders: `move` is `leave`
  const client = pop3ClientFor(acct);
  try {
    await client.connect();
    await client.auth(acct.pop3_user ?? '', decrypt(acct.pop3_pass_enc ?? ''));
    const ids = await client.uidl();
    const seen = new Map((await q<{ source_key: string; handled: boolean }>('SELECT source_key, handled FROM catchall_seen WHERE account_id = ?', [accountId])).map((r) => [r.source_key, r.handled]));
    for (const [n, uidl] of [...ids.entries()].sort((a, b) => a[0] - b[0])) {
      const key = `pop3:${uidl}`;
      const done = seen.get(key);
      if (done === true) continue;
      if (done === undefined) {
        const r = await routeMessage(dest, await client.retr(n));
        if (!r.ok) { res.failed++; continue; }
        await markSeen(accountId, key, !del, r.outcome);
        res.routed++;
        if (!del) continue;
      }
      try {
        hooks.beforeFinish?.();
        await client.dele(n);
        await run('UPDATE catchall_seen SET handled = true WHERE account_id = ? AND source_key = ?', [accountId, key]);
        res.finished++;
      } catch { res.failed++; }
    }
    await client.quit();
    syncManager.setStatus(accountId, { state: 'ok', lastSyncAt: Date.now(), lastError: '', failures: 0 });
    if (res.routed > 0) syncManager.emit('changed', acct.user_id);
  } catch (err: any) {
    await client.quit().catch(() => {});
    res.error = String(err?.message || err?.code || err || 'connection failed');
    fail(acct, res.error);
  }
  return res;
}

// ---------------------------------------------------------------- driver

function fail(acct: AccountRow, error: string): void {
  const prev = syncManager.status(acct.id);
  const failures = prev.failures + 1;
  syncManager.setStatus(acct.id, { state: 'error', lastSyncAt: prev.lastSyncAt, lastError: error, failures });
  // one blip is normal; report from the second failure in a row (feeds the T8.9 sync.failed alert)
  if (failures === 2) syncManager.emit('syncFailed', { accountId: acct.id, userId: acct.user_id, email: acct.email, error });
}

/** One full connect → route → housekeeping → disconnect pass (used by tests and "Check now"). */
export async function checkNow(accountId: number): Promise<PassResult & { error: string | null }> {
  const acct = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND catchall = true', [accountId]);
  if (!acct) return { routed: 0, finished: 0, failed: 0, error: 'not a catch-all mailbox' };
  if (acct.inbound_kind === 'pop3') return pop3Pass(accountId);
  const dest = await destInboxFor(accountId);
  if (!dest) return { routed: 0, finished: 0, failed: 0, error: 'no destination' };
  const client = await imapOf(acct);
  try {
    await client.connect();
    const r = await imapPass(client, acct, dest);
    syncManager.setStatus(accountId, { state: 'ok', lastSyncAt: Date.now(), lastError: '', failures: 0 });
    if (r.routed > 0) syncManager.emit('changed', acct.user_id);
    return { ...r, error: null };
  } catch (err: any) {
    fail(acct, String(err?.message || err?.code || err || 'connection failed'));
    return { routed: 0, finished: 0, failed: 0, error: String(err?.message || err?.code || err || 'connection failed') };
  } finally { await client.logout().catch(() => {}); }
}

interface Runner { running: boolean; waker: (() => void) | null; timer: NodeJS.Timeout | null; client: ImapFlow | null }
const runners = new Map<number, Runner>();

async function imapLoop(acct: AccountRow, r: Runner): Promise<void> {
  let backoff = 2000;
  let lastClean = 0;
  while (r.running) {
    try {
      const dest = await destInboxFor(acct.id);
      if (!dest) throw new Error('catch-all has no destination inbox');
      const client = r.client = await imapOf(acct);
      client.on('exists', () => r.waker?.());
      client.on('error', () => r.waker?.());
      await client.connect();
      backoff = 2000;
      while (r.running && client.usable) {
        await imapPass(client, acct, dest);
        if (acct.catchall_after === 'move' && Date.now() - lastClean > 3_600_000) {
          lastClean = Date.now();
          await cleanProcessed(client, acct.catchall_clean_days ?? 14).catch(() => 0);
        }
        await purgeQuarantine().catch(() => 0);
        syncManager.setStatus(acct.id, { state: 'ok', lastSyncAt: Date.now(), lastError: '', failures: 0 });
        syncManager.emit('changed', acct.user_id);
        if (r.running && client.usable) {
          const lock = await client.getMailboxLock('INBOX');   // IDLE while we wait for new mail
          try {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, IMAP_POLL_MS);
              r.waker = () => { clearTimeout(t); r.waker = null; resolve(); };
            });
          } finally { r.waker = null; lock.release(); }
        }
      }
      await client.logout().catch(() => {});
    } catch (err: any) {
      if (!r.running) break;
      fail(acct, String(err?.message || err?.code || err || 'connection failed'));
      await new Promise((res) => setTimeout(res, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

function stop(accountId: number): void {
  const r = runners.get(accountId);
  if (!r) return;
  r.running = false;
  if (r.timer) clearTimeout(r.timer);
  r.waker?.();
  r.client?.logout().catch(() => {});
  runners.delete(accountId);
}

syncManager.registerInbound('catchall', {
  start(acct) {
    stop(acct.id);
    syncManager.setStatus(acct.id, { state: 'connecting', lastSyncAt: null, lastError: '', failures: 0 });
    const r: Runner = { running: true, waker: null, timer: null, client: null };
    runners.set(acct.id, r);
    if (acct.inbound_kind === 'pop3') {
      const tick = async () => {
        await pop3Pass(acct.id).catch((e) => console.error('[catchall] pop3 pass failed:', e?.message ?? e));
        await purgeQuarantine().catch(() => 0);
        if (r.running) r.timer = setTimeout(tick, POP3_EVERY_MS);
      };
      r.timer = setTimeout(tick, 1000);
    } else void imapLoop(acct, r);
  },
  stop,
  kick(accountId) {
    const r = runners.get(accountId);
    if (!r) return;
    if (r.waker) r.waker();
    else if (r.timer) { clearTimeout(r.timer); r.timer = setTimeout(() => void pop3Pass(accountId), 0); }
  },
});
