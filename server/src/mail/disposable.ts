/**
 * Disposable addresses (T3 F-25, reworked in T10.2): aliases on a push-inbound / catch-all domain that can be
 * Stopped (mail goes to the Bin for 15 days / 100 mails, then is deleted on arrival) and Started again, whose mail
 * is deleted after a week unless Kept, and that are watched for leaks. Mail is matched by delivered-to / To.
 */
import { randomInt } from 'node:crypto';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { emitEvent } from '../events/emit.ts';
import { broadcast } from '../ws.ts';
import { domainOf, registrable } from './risk.ts';
import { getUserSetting } from '../classify/settings.ts';

const DAY = 86_400_000;
export type DisposableStatus = 'active' | 'stopped';
export type Generator = 'random' | 'words' | 'prefix';

export interface DisposableRow {
  id: number; user_id: number; account_id: number; address: string; label: string; purpose: string;
  status: DisposableStatus; expires_at: string | null; forward_to_category: number | null; notify: boolean;
  received_count: number; dropped_count: number; last_received_at: string | null; last_sender: string;
  signup_domain: string | null; leak_domains: string[]; disposed_at: string | null; created_at: string;
  stopped_at: string | null; stopped_stored: number; keep_all: boolean;
}

const WORDS = (
  'quiet river amber maple cedar harbor ember willow falcon meadow copper linen orchid pebble summit tundra velvet ' +
  'walnut zephyr acorn beacon canyon dune echo fjord glacier hazel island juniper kettle lagoon marble nectar oasis ' +
  'prairie quartz raven saffron thistle umber valley wander yarrow zenith aspen birch cobalt delta elm fern gale ' +
  'heron iris jade kelp lotus mist north opal pine quill reed sage tide ursa vine wren yew zinc alder brook clover ' +
  'drift ember flint grove haven ivory jasper knoll lark moss nimbus olive plume ridge slate tarn upland vista wisp ' +
  'apricot bramble cinder dapple fable gust hollow inlet jostle kindle lumen mosaic nook outpost paddock ripple ' +
  'sparrow thicket umbra velour willet yonder zephyrus anchor bridge candle dawn eagle forest garden horizon indigo ' +
  'jungle kestrel lantern meteor needle orbit pearl quarry rocket shadow timber umbrella voyage whisper xenon yacht ' +
  'zodiac autumn blossom compass dolphin evergreen feather granite harvest iceberg journey kingdom lighthouse mountain ' +
  'nightfall ocean pinecone quicksilver rainbow starlight twilight universe vineyard waterfall sunrise sunset moonlit ' +
  'breeze cloud storm thunder frost snow rain sleet hail dewdrop tulip daisy poppy violet lilac peony aster cactus'
).split(/\s+/).filter(Boolean);

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const rnd = (n: number) => Array.from({ length: n }, () => ALNUM[randomInt(ALNUM.length)]).join('');
const word = () => WORDS[randomInt(WORDS.length)];

export function generateLocalPart(kind: Generator, prefix = ''): string {
  if (kind === 'words') return `${word()}.${word()}`;
  if (kind === 'prefix') {
    const p = prefix.toLowerCase().replace(/[^a-z0-9._-]+/g, '').replace(/^[.-]+|[.-]+$/g, '') || 'x';
    return `${p}.${rnd(2)}`;
  }
  return rnd(6);
}

export const clean = (addr: string) => addr.trim().toLowerCase().replace(/^.*</, '').replace(/>.*$/, '').trim();

/** Domains of the user's push inboxes (the ones that can host disposable addresses). */
export async function listDomains(userId: number): Promise<{ accountId: number; domain: string }[]> {
  const rows = await q<{ account_id: number; domains: string[] }>(
    `SELECT p.account_id, p.domains FROM push_inboxes p JOIN accounts a ON a.id = p.account_id WHERE a.user_id = ? ORDER BY p.created_at`, [userId]);
  return rows.flatMap((r) => r.domains.map((d) => ({ accountId: r.account_id, domain: d })));
}

export interface CreateOpts {
  domain: string; generator?: Generator; prefix?: string; address?: string; label?: string; purpose?: string;
  expiresInDays?: number | null; notify?: boolean;
}

export async function createDisposable(userId: number, o: CreateOpts): Promise<DisposableRow> {
  const domain = o.domain.trim().toLowerCase();
  const host = (await listDomains(userId)).find((d) => d.domain === domain);
  if (!host) throw new Error('That domain is not one of your push-inbound domains');
  let address = '';
  if (o.address) {
    address = clean(o.address);
    if (domainOf(address) !== domain || !/^[a-z0-9._+-]+@/.test(address)) throw new Error('Address must be on the chosen domain');
  } else {
    for (let i = 0; i < 20 && !address; i++) {
      const cand = `${generateLocalPart(o.generator ?? 'random', o.prefix)}@${domain}`;
      if (!(await one('SELECT 1 FROM disposable_addresses WHERE address = ?', [cand]))) address = cand;
    }
    if (!address) throw new Error('Could not find a free address, try again');
  }
  if (await one('SELECT 1 FROM disposable_addresses WHERE address = ?', [address])) throw new Error('That address already exists');
  const now = Date.now();
  const expires = o.expiresInDays ? now + o.expiresInDays * 86_400_000 : null;
  const id = await insertId(
    `INSERT INTO disposable_addresses(user_id, account_id, address, label, purpose, expires_at, notify, created_at) VALUES (?,?,?,?,?,?,?,?)`,
    [userId, host.accountId, address, (o.label ?? '').trim(), (o.purpose ?? '').trim(), expires, o.notify ?? true, now]);
  if (expires) await enqueueJob(userId, 'disposable.expire', expires, { id });
  await changed(userId);
  return (await getDisposable(userId, id))!;
}

export const getDisposable = (userId: number, id: number) =>
  one<DisposableRow>('SELECT * FROM disposable_addresses WHERE id = ? AND user_id = ?', [id, userId]);

export const listDisposable = (userId: number) =>
  q<DisposableRow>('SELECT * FROM disposable_addresses WHERE user_id = ? ORDER BY created_at DESC, id DESC', [userId]);

async function changed(userId: number): Promise<void> {
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
}

export async function updateDisposable(userId: number, id: number, p: { label?: string; purpose?: string; notify?: boolean; expiresAt?: number | null }): Promise<DisposableRow | null | undefined> {
  const row = await getDisposable(userId, id);
  if (!row) return null;
  await run('UPDATE disposable_addresses SET label = ?, purpose = ?, notify = ? WHERE id = ?',
    [p.label ?? row.label, p.purpose ?? row.purpose, p.notify ?? row.notify, id]);
  if (p.expiresAt !== undefined) {
    await run('UPDATE disposable_addresses SET expires_at = ? WHERE id = ?', [p.expiresAt, id]);
    if (p.expiresAt) await enqueueJob(userId, 'disposable.expire', p.expiresAt, { id });
  }
  await changed(userId);
  return getDisposable(userId, id);
}

/** Stop: new mail goes to the Bin for `stop_bin_days` / `stop_cap`, then is deleted on arrival. Starts a fresh window. */
export async function stopAddress(userId: number, id: number): Promise<DisposableRow | null | undefined> {
  const row = await getDisposable(userId, id);
  if (!row) return null;
  if (row.status !== 'stopped') {
    await run("UPDATE disposable_addresses SET status = 'stopped', stopped_at = ?, stopped_stored = 0 WHERE id = ?", [Date.now(), id]);
  }
  await changed(userId);
  return getDisposable(userId, id);
}

/** Start: back to normal delivery. Old Bin mail is not restored; stop again later = a new window and cap. */
export async function startAddress(userId: number, id: number): Promise<DisposableRow | null | undefined> {
  const row = await getDisposable(userId, id);
  if (!row) return null;
  if (row.status !== 'active') {
    await run("UPDATE disposable_addresses SET status = 'active', stopped_at = NULL, stopped_stored = 0, disposed_at = NULL, expires_at = CASE WHEN expires_at < ? THEN NULL ELSE expires_at END WHERE id = ?", [Date.now(), id]);
  }
  await changed(userId);
  return getDisposable(userId, id);
}

/** Keep one message from the one-week deletion (sets the protection, clears the countdown). */
export async function keepMessage(userId: number, rowId: number): Promise<boolean> {
  const r = await one<{ id: number }>(
    "UPDATE messages SET keep_reason = 'kept by user', delete_at = NULL WHERE id = ? AND user_id = ? AND disposable_id IS NOT NULL RETURNING id", [rowId, userId]);
  if (r) await changed(userId);
  return !!r;
}

/** Keep everything from this address, including mail that arrives later. */
export async function keepAllFrom(userId: number, id: number): Promise<number | null> {
  const row = await getDisposable(userId, id);
  if (!row) return null;
  await run('UPDATE disposable_addresses SET keep_all = true WHERE id = ?', [id]);
  const kept = await q<{ id: number }>(
    "UPDATE messages SET keep_reason = 'kept by user', delete_at = NULL WHERE user_id = ? AND disposable_id = ? AND keep_reason IS NULL RETURNING id", [userId, id]);
  await changed(userId);
  return kept.length;
}

export async function stats(userId: number, id: number) {
  const row = await getDisposable(userId, id);
  if (!row) return null;
  const senders = await q<{ domain: string; c: number }>(
    `SELECT lower(split_part(from_addr, '@', 2)) AS domain, COUNT(*)::int AS c FROM messages
     WHERE user_id = ? AND disposable_id = ? GROUP BY 1 ORDER BY c DESC LIMIT 10`, [userId, id]);
  return { received: row.received_count, lastReceivedAt: row.last_received_at ? Number(row.last_received_at) : null,
    signupDomain: row.signup_domain, leakDomains: row.leak_domains, senderDomains: senders };
}

/** Stopped addresses the Worker should reject at the door — only when the domain opted in ("Reject stopped addresses at the door"). */
export async function disposedAddressesFor(accountId: number): Promise<string[]> {
  const on = await one<{ reject_stopped: boolean }>('SELECT bool_or(reject_stopped) AS reject_stopped FROM push_inboxes WHERE account_id = ?', [accountId]);
  if (!on?.reject_stopped) return [];
  return (await q<{ address: string }>("SELECT address FROM disposable_addresses WHERE account_id = ? AND status = 'stopped' ORDER BY address", [accountId])).map((r) => r.address);
}

/** Find the disposable address (of this account) a message was sent to, trying candidates in order. */
export async function matchAddress(accountId: number, candidates: (string | null | undefined)[]): Promise<DisposableRow | null | undefined> {
  const list = [...new Set(candidates.map((c) => clean(c ?? '')).filter(Boolean))];
  if (list.length === 0) return null;
  const rows = await q<DisposableRow>('SELECT * FROM disposable_addresses WHERE account_id = ? AND address = ANY(?::text[])', [accountId, list]);
  for (const c of list) { const hit = rows.find((r) => r.address === c); if (hit) return hit; }
  return null;
}

/**
 * Endpoint pre-check for push mail to a stopped address. Returns true = delete on arrival (nothing stored, no counter,
 * no event, no audit row): the Bin window (`stop_bin_days`) or cap (`stop_cap`) is used up. Otherwise the stored
 * counter is reserved atomically and the mail continues into the Bin.
 */
export async function dropIfStopped(accountId: number, candidates: (string | null | undefined)[]): Promise<boolean> {
  const d = await matchAddress(accountId, candidates);
  if (!d || d.status !== 'stopped') return false;
  const days = Math.max(0, Number(await getUserSetting(d.user_id, 'stop_bin_days')) || 15);
  const cap = Math.max(0, Number(await getUserSetting(d.user_id, 'stop_cap')) || 100);
  const now = Date.now();
  const ok = await one<{ id: number }>(
    `UPDATE disposable_addresses SET stopped_stored = stopped_stored + 1
     WHERE id = ? AND status = 'stopped' AND stopped_stored < ? AND COALESCE(stopped_at, 0) + ? > ? RETURNING id`,
    [d.id, cap, days * DAY, now]);
  return !ok;
}

/**
 * After a message row is stored: link it to its disposable address and apply the status.
 * Returns what the caller should do (`quiet` = no new-mail notification, `moved` = it left the Inbox).
 */
export async function applyOnIngest(args: {
  userId: number; accountId: number; rowId: number; mailboxId: number; uid: number; fromAddr: string; fromName: string;
  candidates: (string | null | undefined)[]; isInbox: boolean;
}): Promise<{ disposableId: number; quiet: boolean } | null> {
  const d = await matchAddress(args.accountId, args.candidates);
  if (!d) return null;
  const now = Date.now();
  await run('UPDATE messages SET disposable_id = ? WHERE id = ?', [d.id, args.rowId]);
  const sender = args.fromAddr.toLowerCase();
  await run(`UPDATE disposable_addresses SET received_count = received_count + 1, last_received_at = ?, last_sender = ?,
             signup_domain = COALESCE(signup_domain, ?) WHERE id = ?`, [now, sender, registrable(domainOf(sender)) || null, d.id]);
  if (!args.isInbox) return { disposableId: d.id, quiet: true };

  if (d.status === 'stopped') {
    // stopped: into the Bin, read, no notification; normal Trash retention applies
    const target = await one<{ id: number }>("SELECT id FROM mailboxes WHERE account_id = ? AND role = 'trash' ORDER BY id LIMIT 1", [args.accountId]);
    if (target) {
      await run('UPDATE messages SET mailbox_id = ?, uid = ?, unread = false, trashed_at = ? WHERE id = ?', [target.id, -args.rowId, now, args.rowId]);
      if (args.uid > 0) {
        const { enqueueOp } = await import('../imap/sync.ts');
        await enqueueOp(args.accountId, 'move', { mailboxId: args.mailboxId, uid: args.uid, targetMailboxId: target.id });
      }
    } else {
      await run('UPDATE messages SET unread = false WHERE id = ?', [args.rowId]);
    }
    return { disposableId: d.id, quiet: true };
  }

  // one-week rule: the sweep moves it to the Bin at delete_at, unless the user keeps it
  const expireDays = Math.min(90, Math.max(1, Number(await getUserSetting(args.userId, 'disposable_expire_days')) || 7));
  if (d.keep_all) await run("UPDATE messages SET keep_reason = 'kept by user' WHERE id = ?", [args.rowId]);
  else await run('UPDATE messages SET delete_at = ? WHERE id = ?', [now + expireDays * DAY, args.rowId]);

  // leak detection: mail from a registrable domain other than the one that first wrote to this address
  const reg = registrable(domainOf(sender));
  const signup = d.signup_domain ?? reg;
  if (reg && signup && reg !== signup && !d.leak_domains.includes(reg)) {
    const first = await one<{ leak_domains: string[] }>(
      `UPDATE disposable_addresses SET leak_domains = array_append(leak_domains, ?) WHERE id = ? AND NOT (? = ANY(leak_domains)) RETURNING leak_domains`, [reg, d.id, reg]);
    if (first) {
      await emitEvent(args.userId, 'disposable.leak', { type: 'disposable', id: d.id },
        { disposableId: d.id, address: d.address, label: d.label, signupDomain: signup, senderDomain: reg, messageId: args.rowId, accountId: args.accountId })
        .catch((err) => console.error('[disposable] leak event failed:', err?.message ?? err));
    }
  }
  return { disposableId: d.id, quiet: false };
}

/** Stop an address whose expiry time has come (idempotent): used by the job and tests. */
export async function expireDue(id: number): Promise<boolean> {
  const row = await one<DisposableRow>('SELECT * FROM disposable_addresses WHERE id = ?', [id]);
  if (!row || row.status === 'stopped' || !row.expires_at || Number(row.expires_at) > Date.now()) return false;
  await run("UPDATE disposable_addresses SET status = 'stopped', stopped_at = ?, stopped_stored = 0 WHERE id = ?", [Date.now(), id]);
  await changed(row.user_id);
  return true;
}

registerJob('disposable.expire', async (job) => { await expireDue(Number(job.payload?.id)); });

/**
 * Automatic cleanup (no manual delete button): addresses stopped for more than `stopped_delete_days` (default 183,
 * 0 = never) are removed with their leftover Bin mail. A deleted address that gets mail again is an unknown address.
 */
export async function cleanupStopped(now = Date.now()): Promise<number> {
  let removed = 0;
  for (const u of await q<{ id: number }>('SELECT id FROM users')) {
    const days = Number(await getUserSetting(u.id, 'stopped_delete_days'));
    if (!(days > 0)) continue;
    const old = await q<{ id: number }>("SELECT id FROM disposable_addresses WHERE user_id = ? AND status = 'stopped' AND stopped_at IS NOT NULL AND stopped_at < ?", [u.id, now - days * DAY]);
    if (old.length === 0) continue;
    const { destroyEmail } = await import('./store.ts');
    for (const a of old) {
      const bin = await q<{ id: number }>(
        "SELECT m.id FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id WHERE m.disposable_id = ? AND mb.role = 'trash'", [a.id]);
      for (const m of bin) await destroyEmail(u.id, `m${m.id}`).catch((e) => console.error('[disposable] cleanup:', e?.message ?? e));
      await run('DELETE FROM disposable_addresses WHERE id = ?', [a.id]);
      removed++;
    }
    await changed(u.id);
  }
  return removed;
}
