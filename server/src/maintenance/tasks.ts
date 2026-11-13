/**
 * Database maintenance tasks (T10.3). Every task has one `exec(ctx)`: with `ctx.dryRun` it only counts what it would
 * free (that is `estimate()`), otherwise it does it (`run()`). Defaults never touch mail, contacts, labels, rules or
 * anything else the user created — only logs, finished jobs, expired tokens, orphans and the like.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pool, q, one, clientQuery } from '../db.ts';
import { config } from '../config.ts';
import { mailStore } from '../s3.ts';
import { ABSOLUTE_MS, pruneExpiredSessions } from '../auth/sessions.ts';
import { pruneAudit, retentionDays as auditRetentionDays } from '../audit/log.ts';
import { cleanupStopped } from '../mail/disposable.ts';
import { purgeQuarantine } from '../mail/unknown.ts';
import { getUserSetting } from '../classify/settings.ts';
import { ident } from '../backup/engine.ts';

const DAY = 86_400_000;
export const BATCH = 5000;
const STATEMENT_TIMEOUT = '120s';

export interface TaskCtx {
  now: number;
  dryRun: boolean;
  retentionDays: number | null;
  autoDelete: boolean;
  trigger: 'auto' | 'manual';
  /** pause between delete batches (ms) */
  pauseMs: number;
  opts: Record<string, any>;
}
export interface TaskResult { rows: number; bytes: number; details: Record<string, any> }

export interface TaskDef {
  id: string;
  name: string;
  /** one line: what it removes */
  removes: string;
  /** one line: the default schedule, for people */
  scheduleText: string;
  defaultIntervalHours: number;
  defaultRetentionDays: number | null;
  /** label for the retention number ("days", "days (finished)") — null when the task has none */
  retentionLabel: string | null;
  /** never runs by itself (VACUUM FULL) */
  manualOnly?: boolean;
  /** included in "Run all safe cleanups" */
  safe: boolean;
  exec(ctx: TaskCtx): Promise<TaskResult>;
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const ret = (ctx: TaskCtx, fallback: number) => Math.max(1, ctx.retentionDays ?? fallback);

/** Average on-disk bytes per row of a table (from planner statistics), for "bytes it would free". */
export async function avgRowBytes(table: string): Promise<number> {
  const r = await one<{ b: number | null }>(
    `SELECT CASE WHEN c.reltuples > 0 THEN pg_table_size(c.oid)::float8 / c.reltuples ELSE NULL END AS b FROM pg_class c WHERE c.oid = ?::regclass`, [`public.${table}`]);
  return r?.b && r.b > 0 ? r.b : 120;
}

/**
 * Delete rows of `table` (aliased `t` inside `where`) in batches of ≤ 5,000 with a pause between, each batch in its own
 * short transaction with a statement timeout. Dry-run only counts.
 */
export async function purge(ctx: TaskCtx, table: string, where: string, params: unknown[]): Promise<{ rows: number; bytes: number }> {
  const perRow = await avgRowBytes(table);
  if (ctx.dryRun) {
    const c = await one<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${table} t WHERE ${where}`, params);
    const rows = c?.c ?? 0;
    return { rows, bytes: Math.round(rows * perRow) };
  }
  let total = 0;
  for (;;) {
    const client = await pool.connect();
    let n = 0;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      const r = await clientQuery<{ c: number }>(client,
        `WITH d AS (DELETE FROM ${table} WHERE ctid IN (SELECT t.ctid FROM ${table} t WHERE ${where} LIMIT ${BATCH}) RETURNING 1) SELECT COUNT(*)::int AS c FROM d`, params);
      n = r[0]?.c ?? 0;
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    total += n;
    if (n < BATCH) break;
    await sleep(ctx.pauseMs);
  }
  return { rows: total, bytes: Math.round(total * perRow) };
}

/** Run several purges and fold them into one result (details.tables = rows removed per table, used by VACUUM). */
async function purges(ctx: TaskCtx, list: { table: string; where: string; params: unknown[]; label?: string }[]): Promise<TaskResult> {
  const out: TaskResult = { rows: 0, bytes: 0, details: { tables: {} } };
  for (const p of list) {
    const r = await purge(ctx, p.table, p.where, p.params);
    out.rows += r.rows; out.bytes += r.bytes;
    out.details.tables[p.label ?? p.table] = r.rows;
  }
  return out;
}

// ─── the cleanup tasks ─────────────────────────────────────────────────────────

const sessions: TaskDef = {
  id: 'sessions', name: 'Expired sessions', removes: 'Sign-ins that expired or were revoked.',
  scheduleText: 'every 6 hours', defaultIntervalHours: 6, defaultRetentionDays: null, retentionLabel: null, safe: true,
  async exec(ctx) {
    if (!ctx.dryRun) {
      const n = await pruneExpiredSessions(ctx.now);
      return { rows: n, bytes: Math.round(n * (await avgRowBytes('sessions'))), details: { tables: { sessions: n } } };
    }
    return purges(ctx, [{ table: 'sessions', where: "t.expires_at <= ? OR (t.created_at <= ? AND t.client = '')", params: [ctx.now, ctx.now - ABSOLUTE_MS] }]);
  },
};

const jobs: TaskDef = {
  id: 'jobs', name: 'Finished jobs', removes: 'Background jobs that finished (done 7 days, failed 30 days).',
  scheduleText: 'daily', defaultIntervalHours: 24, defaultRetentionDays: 7, retentionLabel: 'days (done); failed are kept 4× longer', safe: true,
  async exec(ctx) {
    const done = ret(ctx, 7), failed = Math.round(done * 30 / 7);
    return purges(ctx, [{ table: 'jobs',
      where: "(t.status IN ('done','cancelled') AND t.finished_at < ?) OR (t.status = 'failed' AND t.finished_at < ?)",
      params: [ctx.now - done * DAY, ctx.now - failed * DAY] }]);
  },
};

const disposable: TaskDef = {
  id: 'disposable', name: 'Stopped disposable addresses', removes: 'Addresses stopped for more than 6 months (with their leftover Bin mail) and expired unknown-address quarantine.',
  scheduleText: 'daily', defaultIntervalHours: 24, defaultRetentionDays: null, retentionLabel: null, safe: true,
  async exec(ctx) {
    let addresses = 0, held = 0;
    for (const u of await q<{ id: number }>('SELECT id FROM users')) {
      const days = Number(await getUserSetting(u.id, 'stopped_delete_days'));
      if (days > 0) {
        const c = await one<{ c: number }>("SELECT COUNT(*)::int AS c FROM disposable_addresses WHERE user_id = ? AND status = 'stopped' AND stopped_at IS NOT NULL AND stopped_at < ?", [u.id, ctx.now - days * DAY]);
        addresses += c?.c ?? 0;
      }
      const qd = Math.max(1, Number(await getUserSetting(u.id, 'unknown_days')) || 7);
      const h = await one<{ c: number }>('SELECT COUNT(*)::int AS c FROM quarantined_mail WHERE user_id = ? AND received_at < ?', [u.id, ctx.now - qd * DAY]);
      held += h?.c ?? 0;
    }
    if (!ctx.dryRun) {
      addresses = await cleanupStopped(ctx.now);
      held = await purgeQuarantine(ctx.now);
    }
    return { rows: addresses + held, bytes: 0, details: { addresses, quarantined: held } };
  },
};

const seen: TaskDef = {
  id: 'seen', name: 'Seen-uid tables', removes: 'Remembered message ids for mail the provider no longer holds (older than 60 days). Never while the message is still on the server.',
  scheduleText: 'weekly', defaultIntervalHours: 168, defaultRetentionDays: 60, retentionLabel: 'days', safe: true,
  async exec(ctx) {
    const c = ctx.now - ret(ctx, 60) * DAY;
    return purges(ctx, [
      { table: 'push_seen', where: 't.created_at < ?', params: [c] },
      // POP3 that leaves mail on the server needs the UIDL list to avoid fetching it twice: keep those
      { table: 'pop3_seen', where: 't.fetched_at < ? AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.pop3_leave_on_server = true)', params: [c] },
      // catch-all copies are moved/deleted after saving (not in "leave" mode); unfinished ones are never removed
      { table: 'catchall_seen', where: "t.handled = true AND t.created_at < ? AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = t.account_id AND a.catchall_after = 'leave')", params: [c] },
    ]);
  },
};

const events: TaskDef = {
  id: 'events', name: 'Events', removes: 'The notification event log, older than 90 days.',
  scheduleText: 'weekly', defaultIntervalHours: 168, defaultRetentionDays: 90, retentionLabel: 'days', safe: true,
  async exec(ctx) { return purges(ctx, [{ table: 'events', where: 't.created_at < ?', params: [ctx.now - ret(ctx, 90) * DAY] }]); },
};

const notifications: TaskDef = {
  id: 'notifications', name: 'Notifications', removes: 'Read notifications older than 90 days, unread ones older than 180. Open alerts are never touched.',
  scheduleText: 'weekly', defaultIntervalHours: 168, defaultRetentionDays: 90, retentionLabel: 'days (read); unread are kept 2× longer', safe: true,
  async exec(ctx) {
    const read = ret(ctx, 90);
    return purges(ctx, [{ table: 'notifications',
      where: '(t.read_at IS NOT NULL AND COALESCE(t.updated_at, t.created_at) < ?) OR (t.read_at IS NULL AND COALESCE(t.updated_at, t.created_at) < ?)',
      params: [ctx.now - read * DAY, ctx.now - read * 2 * DAY] }]);
  },
};

const alerts: TaskDef = {
  id: 'alerts', name: 'Resolved alerts', removes: 'Alerts that are resolved and already read, older than 90 days. Open alerts stay.',
  scheduleText: 'weekly', defaultIntervalHours: 168, defaultRetentionDays: 90, retentionLabel: 'days', safe: true,
  async exec(ctx) {
    return purges(ctx, [{ table: 'alerts', where: "t.state = 'resolved' AND t.read_at IS NOT NULL AND COALESCE(t.resolved_at, t.opened_at) < ?", params: [ctx.now - ret(ctx, 90) * DAY] }]);
  },
};

const webhooks: TaskDef = {
  id: 'webhooks', name: 'Webhook deliveries', removes: 'Delivery records: delivered ones after 30 days, failed or given-up ones after 60.',
  scheduleText: 'weekly', defaultIntervalHours: 168, defaultRetentionDays: 30, retentionLabel: 'days (delivered); failed are kept 2× longer', safe: true,
  async exec(ctx) {
    const ok = ret(ctx, 30);
    return purges(ctx, [{ table: 'webhook_deliveries',
      where: "(t.status = 'ok' AND t.created_at < ?) OR (t.status IN ('failed','giving_up') AND t.created_at < ?)",
      params: [ctx.now - ok * DAY, ctx.now - ok * 2 * DAY] }]);
  },
};

const processingLogs: TaskDef = {
  id: 'processing_logs', name: 'Processing logs', removes: 'Rule, filter and AI processing log lines older than 60 days.',
  scheduleText: 'weekly', defaultIntervalHours: 168, defaultRetentionDays: 60, retentionLabel: 'days', safe: true,
  async exec(ctx) { return purges(ctx, [{ table: 'processing_logs', where: 't.created_at < ?', params: [ctx.now - ret(ctx, 60) * DAY] }]); },
};

const trackingOpens: TaskDef = {
  id: 'tracking_opens', name: 'Tracking opens', removes: 'Raw open rows older than a year are folded into one summary row per message (totals and last-open time are kept).',
  scheduleText: 'monthly', defaultIntervalHours: 720, defaultRetentionDays: 365, retentionLabel: 'days', safe: true,
  async exec(ctx) {
    const cutoff = ctx.now - ret(ctx, 365) * DAY;
    const perRow = await avgRowBytes('tracking_opens');
    const where = "ts < ? AND client IS DISTINCT FROM 'archived'";
    if (ctx.dryRun) {
      const c = await one<{ c: number; groups: number }>(`SELECT COUNT(*)::int AS c, COUNT(DISTINCT (token, proxied))::int AS groups FROM tracking_opens WHERE ${where}`, [cutoff]);
      const rows = Math.max(0, (c?.c ?? 0) - (c?.groups ?? 0));
      return { rows, bytes: Math.round(rows * perRow), details: { tables: { tracking_opens: rows } } };
    }
    let removed = 0;
    for (;;) {
      const client = await pool.connect();
      let n = 0, made = 0;
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        const r = await clientQuery<{ deleted: number; made: number }>(client, `
          WITH old AS (DELETE FROM tracking_opens WHERE id IN (SELECT id FROM tracking_opens WHERE ${where} ORDER BY id LIMIT ${BATCH}) RETURNING token, proxied, ts, n),
               agg AS (SELECT token, proxied, SUM(n)::int AS n, MAX(ts) AS ts FROM old GROUP BY token, proxied),
               ins AS (INSERT INTO tracking_opens(token, ts, ip, ua, client, proxied, n) SELECT token, ts, '', '', 'archived', proxied, n FROM agg RETURNING 1)
          SELECT (SELECT COUNT(*) FROM old)::int AS deleted, (SELECT COUNT(*) FROM ins)::int AS made`, [cutoff]);
        n = r[0]?.deleted ?? 0; made = r[0]?.made ?? 0;
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
      removed += n - made;
      if (n < BATCH) break;
      await sleep(ctx.pauseMs);
    }
    return { rows: removed, bytes: Math.round(removed * perRow), details: { tables: { tracking_opens: removed } } };
  },
};

const bounces: TaskDef = {
  id: 'bounces', name: 'Bounces', removes: 'Bounce records older than 180 days.',
  scheduleText: 'monthly', defaultIntervalHours: 720, defaultRetentionDays: 180, retentionLabel: 'days', safe: true,
  async exec(ctx) { return purges(ctx, [{ table: 'bounces', where: 't.created_at < ?', params: [ctx.now - ret(ctx, 180) * DAY] }]); },
};

const devices: TaskDef = {
  id: 'devices', name: 'Stale devices', removes: 'Phones and browsers registered for push that were not seen for 90 days.',
  scheduleText: 'weekly', defaultIntervalHours: 168, defaultRetentionDays: 90, retentionLabel: 'days', safe: true,
  async exec(ctx) {
    const c = ctx.now - ret(ctx, 90) * DAY;
    return purges(ctx, [
      { table: 'mobile_devices', where: 'COALESCE(t.last_seen_at, t.created_at) < ?', params: [c] },
      // browser push subscriptions have no "last seen": old ones whose owner has not signed in since are stale
      { table: 'push_subscriptions', where: 't.created_at < ? AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = t.user_id AND s.last_seen_at >= ?)', params: [c, c] },
    ]);
  },
};

const apiTokens: TaskDef = {
  id: 'api_tokens', name: 'Dead API tokens', removes: 'API tokens revoked or expired more than 90 days ago.',
  scheduleText: 'monthly', defaultIntervalHours: 720, defaultRetentionDays: 90, retentionLabel: 'days', safe: true,
  async exec(ctx) {
    const c = ctx.now - ret(ctx, 90) * DAY;
    return purges(ctx, [{ table: 'api_tokens', where: '(t.revoked_at IS NOT NULL AND t.revoked_at < ?) OR (t.expires_at IS NOT NULL AND t.expires_at < ?)', params: [c, c] }]);
  },
};

const orphanRows: TaskDef = {
  id: 'orphan_rows', name: 'Orphan rows', removes: 'Search, attachment-text, vector, label and AI rows that point at messages that no longer exist.',
  scheduleText: 'weekly', defaultIntervalHours: 168, defaultRetentionDays: null, retentionLabel: null, safe: true,
  async exec(ctx) {
    const gone = (col: string) => `NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = t.${col})`;
    return purges(ctx, [
      { table: 'message_fts', where: gone('message_id'), params: [] },
      { table: 'attachment_text', where: gone('message_id'), params: [] },
      { table: 'email_vectors', where: gone('message_id'), params: [] },
      { table: 'message_labels', where: gone('message_id'), params: [] },
      { table: 'ai_decisions', where: gone('email_id'), params: [] },
    ]);
  },
};

const audit: TaskDef = {
  id: 'audit', name: 'Audit log', removes: 'Audit entries older than the audit retention (Settings → Audit log, default 730 days).',
  scheduleText: 'daily', defaultIntervalHours: 24, defaultRetentionDays: null, retentionLabel: null, safe: true,
  async exec(ctx) {
    const days = await auditRetentionDays();
    if (ctx.dryRun) {
      const c = await one<{ c: number }>('SELECT COUNT(*)::int AS c FROM audit_log WHERE created_at < ?', [ctx.now - days * DAY]);
      const rows = c?.c ?? 0;
      return { rows, bytes: Math.round(rows * (await avgRowBytes('audit_log'))), details: { retentionDays: days } };
    }
    const n = await pruneAudit(ctx.now);
    return { rows: n, bytes: Math.round(n * (await avgRowBytes('audit_log'))), details: { retentionDays: days, tables: { audit_log: n } } };
  },
};

// ─── orphaned files ────────────────────────────────────────────────────────────

/** Prefixes of the mail bucket this app writes; anything else (backups, mirrors, a shared bucket's other users) is never listed. */
export const MAIL_PREFIXES = ['msg/', 'outbound/', 'scheduled/', 'quarantine/', 'logo/'];
export const uploadsDir = () => path.join(config.dataDir, 'uploads');

export interface OrphanItem { kind: 'blob' | 'file'; key: string; size: number; modified: number }

/** Of `keys`, the ones some row still points at (messages, scheduled sends, quarantine, archives, logos, queued appends). */
export async function referencedKeys(keys: string[]): Promise<Set<string>> {
  const used = new Set<string>();
  if (!keys.length) return used;
  const rows = await q<{ k: string }>(`
    SELECT s3_key AS k FROM messages WHERE s3_key = ANY(?::text[])
    UNION SELECT s3_key FROM scheduled_sends WHERE s3_key = ANY(?::text[])
    UNION SELECT s3_key FROM quarantined_mail WHERE s3_key = ANY(?::text[])
    UNION SELECT s3_key FROM mail_archive_items WHERE s3_key = ANY(?::text[])
    UNION SELECT logo_key FROM businesses WHERE logo_key = ANY(?::text[])`, [keys, keys, keys, keys, keys]);
  for (const r of rows) used.add(r.k);
  return used;
}

async function queuedKeys(): Promise<Set<string>> {
  const set = new Set<string>();
  for (const r of await q<{ payload: string }>("SELECT payload FROM op_queue WHERE payload LIKE '%s3Key%'")) {
    try { const k = JSON.parse(r.payload)?.s3Key; if (typeof k === 'string') set.add(k); } catch { /* not JSON */ }
  }
  return set;
}

/** Everything in the mail bucket's own prefixes (and the uploads folder) that nothing references and is older than `minAgeDays`. */
export async function findOrphans(now: number, minAgeDays: number): Promise<{ items: OrphanItem[]; scanned: number }> {
  const minAge = Math.max(1, minAgeDays) * DAY;
  const items: OrphanItem[] = [];
  let scanned = 0;
  const queued = await queuedKeys();
  if (!mailStore.listInfo) throw new Error('this storage cannot list object ages, so orphaned files cannot be found safely');
  for (const prefix of MAIL_PREFIXES) {
    const all = await mailStore.listInfo(prefix);
    for (let i = 0; i < all.length; i += 1000) {
      const chunk = all.slice(i, i + 1000);
      scanned += chunk.length;
      const used = await referencedKeys(chunk.map((o) => o.key));
      for (const o of chunk) {
        if (used.has(o.key) || queued.has(o.key)) continue;
        if (!(now - o.modified >= minAge)) continue;      // too recent (or unknown age): never an orphan
        items.push({ kind: 'blob', key: o.key, size: o.size, modified: o.modified });
      }
    }
  }
  try {
    for (const f of fs.readdirSync(uploadsDir())) {
      const st = fs.statSync(path.join(uploadsDir(), f));
      if (!st.isFile()) continue;
      scanned++;
      if (now - st.mtimeMs >= minAge) items.push({ kind: 'file', key: `uploads/${f}`, size: st.size, modified: st.mtimeMs });
    }
  } catch { /* no uploads folder */ }
  return { items, scanned };
}

const orphanFiles: TaskDef = {
  id: 'orphan_files', name: 'Orphan files', removes: 'Mail-bucket objects and upload files that no message references, older than 7 days. The weekly run only reports; deleting needs your confirmation (or the "delete automatically" tick).',
  scheduleText: 'weekly report, delete on request', defaultIntervalHours: 168, defaultRetentionDays: 7, retentionLabel: 'days old at least', safe: false,
  async exec(ctx) {
    const { items, scanned } = await findOrphans(ctx.now, ret(ctx, 7));
    const bytes = items.reduce((s, i) => s + i.size, 0);
    const preview = items.slice(0, 500).map((i) => ({ kind: i.kind, key: i.key, size: i.size, modified: i.modified }));
    if (ctx.dryRun) return { rows: items.length, bytes, details: { scanned, found: items.length, items: preview, truncated: items.length > preview.length } };

    // delete: only what was asked for (when keys are given) and re-checked right now
    const wanted = Array.isArray(ctx.opts.keys) ? new Set<string>(ctx.opts.keys.map(String)) : null;
    const todo = items.filter((i) => !wanted || wanted.has(i.key));
    const blobs = todo.filter((i) => i.kind === 'blob');
    const still = await referencedKeys(blobs.map((b) => b.key));        // a message may have arrived since the scan
    let rows = 0, freed = 0, failed = 0;
    for (const i of todo) {
      if (i.kind === 'blob' && still.has(i.key)) continue;
      try {
        if (i.kind === 'blob') await mailStore.del(i.key);
        else fs.unlinkSync(path.join(uploadsDir(), i.key.slice('uploads/'.length)));
        rows++; freed += i.size;
      } catch { failed++; }
    }
    return { rows, bytes: freed, details: { scanned, deleted: rows, failed } };
  },
};

// ─── statistics, vacuum, reindex ───────────────────────────────────────────────

export interface TableStat { name: string; sizeBytes: number; rows: number; dead: number; deadPct: number }

export async function tableStats(): Promise<TableStat[]> {
  const rows = await q<{ name: string; size: string; live: string; dead: string }>(
    `SELECT relname AS name, pg_total_relation_size(relid) AS size, n_live_tup AS live, n_dead_tup AS dead FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY pg_total_relation_size(relid) DESC`);
  return rows.map((r) => {
    const live = Number(r.live), dead = Number(r.dead);
    return { name: r.name, sizeBytes: Number(r.size), rows: live, dead, deadPct: live + dead > 0 ? Math.round((dead / (live + dead)) * 1000) / 10 : 0 };
  });
}

/** Tables worth a VACUUM: more than 20 % dead rows (and at least 50), or touched by a big delete recently. */
export function pickVacuumTables(stats: TableStat[], bigDeletes: Record<string, number> = {}): string[] {
  return stats.filter((t) => (t.deadPct > 20 && t.dead >= 50) || (bigDeletes[t.name] ?? 0) >= 10_000).map((t) => t.name);
}

async function recentBigDeletes(now: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const rows = await q<{ details: any }>(`SELECT details FROM maintenance_log WHERE dry_run = false AND status = 'ok' AND started_at > ? AND details->'tables' IS NOT NULL`, [now - 7 * DAY]);
  for (const r of rows) for (const [t, n] of Object.entries(r.details?.tables ?? {})) out[t] = (out[t] ?? 0) + Number(n);
  return out;
}

/** Statements that cannot run inside a transaction (VACUUM, ANALYZE, REINDEX CONCURRENTLY) go through a plain client. */
async function outsideTx<T>(timeout: string, fn: (exec: (sql: string) => Promise<unknown>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '${timeout}'`);
    return await fn((sql) => client.query(sql));
  } finally {
    await client.query('RESET statement_timeout').catch(() => {});
    client.release();
  }
}

const sizeOf = async (table: string) => Number((await one<{ s: string }>('SELECT pg_total_relation_size(?::regclass) AS s', [`public.${table}`]))?.s ?? 0);

const analyze: TaskDef = {
  id: 'analyze', name: 'Statistics (ANALYZE)', removes: 'Nothing: refreshes the planner statistics so searches stay fast.',
  scheduleText: 'weekly', defaultIntervalHours: 168, defaultRetentionDays: null, retentionLabel: null, safe: true,
  async exec(ctx) {
    const n = (await tableStats()).length;
    if (!ctx.dryRun) await outsideTx('300s', (x) => x('ANALYZE'));
    return { rows: 0, bytes: 0, details: { tablesAnalyzed: ctx.dryRun ? 0 : n, tablesInDatabase: n } };
  },
};

const vacuum: TaskDef = {
  id: 'vacuum', name: 'Vacuum', removes: 'Cleans dead rows (VACUUM ANALYZE) on tables with more than 20 % dead rows or after a big delete. Does not lock readers or writers.',
  scheduleText: 'monthly, or on demand', defaultIntervalHours: 720, defaultRetentionDays: null, retentionLabel: null, safe: false,
  async exec(ctx) {
    const stats = await tableStats();
    const known = new Set(stats.map((s) => s.name));
    const asked = Array.isArray(ctx.opts.tables) ? (ctx.opts.tables as string[]).filter((t) => known.has(t)) : null;
    const tables = asked ?? pickVacuumTables(stats, await recentBigDeletes(ctx.now));
    if (ctx.dryRun) {
      const dead = stats.filter((s) => tables.includes(s.name)).reduce((a, s) => a + s.dead, 0);
      return { rows: 0, bytes: 0, details: { wouldVacuum: tables, deadRows: dead } };
    }
    let freed = 0;
    const done: string[] = [];
    await outsideTx('1800s', async (x) => {
      for (const t of tables) {
        const before = await sizeOf(t);
        await x(`VACUUM (ANALYZE) ${ident(t)}`);
        freed += Math.max(0, before - (await sizeOf(t)));
        done.push(t);
      }
    });
    return { rows: 0, bytes: freed, details: { vacuumed: done } };
  },
};

export interface IndexStat { name: string; table: string; sizeBytes: number; bloatPct: number }

/** Estimated bloat of a btree index: actual size vs. the size its live entries would need (90 % fill). */
export function indexBloatPct(sizeBytes: number, reltuples: number, keyBytes: number): number {
  if (sizeBytes <= 0 || reltuples <= 0 || keyBytes <= 0) return 0;
  const perEntry = Math.ceil((keyBytes + 12) / 8) * 8;
  const ideal = (reltuples * perEntry) / 0.9;
  return Math.max(0, Math.round(((sizeBytes - ideal) / sizeBytes) * 1000) / 10);
}

export async function indexStats(minBytes = 1_048_576): Promise<IndexStat[]> {
  const rows = await q<{ name: string; tbl: string; size: string; tuples: number; keybytes: string }>(`
    SELECT ic.relname AS name, tc.relname AS tbl, pg_relation_size(ic.oid) AS size, ic.reltuples AS tuples,
      (SELECT COALESCE(SUM(s.avg_width), 0) FROM pg_attribute a JOIN pg_stats s ON s.schemaname = 'public' AND s.tablename = tc.relname AND s.attname = a.attname
        WHERE a.attrelid = ic.oid AND a.attnum > 0) AS keybytes
    FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class tc ON tc.oid = i.indrelid JOIN pg_namespace n ON n.oid = ic.relnamespace
    JOIN pg_am am ON am.oid = ic.relam
    WHERE n.nspname = 'public' AND am.amname = 'btree' AND i.indisvalid AND pg_relation_size(ic.oid) >= ?
    ORDER BY pg_relation_size(ic.oid) DESC`, [minBytes]);
  return rows.map((r) => ({ name: r.name, table: r.tbl, sizeBytes: Number(r.size), bloatPct: indexBloatPct(Number(r.size), Number(r.tuples), Number(r.keybytes)) }));
}

const reindex: TaskDef = {
  id: 'reindex', name: 'Rebuild bloated indexes', removes: 'Rebuilds indexes that are more than 40 % empty space (REINDEX CONCURRENTLY — no blocking).',
  scheduleText: 'quarterly, or on demand', defaultIntervalHours: 2160, defaultRetentionDays: null, retentionLabel: null, safe: false,
  async exec(ctx) {
    const bloated = (await indexStats(Number(ctx.opts.minBytes ?? 1_048_576))).filter((i) => i.bloatPct > 40);
    const est = bloated.reduce((s, i) => s + Math.round(i.sizeBytes * i.bloatPct / 100), 0);
    if (ctx.dryRun) return { rows: 0, bytes: est, details: { indexes: bloated } };
    let freed = 0;
    const done: string[] = [];
    await outsideTx('3600s', async (x) => {
      for (const i of bloated) {
        await x(`REINDEX INDEX CONCURRENTLY ${ident(i.name)}`);
        const after = Number((await one<{ s: string }>('SELECT pg_relation_size(?::regclass) AS s', [`public.${i.name}`]))?.s ?? i.sizeBytes);
        freed += Math.max(0, i.sizeBytes - after);
        done.push(i.name);
      }
    });
    return { rows: 0, bytes: freed, details: { rebuilt: done } };
  },
};

/** Tables where more than 30 % of the space is dead rows: when VACUUM FULL is offered. */
export async function fullVacuumCandidates(): Promise<TableStat[]> {
  return (await tableStats()).filter((t) => t.deadPct > 30 && t.dead >= 50);
}

const vacuumFull: TaskDef = {
  id: 'vacuum_full', name: 'Reclaim disk (VACUUM FULL)', removes: 'Rewrites bloated tables to give disk space back to the system. Locks each table while it runs: manual only.',
  scheduleText: 'manual only', defaultIntervalHours: 0, defaultRetentionDays: null, retentionLabel: null, manualOnly: true, safe: false,
  async exec(ctx) {
    const stats = await tableStats();
    const known = new Set(stats.map((s) => s.name));
    const asked = Array.isArray(ctx.opts.tables) ? (ctx.opts.tables as string[]).filter((t) => known.has(t)) : null;
    const tables = asked ?? (await fullVacuumCandidates()).map((t) => t.name);
    const est = stats.filter((s) => tables.includes(s.name)).reduce((a, s) => a + Math.round(s.sizeBytes * s.deadPct / 100), 0);
    if (ctx.dryRun) return { rows: 0, bytes: est, details: { wouldRewrite: tables } };
    let freed = 0;
    const done: string[] = [], failed: Record<string, string> = {};
    await outsideTx('3600s', async (x) => {
      await x("SET lock_timeout = '10s'");                      // never queue behind (and block) other work for long
      for (const t of tables) {
        const before = await sizeOf(t);
        try { await x(`VACUUM (FULL, ANALYZE) ${ident(t)}`); done.push(t); freed += Math.max(0, before - (await sizeOf(t))); }
        catch (e: any) { failed[t] = String(e?.message ?? e).slice(0, 200); }
      }
    });
    return { rows: 0, bytes: freed, details: { rewritten: done, failed } };
  },
};

export const TASKS: TaskDef[] = [
  sessions, jobs, disposable, seen, events, notifications, alerts, webhooks, processingLogs, trackingOpens, bounces, devices,
  apiTokens, orphanRows, orphanFiles, analyze, vacuum, reindex, vacuumFull, audit,
];
export const taskById = (id: string): TaskDef | undefined => TASKS.find((t) => t.id === id);
