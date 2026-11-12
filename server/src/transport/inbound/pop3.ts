import { assertLive } from '../../mode.ts';
/**
 * POP3 polling (F-23). `pollPop3(accountId)`: UIDL → fetch only unseen → ingestLocal(inbox, live)
 * → remember in pop3_seen. Deletion on the server only ever happens for messages we have
 * verifiably stored (row exists + blob readable).
 */
import { q, one, run } from '../../db.ts';
import { decrypt } from '../../crypto.ts';
import { getBlob } from '../../s3.ts';
import { ingestLocal } from '../../mail/localbox.ts';
import { syncManager, type AccountRow, type NewMailEvent } from '../../imap/sync.ts';
import { Pop3Client } from './pop3client.ts';

export interface PollResult { fetched: number; deleted: number; error: string | null }

const DAY = 86_400_000;
const running = new Set<number>();

async function verifiedStored(rowId: number | null): Promise<boolean> {
  if (!rowId) return false;
  const row = await one<{ s3_key: string | null }>('SELECT s3_key FROM messages WHERE id = ?', [rowId]);
  if (!row?.s3_key) return false;
  try { await getBlob(row.s3_key); return true; } catch { return false; }
}

export function pop3ClientFor(acct: AccountRow, timeoutMs?: number): Pop3Client {
  return new Pop3Client({
    host: acct.pop3_host ?? '', port: acct.pop3_port ?? 995, secure: !!acct.pop3_secure,
    starttls: !acct.pop3_secure, timeoutMs,
  });
}

export async function pollPop3(accountId: number): Promise<PollResult> {
  assertLive('receiving mail');
  const acct = await one<AccountRow>("SELECT * FROM accounts WHERE id = ? AND inbound_kind = 'pop3'", [accountId]);
  if (!acct) return { fetched: 0, deleted: 0, error: 'not a POP3 account' };
  if (running.has(accountId)) return { fetched: 0, deleted: 0, error: null };
  running.add(accountId);
  const prev = syncManager.status(accountId);
  let fetched = 0, deleted = 0;
  const client = pop3ClientFor(acct);
  try {
    await client.connect();
    await client.auth(acct.pop3_user ?? '', decrypt(acct.pop3_pass_enc ?? ''));
    const ids = await client.uidl(); // n → uidl
    const seen = new Map((await q<{ uidl: string; fetched_at: string; message_row_id: number | null }>(
      'SELECT uidl, fetched_at, message_row_id FROM pop3_seen WHERE account_id = ?', [accountId])).map((r) => [r.uidl, r]));

    for (const [n, uidl] of [...ids.entries()].sort((a, b) => a[0] - b[0])) {
      if (seen.has(uidl)) continue;
      const raw = await client.retr(n);
      const result = await ingestLocal(accountId, 'inbox', raw, { isLive: true });
      await run(
        'INSERT INTO pop3_seen(account_id, uidl, fetched_at, message_row_id) VALUES (?,?,?,?) ON CONFLICT DO NOTHING',
        [accountId, uidl, Date.now(), result?.rowId ?? null]);
      fetched++;
      if (result) {
        seen.set(uidl, { uidl, fetched_at: String(Date.now()), message_row_id: result.rowId });
        if (result.isInboxLive) {
          syncManager.emit('newMail', {
            accountId, userId: acct.user_id, rowId: result.rowId, mailboxRole: 'inbox',
            from: result.parsed.from?.text ?? '', subject: result.parsed.subject ?? '',
            aiCategorize: !!acct.ai_categorize,
          } satisfies NewMailEvent);
        }
        if (acct.pop3_leave_on_server === false && await verifiedStored(result.rowId)) {
          await client.dele(n); deleted++;
        }
      }
    }

    // delete-after-N-days: only old, still-on-server, verifiably stored messages
    if (acct.pop3_leave_on_server !== false && acct.pop3_delete_after_days && acct.pop3_delete_after_days > 0) {
      const cutoff = Date.now() - acct.pop3_delete_after_days * DAY;
      for (const [n, uidl] of ids) {
        const s = seen.get(uidl);
        if (!s || Number(s.fetched_at) > cutoff) continue;
        if (!(await verifiedStored(s.message_row_id))) continue;
        await client.dele(n); deleted++;
      }
    }

    await client.quit();
    syncManager.setStatus(accountId, { state: 'ok', lastSyncAt: Date.now(), lastError: '', failures: 0 });
    if (fetched > 0) { syncManager.emit('changed', acct.user_id); }
    return { fetched, deleted, error: null };
  } catch (err: any) {
    await client.quit().catch(() => {});
    const msg = String(err?.message ?? err);
    syncManager.setStatus(accountId, { state: 'error', lastSyncAt: prev.lastSyncAt, lastError: msg, failures: prev.failures + 1 });
    return { fetched, deleted, error: msg };
  } finally {
    running.delete(accountId);
  }
}

// ---- scheduler: one timer per POP3 account, honouring pop3_interval_min ----
const timers = new Map<number, NodeJS.Timeout>();

function schedule(acct: AccountRow): void {
  const every = Math.max(1, acct.pop3_interval_min ?? 5) * 60_000;
  const tick = async () => {
    await pollPop3(acct.id).catch((e) => console.error('[pop3] poll failed:', e?.message ?? e));
    if (timers.has(acct.id)) timers.set(acct.id, setTimeout(tick, every));
  };
  timers.set(acct.id, setTimeout(tick, 1000));
}

syncManager.registerInbound('pop3', {
  start(acct) {
    syncManager.setStatus(acct.id, { state: 'connecting', lastSyncAt: null, lastError: '', failures: 0 });
    schedule(acct);
  },
  stop(accountId) {
    const t = timers.get(accountId);
    if (t) clearTimeout(t);
    timers.delete(accountId);
  },
  kick(accountId) {
    if (timers.has(accountId)) void pollPop3(accountId);
  },
});
