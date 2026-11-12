/**
 * Critical alerts (T8.9): "a mailbox stopped working".
 *
 *   problem seen ─raiseAlert()─► alerts row (one open per problem) ─► every enabled, verified channel in parallel
 *   problem gone ─resolveAlerts()─► row resolved + a one-line "recovered" message
 *
 * Triggers are polled by `runAlertChecks()` once a minute (it reads the same health numbers the Health page shows).
 * A failed channel never blocks the others; failed sends are retried with backoff; one message per alert, then a
 * reminder every N hours while it is still open and unread. Quiet hours do not apply.
 */
import { q, one, run, getSetting, setSetting, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { isViewing } from '../mode.ts';
import { syncManager } from '../imap/sync.ts';
import { storageProbe, backupHealth } from '../health/status.ts';
import { userUsageBytes } from '../admin/quota.ts';
import { adapter, makeHttp, ChannelError, type AlertMessage, type ChannelDeps } from './channels/index.ts';
import { readConfig, type ChannelRow } from './store.ts';

// ---------- settings ----------
export interface AlertSettings {
  /** consecutive failed syncs before a mailbox alert */
  syncFailures: number;
  /** minutes without a successful sync (while failing) before a mailbox alert */
  syncStaleMinutes: number;
  /** failed sends in the last hour before a "sending is failing" alert */
  sendFailures: number;
  /** storage used, % of quota */
  quotaPercent: number;
  /** hours of silence on a Cloudflare push inbox that used to receive mail; 0 = don't check */
  pushSilentHours: number;
  /** hours between reminders while open; 0 = never */
  reminderHours: number;
}
export const ALERT_DEFAULTS: AlertSettings = { syncFailures: 3, syncStaleMinutes: 15, sendFailures: 3, quotaPercent: 95, pushSilentHours: 48, reminderHours: 6 };
const KEY = 'alerts_cfg';

export async function getAlertSettings(): Promise<AlertSettings> {
  try { return { ...ALERT_DEFAULTS, ...JSON.parse((await getSetting(KEY)) || '{}') }; } catch { return { ...ALERT_DEFAULTS }; }
}
export async function setAlertSettings(patch: Partial<AlertSettings>): Promise<AlertSettings> {
  const cur = await getAlertSettings();
  const clamp = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
  const next: AlertSettings = {
    syncFailures: clamp(patch.syncFailures ?? cur.syncFailures, 1, 100, cur.syncFailures),
    syncStaleMinutes: clamp(patch.syncStaleMinutes ?? cur.syncStaleMinutes, 1, 1440, cur.syncStaleMinutes),
    sendFailures: clamp(patch.sendFailures ?? cur.sendFailures, 1, 100, cur.sendFailures),
    quotaPercent: clamp(patch.quotaPercent ?? cur.quotaPercent, 50, 100, cur.quotaPercent),
    pushSilentHours: clamp(patch.pushSilentHours ?? cur.pushSilentHours, 0, 720, cur.pushSilentHours),
    reminderHours: clamp(patch.reminderHours ?? cur.reminderHours, 0, 168, cur.reminderHours),
  };
  await setSetting(KEY, JSON.stringify(next));
  return next;
}

// ---------- types ----------
export interface AlertSource { type: string; id: string | number; accountId?: number | null; link?: string | null }
export interface AlertRow {
  id: number; user_id: number; kind: string; source_type: string; source_id: string; severity: 'critical'; title: string; body: string; link: string | null;
  account_id: number | null; state: 'open' | 'resolved'; read_at: string | number | null; opened_at: string | number; resolved_at: string | number | null;
  last_sent_at: string | number | null; send_count: number; attempts: number; next_attempt_at: string | number | null; recovered_sent: boolean;
  deliveries: Record<string, Delivery>;
}
export interface Delivery { ok: boolean; at: number; error?: string; message: 'open' | 'reminder' | 'recovered'; name: string; kind: string }

export interface EngineDeps { http?: ChannelDeps['http']; sendMail?: ChannelDeps['sendMail'] }
let testDeps: EngineDeps = {};
/** Tests only: replace the network. Call with no argument to restore. */
export function setAlertDepsForTests(d: EngineDeps = {}): void { testDeps = d; }
export function testHttp(): ChannelDeps['http'] | undefined { return testDeps.http; }

const BACKOFF_MS = [60_000, 120_000, 300_000, 900_000, 1_800_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

const oneLine = (s: string, n = 300) => s.replace(/\s+/g, ' ').trim().slice(0, n);
export function messageFor(a: Pick<AlertRow, 'title' | 'body' | 'account_id'>, kind: 'open' | 'reminder' | 'recovered'): AlertMessage {
  if (kind === 'recovered') {
    const t = `Fixed: ${a.title}`;
    return { title: t, body: 'This problem has been fixed. No action needed.', text: oneLine(`[Seamless] ${t}`), excludeAccountId: null };
  }
  const prefix = kind === 'reminder' ? 'STILL BROKEN' : 'CRITICAL';
  return { title: a.title, body: a.body, text: oneLine(`[Seamless] ${prefix}: ${a.title}${a.body ? ` — ${a.body}` : ''}`), excludeAccountId: a.account_id };
}

async function allowList(): Promise<string[]> { return (await q<{ cidr_or_host: string }>('SELECT cidr_or_host FROM webhook_allowlist')).map((r) => r.cidr_or_host); }

/** Channels that should hear about this alert: the user's own, plus team channels for shared mailboxes and instance-level
 *  problems. A team channel hears each problem once: for a shared mailbox via the owner's alert, for an instance problem
 *  via the first admin's alert (every other recipient's copy is in-app and on their own channels only). */
async function channelsFor(a: AlertRow): Promise<ChannelRow[]> {
  let team = false;
  if (a.account_id) {
    const acct = await one<{ user_id: number }>('SELECT user_id FROM accounts WHERE id = ?', [a.account_id]);
    team = !!acct && acct.user_id === a.user_id && !!(await one('SELECT 1 FROM mailbox_shares WHERE account_id = ? LIMIT 1', [a.account_id]));
  } else if (a.source_type === 'instance') {
    const first = await one<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND disabled = false ORDER BY id LIMIT 1");
    team = first?.id === a.user_id;
  }
  return q<ChannelRow>(`SELECT * FROM alert_channels WHERE enabled = true AND verified_at IS NOT NULL
                        AND (user_id = ? OR (scope = 'team' AND ?)) ORDER BY id`, [a.user_id, team]);
}

/** Send one message through one channel; records last_ok_at / last_error on the channel. Throws on failure. */
export async function sendThroughChannel(ch: ChannelRow, msg: AlertMessage, record = true): Promise<void> {
  const ad = adapter(ch.kind);
  if (!ad) throw new ChannelError(`unknown channel type ${ch.kind}`);
  const deps: ChannelDeps = { http: testDeps.http ?? makeHttp(await allowList()), sendMail: testDeps.sendMail, userId: ch.user_id };
  try {
    await ad.send(readConfig(ch), msg, deps);
    if (record) await run('UPDATE alert_channels SET last_ok_at = ?, last_error = NULL WHERE id = ?', [Date.now(), ch.id]);
  } catch (e: any) {
    if (record) await run('UPDATE alert_channels SET last_error = ? WHERE id = ?', [String(e?.message ?? e).slice(0, 500), ch.id]);
    throw e;
  }
}

async function load(id: number): Promise<AlertRow | null> { return (await one<AlertRow>('SELECT * FROM alerts WHERE id = ?', [id])) ?? null; }

/** Deliver to the given channels in parallel and record per-channel results. Returns how many succeeded / failed. */
async function deliver(a: AlertRow, kind: 'open' | 'reminder' | 'recovered', channels: ChannelRow[], now: number): Promise<{ ok: number; failed: number }> {
  const msg = messageFor(a, kind);
  const results = await Promise.all(channels.map(async (ch) => {
    try { await sendThroughChannel(ch, msg); return { ch, ok: true as const }; }
    catch (e: any) { return { ch, ok: false as const, error: String(e?.message ?? e).slice(0, 300) }; }
  }));
  const fresh = (await load(a.id))!;
  const deliveries = { ...(fresh.deliveries ?? {}) };
  for (const r of results) deliveries[String(r.ch.id)] = { ok: r.ok, at: now, error: r.ok ? undefined : r.error, message: kind, name: r.ch.name, kind: r.ch.kind };
  await run('UPDATE alerts SET deliveries = ?::jsonb WHERE id = ?', [JSON.stringify(deliveries), a.id]);
  return { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

async function afterChange(userId: number): Promise<void> {
  await bumpState();
  broadcast({ type: 'notifications' }, userId);
  broadcast({ type: 'stateChange' }, userId);
}

/** Open an alert (once per problem) and send it. Returns the row and whether it is new. */
export async function raiseAlert(userId: number, kind: string, source: AlertSource, title: string, body: string, now = Date.now()): Promise<{ alert: AlertRow; created: boolean }> {
  const link = source.link ?? (source.accountId ? `/settings/health` : '/settings/health');
  const ins = await q<{ id: number }>(`INSERT INTO alerts(user_id, kind, source_type, source_id, title, body, link, account_id, opened_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (user_id, kind, source_type, source_id) WHERE state = 'open' DO NOTHING RETURNING id`,
    [userId, kind, source.type, String(source.id), title.slice(0, 200), body.slice(0, 1000), link, source.accountId ?? null, now]);
  if (!ins.length) {
    const cur = (await one<AlertRow>(`SELECT * FROM alerts WHERE user_id = ? AND kind = ? AND source_type = ? AND source_id = ? AND state = 'open'`, [userId, kind, source.type, String(source.id)]))!;
    // same problem, newer detail (e.g. a different error text): keep the row, refresh the text, send nothing
    if (cur.body !== body.slice(0, 1000)) await run('UPDATE alerts SET body = ? WHERE id = ?', [body.slice(0, 1000), cur.id]);
    return { alert: cur, created: false };
  }
  const a = (await load(ins[0].id))!;
  await afterChange(userId);
  await sendOpen(a, now);
  return { alert: (await load(a.id))!, created: true };
}

async function sendOpen(a: AlertRow, now: number): Promise<void> {
  const channels = await channelsFor(a);
  if (!channels.length) return;               // in-app only; the "no channel set up" banner explains
  const r = await deliver(a, 'open', channels, now);
  await settle(a.id, r, now, a.attempts + 1);
}

/** After a send round: success on at least one channel counts as "sent"; if some failed, schedule a retry of just those. */
async function settle(id: number, r: { ok: number; failed: number }, now: number, attempts: number): Promise<void> {
  if (r.ok > 0) await run('UPDATE alerts SET last_sent_at = ?, send_count = send_count + 1 WHERE id = ?', [now, id]);
  if (r.failed > 0 && attempts < MAX_ATTEMPTS) {
    await run('UPDATE alerts SET attempts = ?, next_attempt_at = ? WHERE id = ?', [attempts, now + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)], id]);
  } else {
    await run('UPDATE alerts SET attempts = ?, next_attempt_at = NULL WHERE id = ?', [attempts, id]);
  }
}

/** Mark matching open alerts fixed (all users) and send the one-line "recovered" message. */
export async function resolveAlerts(kind: string, source: { type: string; id: string | number }, now = Date.now(), opts: { notify?: boolean } = {}): Promise<number> {
  const rows = await q<AlertRow>(`UPDATE alerts SET state = 'resolved', resolved_at = ?, next_attempt_at = NULL
      WHERE kind = ? AND source_type = ? AND source_id = ? AND state = 'open' RETURNING *`, [now, kind, source.type, String(source.id)]);
  for (const a of rows) {
    await afterChange(a.user_id);
    if (opts.notify !== false && a.send_count > 0 && !a.recovered_sent) {
      await run('UPDATE alerts SET recovered_sent = true WHERE id = ?', [a.id]);
      const channels = await channelsFor(a);
      if (channels.length) await deliver(a, 'recovered', channels, now);
    }
  }
  return rows.length;
}

/** Retry failed sends and send reminders. */
export async function processDeliveries(now = Date.now()): Promise<void> {
  const cfg = await getAlertSettings();
  // retries: only the channels whose latest delivery failed
  const due = await q<AlertRow>(`SELECT * FROM alerts WHERE state = 'open' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?`, [now]);
  for (const a of due) {
    const channels = (await channelsFor(a)).filter((c) => !a.deliveries?.[String(c.id)]?.ok);
    if (!channels.length) { await run('UPDATE alerts SET next_attempt_at = NULL WHERE id = ?', [a.id]); continue; }
    const r = await deliver(a, 'open', channels, now);
    await settle(a.id, r, now, a.attempts + 1);
  }
  // reminders: still open, unread, and the last send was long enough ago
  if (cfg.reminderHours > 0) {
    const gap = cfg.reminderHours * 3_600_000;
    const rem = await q<AlertRow>(`SELECT * FROM alerts WHERE state = 'open' AND read_at IS NULL AND last_sent_at IS NOT NULL AND next_attempt_at IS NULL AND last_sent_at <= ?`, [now - gap]);
    for (const a of rem) {
      const channels = await channelsFor(a);
      if (!channels.length) continue;
      await run('UPDATE alerts SET last_sent_at = ? WHERE id = ?', [now, a.id]);      // claim first: a slow channel can't cause a double reminder
      const r = await deliver(a, 'reminder', channels, now);
      if (r.ok > 0) await run('UPDATE alerts SET send_count = send_count + 1 WHERE id = ?', [a.id]);
    }
  }
}

// ---------- triggers ----------
const AUTH_ERR = /invalid_grant|unauthori[sz]ed|authenticationfailed|invalid credentials|auth.*fail|token/i;

async function adminIds(): Promise<number[]> { return (await q<{ id: number }>("SELECT id FROM users WHERE role = 'admin' AND disabled = false")).map((r) => r.id); }

/** Owner + every manager of a shared mailbox. */
async function accountRecipients(accountId: number, ownerId: number): Promise<number[]> {
  const mgr = await q<{ user_id: number }>("SELECT user_id FROM mailbox_shares WHERE account_id = ? AND role = 'manager'", [accountId]);
  return [...new Set([ownerId, ...mgr.map((m) => m.user_id)])];
}

const MAILBOX_KINDS = ['mailbox.sync', 'oauth.revoked'];

async function checkMailboxes(now: number, cfg: AlertSettings): Promise<void> {
  const accts = await q<{ id: number; user_id: number; email: string; kind: string | null; enabled: boolean }>(
    `SELECT id, user_id, email, kind, enabled FROM accounts WHERE archived = false AND health_ignored = false AND inbound_kind <> 'none'`);
  const failing = new Set<number>();
  for (const a of accts) {
    if (!a.enabled) continue;
    const st = syncManager.status(a.id);
    if (st.state !== 'error') continue;
    const stale = st.lastSyncAt ? now - st.lastSyncAt >= cfg.syncStaleMinutes * 60_000 : false;
    if (st.failures < cfg.syncFailures && !(stale && st.failures >= 1)) continue;
    failing.add(a.id);
    const oauth = (a.kind === 'gmail' || a.kind === 'microsoft') && AUTH_ERR.test(st.lastError);
    const kind = oauth ? 'oauth.revoked' : 'mailbox.sync';
    const title = oauth ? `${a.email} needs to be signed in again` : `Mailbox ${a.email} stopped working`;
    const body = oauth
      ? `The sign-in for ${a.email} was revoked or expired, so no new mail arrives. Reconnect it in Settings → Mailboxes.`
      : `${a.email} could not be reached after ${st.failures} tries. Last error: ${oneLine(st.lastError, 160) || 'unknown'}. Mail is not arriving.`;
    for (const u of await accountRecipients(a.id, a.user_id)) {
      await raiseAlert(u, kind, { type: 'account', id: a.id, accountId: a.id, link: '/settings/health' }, title, body, now);
    }
  }
  // fixed: any open mailbox alert whose mailbox is no longer failing (recovered, paused, deleted or set to ignore)
  const open = await q<{ kind: string; source_id: string }>(`SELECT DISTINCT kind, source_id FROM alerts WHERE state = 'open' AND source_type = 'account' AND kind = ANY(?::text[])`, [MAILBOX_KINDS]);
  for (const o of open) if (!failing.has(Number(o.source_id))) await resolveAlerts(o.kind, { type: 'account', id: o.source_id }, now);
}

async function checkSending(now: number, cfg: AlertSettings): Promise<void> {
  const rows = await q<{ user_id: number; c: string }>(`SELECT user_id, COUNT(*) AS c FROM events WHERE type = 'send.failed' AND created_at > ? GROUP BY user_id`, [now - 3_600_000]);
  const bad = new Set<number>();
  for (const r of rows) {
    if (Number(r.c) < cfg.sendFailures) continue;
    bad.add(r.user_id);
    await raiseAlert(r.user_id, 'send.failing', { type: 'user', id: r.user_id, link: '/settings/health' }, 'Sending mail keeps failing',
      `${r.c} messages failed to send in the last hour. Check the outgoing server settings of your mailboxes.`, now);
  }
  for (const o of await q<{ source_id: string }>(`SELECT DISTINCT source_id FROM alerts WHERE state = 'open' AND kind = 'send.failing'`)) {
    if (!bad.has(Number(o.source_id))) await resolveAlerts('send.failing', { type: 'user', id: o.source_id }, now);
  }
}

async function checkAiBacklog(now: number): Promise<void> {
  const { aiHealth } = await import('../classify/memory.ts');
  const bad = new Set<number>();
  for (const u of await q<{ user_id: number }>("SELECT DISTINCT user_id FROM messages WHERE classify_state = 'pending' AND created_at < ?", [now - 30 * 60_000])) {
    const h = await aiHealth(u.user_id, now);
    if (!h.stuck) continue;
    bad.add(u.user_id);
    await raiseAlert(u.user_id, 'ai.backlog', { type: 'user', id: u.user_id, link: '/settings/health' }, 'AI backlog stuck',
      `${h.waiting} messages have been waiting for the AI for over 30 minutes and the AI provider is failing: ${oneLine(h.lastError?.message ?? 'unknown error', 160)}. Check Settings → AI, then press Retry now on the Health page.`, now);
  }
  for (const o of await q<{ source_id: string }>(`SELECT DISTINCT source_id FROM alerts WHERE state = 'open' AND kind = 'ai.backlog'`)) {
    if (!bad.has(Number(o.source_id))) await resolveAlerts('ai.backlog', { type: 'user', id: o.source_id }, now);
  }
}

async function checkInstance(now: number): Promise<void> {
  const admins = await adminIds();
  const p = await storageProbe(now);
  for (const a of admins) {
    if (!p.ok) await raiseAlert(a, 'storage.unreachable', { type: 'instance', id: 'mail' }, 'Mail storage is unreachable', `The mail storage bucket does not answer: ${oneLine(p.error, 160)}. New mail cannot be saved and old mail cannot be opened.`, now);
  }
  if (p.ok) await resolveAlerts('storage.unreachable', { type: 'instance', id: 'mail' }, now);

  const b = await backupHealth(now);
  const backupBad = b.enabled && b.status === 'red';
  for (const a of admins) {
    if (backupBad) await raiseAlert(a, 'backup.failed', { type: 'instance', id: 'backup' }, 'Backups are failing or overdue', b.note, now);
  }
  if (!backupBad) await resolveAlerts('backup.failed', { type: 'instance', id: 'backup' }, now);
}

async function checkQuota(now: number, cfg: AlertSettings): Promise<void> {
  const users = await q<{ id: number; email: string; storage_quota_bytes: string }>('SELECT id, email, storage_quota_bytes FROM users WHERE storage_quota_bytes IS NOT NULL AND disabled = false');
  const full = new Set<number>();
  const admins = await adminIds();
  for (const u of users) {
    const quota = Number(u.storage_quota_bytes);
    if (!quota) continue;
    const used = await userUsageBytes(u.id, { now });
    const pct = Math.round((used / quota) * 100);
    if (pct < cfg.quotaPercent) continue;
    full.add(u.id);
    for (const r of new Set([u.id, ...admins])) {
      await raiseAlert(r, 'quota.full', { type: 'user', id: u.id, link: '/settings/users' }, r === u.id ? 'Your storage is almost full' : `${u.email}'s storage is almost full`,
        `${pct}% of the storage quota is used. When it is full, new mail may stop arriving. Free space or ask an administrator for more.`, now);
    }
  }
  for (const o of await q<{ source_id: string }>(`SELECT DISTINCT source_id FROM alerts WHERE state = 'open' AND kind = 'quota.full'`)) {
    if (!full.has(Number(o.source_id))) await resolveAlerts('quota.full', { type: 'user', id: o.source_id }, now);
  }
}

/** A Cloudflare push inbox that used to deliver mail but has been silent for N hours. */
async function checkPushSilent(now: number, cfg: AlertSettings): Promise<void> {
  if (cfg.pushSilentHours <= 0) { return; }
  const rows = await q<{ account_id: number; user_id: number; email: string; last: string }>(
    `SELECT a.id AS account_id, a.user_id, a.email, MAX(s.created_at) AS last FROM push_inboxes p JOIN accounts a ON a.id = p.account_id
     JOIN push_seen s ON s.account_id = a.id WHERE a.enabled = true AND a.archived = false AND a.health_ignored = false GROUP BY a.id, a.user_id, a.email`);
  const silent = new Set<number>();
  for (const r of rows) {
    if (now - Number(r.last) < cfg.pushSilentHours * 3_600_000) continue;
    silent.add(r.account_id);
    for (const u of await accountRecipients(r.account_id, r.user_id)) {
      await raiseAlert(u, 'inbound.silent', { type: 'account', id: r.account_id, accountId: r.account_id, link: '/settings/mailboxes' }, `No mail has arrived at ${r.email} for ${cfg.pushSilentHours} hours`,
        `The Cloudflare email worker for ${r.email} has not delivered anything since ${new Date(Number(r.last)).toISOString().slice(0, 16).replace('T', ' ')} UTC. Check that the worker and its route are still active.`, now);
    }
  }
  for (const o of await q<{ source_id: string }>(`SELECT DISTINCT source_id FROM alerts WHERE state = 'open' AND kind = 'inbound.silent'`)) {
    if (!silent.has(Number(o.source_id))) await resolveAlerts('inbound.silent', { type: 'account', id: o.source_id }, now);
  }
}

let checking = false;
/** One pass over every trigger, then retries and reminders. Safe to call often. */
export async function runAlertChecks(now = Date.now()): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const cfg = await getAlertSettings();
    if (!isViewing()) {
      // a Viewing-mode copy fetches and sends nothing, so there is nothing to be "down"
      await checkMailboxes(now, cfg).catch(logErr('mailboxes'));
      await checkSending(now, cfg).catch(logErr('sending'));
      if (!isViewing()) await checkAiBacklog(now).catch(logErr('ai'));
      await checkPushSilent(now, cfg).catch(logErr('push'));
    }
    await checkInstance(now).catch(logErr('instance'));
    await checkQuota(now, cfg).catch(logErr('quota'));
    await processDeliveries(now).catch(logErr('delivery'));
  } finally { checking = false; }
}
const logErr = (what: string) => (e: any) => console.error(`[alerts] ${what} check failed:`, e?.message ?? e);

let timer: NodeJS.Timeout | null = null;
export function startAlertEngine(): void {
  if (timer) return;
  const tick = () => { void runAlertChecks().catch(logErr('run')); };
  setTimeout(tick, 45_000);
  timer = setInterval(tick, 60_000);
  timer.unref?.();
}

/** "Send test alert": a fake alert that goes through the whole path (row, channels, bell), then counts as fixed. */
export async function raiseTestAlert(userId: number, now = Date.now()): Promise<AlertRow> {
  const { alert } = await raiseAlert(userId, 'test', { type: 'test', id: String(now), link: '/settings/alerts' },
    'Test alert — nothing is wrong', 'This is a test of your critical alerts. If you can read this on your phone or inbox, alerts work.', now);
  await run("UPDATE alerts SET state = 'resolved', resolved_at = ?, recovered_sent = true WHERE id = ?", [now, alert.id]);
  await afterChange(userId);
  return (await load(alert.id))!;
}
