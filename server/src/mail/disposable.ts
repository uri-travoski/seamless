/**
 * Disposable addresses (T3 F-25): aliases on a push-inbound / catch-all domain that can be paused,
 * disposed (mail dropped), expired and watched for leaks. Mail is matched by delivered-to / To.
 */
import { randomInt } from 'node:crypto';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { emitEvent } from '../events/emit.ts';
import { broadcast } from '../ws.ts';
import { domainOf, registrable } from './risk.ts';

export const UNDO_WINDOW_MS = 30 * 86_400_000;
export type DisposableStatus = 'active' | 'paused' | 'disposed';
export type Generator = 'random' | 'words' | 'prefix';

export interface DisposableRow {
  id: number; user_id: number; account_id: number; address: string; label: string; purpose: string;
  status: DisposableStatus; expires_at: string | null; forward_to_category: number | null; notify: boolean;
  received_count: number; dropped_count: number; last_received_at: string | null; last_sender: string;
  signup_domain: string | null; leak_domains: string[]; disposed_at: string | null; created_at: string;
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

export async function setStatus(userId: number, id: number, status: DisposableStatus): Promise<DisposableRow | null | undefined> {
  const row = await getDisposable(userId, id);
  if (!row) return null;
  if (status === 'disposed') {
    if (row.status !== 'disposed') await run("UPDATE disposable_addresses SET status = 'disposed', disposed_at = ? WHERE id = ?", [Date.now(), id]);
  } else if (row.status === 'disposed') {
    // undispose: only within the undo window
    if (!row.disposed_at || Date.now() - Number(row.disposed_at) > UNDO_WINDOW_MS) throw new Error('Too late to undo: addresses can be restored for 30 days');
    await run("UPDATE disposable_addresses SET status = ?, disposed_at = NULL, expires_at = CASE WHEN expires_at < ? THEN NULL ELSE expires_at END WHERE id = ?", [status, Date.now(), id]);
  } else {
    await run('UPDATE disposable_addresses SET status = ? WHERE id = ?', [status, id]);
  }
  await changed(userId);
  return getDisposable(userId, id);
}

export const pause = (u: number, id: number) => setStatus(u, id, 'paused');
export const resume = (u: number, id: number) => setStatus(u, id, 'active');
export const dispose = (u: number, id: number) => setStatus(u, id, 'disposed');
export const undispose = (u: number, id: number) => setStatus(u, id, 'active');

export async function stats(userId: number, id: number) {
  const row = await getDisposable(userId, id);
  if (!row) return null;
  const senders = await q<{ domain: string; c: number }>(
    `SELECT lower(split_part(from_addr, '@', 2)) AS domain, COUNT(*)::int AS c FROM messages
     WHERE user_id = ? AND disposable_id = ? GROUP BY 1 ORDER BY c DESC LIMIT 10`, [userId, id]);
  return { received: row.received_count, dropped: row.dropped_count, lastReceivedAt: row.last_received_at ? Number(row.last_received_at) : null,
    signupDomain: row.signup_domain, leakDomains: row.leak_domains, senderDomains: senders };
}

/** Addresses the Worker should reject (signed GET). */
export async function disposedAddressesFor(accountId: number): Promise<string[]> {
  return (await q<{ address: string }>("SELECT address FROM disposable_addresses WHERE account_id = ? AND status = 'disposed' ORDER BY address", [accountId])).map((r) => r.address);
}

/** Find the disposable address (of this account) a message was sent to, trying candidates in order. */
export async function matchAddress(accountId: number, candidates: (string | null | undefined)[]): Promise<DisposableRow | null | undefined> {
  const list = [...new Set(candidates.map((c) => clean(c ?? '')).filter(Boolean))];
  if (list.length === 0) return null;
  const rows = await q<DisposableRow>('SELECT * FROM disposable_addresses WHERE account_id = ? AND address = ANY(?::text[])', [accountId, list]);
  for (const c of list) { const hit = rows.find((r) => r.address === c); if (hit) return hit; }
  return null;
}

/** Endpoint pre-check for push mail: a disposed address is dropped before anything is stored. */
export async function dropIfDisposed(accountId: number, candidates: (string | null | undefined)[]): Promise<boolean> {
  const d = await matchAddress(accountId, candidates);
  if (!d || d.status !== 'disposed') return false;
  await run('UPDATE disposable_addresses SET dropped_count = dropped_count + 1 WHERE id = ?', [d.id]);
  return true;
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

  if (d.status !== 'active') {
    const role = d.status === 'disposed' ? 'trash' : 'archive';
    const target = await one<{ id: number }>('SELECT id FROM mailboxes WHERE account_id = ? AND role = ? ORDER BY id LIMIT 1', [args.accountId, role]);
    if (target) {
      await run('UPDATE messages SET mailbox_id = ?, uid = ?, unread = false WHERE id = ?', [target.id, -args.rowId, args.rowId]);
      if (role === 'trash') await run('UPDATE messages SET trashed_at = ? WHERE id = ?', [now, args.rowId]);
      if (args.uid > 0) {
        const { enqueueOp } = await import('../imap/sync.ts');
        await enqueueOp(args.accountId, 'move', { mailboxId: args.mailboxId, uid: args.uid, targetMailboxId: target.id });
      }
    } else {
      await run('UPDATE messages SET unread = false WHERE id = ?', [args.rowId]);
    }
    return { disposableId: d.id, quiet: true };
  }

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

/** Mark a stored address as expired now (idempotent): used by the job and tests. */
export async function expireDue(id: number): Promise<boolean> {
  const row = await one<DisposableRow>('SELECT * FROM disposable_addresses WHERE id = ?', [id]);
  if (!row || row.status === 'disposed' || !row.expires_at || Number(row.expires_at) > Date.now()) return false;
  await run("UPDATE disposable_addresses SET status = 'disposed', disposed_at = ? WHERE id = ?", [Date.now(), id]);
  await changed(row.user_id);
  return true;
}

registerJob('disposable.expire', async (job) => { await expireDue(Number(job.payload?.id)); });
