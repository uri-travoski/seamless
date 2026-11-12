/**
 * Append-only audit log (T6 F-42). `audit()` never throws: a failing audit write is logged to stderr and must not
 * break the action it describes. Rows can only be removed by the retention job (see `pruneAudit`), because the
 * table has triggers that refuse UPDATE / DELETE / TRUNCATE unless `seamless.audit_prune = 'on'`.
 */
import type { FastifyRequest } from 'fastify';
import { pool, q, one, getSetting } from '../db.ts';

export type ActorKind = 'user' | 'api_token' | 'system';
export interface AuditTarget { type?: string | null; id?: string | number | null }
export interface AuditOpts { userId?: number | null }

const SECRET_KEY = /pass|secret|token|key/i;
export const REDACTED = '[redacted]';

/** Deep copy with values of secret-looking keys (`*pass*`, `*secret*`, `*token*`, `*key*`) replaced. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redact(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && v.length > 500) return v.slice(0, 500) + '…';
  return v;
}

function actorOf(req: FastifyRequest | null, opts: AuditOpts) {
  const r = req as any;
  if (r?.apiAuth) return { userId: r.apiAuth.userId as number, kind: 'api_token' as const, tokenId: r.apiAuth.tokenId as number };
  const uid = opts.userId ?? r?.sessionUser?.userId ?? null;
  if (uid != null) return { userId: uid as number, kind: 'user' as const, tokenId: null };
  return { userId: null, kind: 'system' as const, tokenId: null };
}

/** Record one audit row. `req` supplies actor, IP and user agent; pass null for background work (actor = system). */
export async function audit(
  req: FastifyRequest | null, action: string, target: AuditTarget = {}, details: Record<string, unknown> = {}, opts: AuditOpts = {},
): Promise<void> {
  try {
    const a = actorOf(req, opts);
    const ua = req ? String(req.headers['user-agent'] ?? '').slice(0, 300) || null : null;
    await pool.query(
      `INSERT INTO audit_log(actor_user_id, actor_kind, actor_token_id, action, target_type, target_id, ip, user_agent, details, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [a.userId, a.kind, a.tokenId, action, target.type ?? null, target.id != null ? String(target.id) : null,
        req?.ip ?? null, ua, JSON.stringify(redact(details)), Date.now()]);
  } catch (e: any) {
    console.error('[audit] write failed:', e?.message ?? e);
  }
}

// ---- reading ----
export interface AuditFilter {
  actor?: number; action?: string; target?: string; from?: number; to?: number; limit?: number; offset?: number;
}
export interface AuditRow {
  id: number; actorUserId: number | null; actorEmail: string | null; actorKind: ActorKind; actorTokenId: number | null;
  action: string; targetType: string | null; targetId: string | null; ip: string | null; userAgent: string | null;
  details: unknown; createdAt: number;
}

function where(viewer: { userId: number; admin: boolean }, f: AuditFilter) {
  const w: string[] = []; const p: unknown[] = [];
  const add = (sql: string, v: unknown) => { p.push(v); w.push(sql.replace('?', `$${p.length}`)); };
  // members only ever see their own rows, whatever they ask for
  if (!viewer.admin) add('a.actor_user_id = ?', viewer.userId);
  else if (f.actor != null) add('a.actor_user_id = ?', f.actor);
  if (f.action) add('a.action LIKE ?', f.action.replace(/[%_\\]/g, '\\$&') + '%');
  if (f.target) {
    p.push(f.target); const i = p.length;
    w.push(`(a.target_type = $${i} OR a.target_id = $${i} OR a.target_type || ':' || a.target_id = $${i})`);
  }
  if (f.from != null) add('a.created_at >= ?', f.from);
  if (f.to != null) add('a.created_at < ?', f.to);
  return { sql: w.length ? 'WHERE ' + w.join(' AND ') : '', p };
}

export async function queryAudit(viewer: { userId: number; admin: boolean }, f: AuditFilter = {}): Promise<{ items: AuditRow[]; total: number }> {
  const { sql, p } = where(viewer, f);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 5000);
  const offset = Math.max(f.offset ?? 0, 0);
  const rows = await q<any>(
    `SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id ${sql}
     ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit} OFFSET ${offset}`, p);
  const total = await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_log a ${sql}`, p);
  return {
    total: total?.n ?? 0,
    items: rows.map((r) => ({
      id: Number(r.id), actorUserId: r.actor_user_id, actorEmail: r.actor_email ?? null, actorKind: r.actor_kind,
      actorTokenId: r.actor_token_id, action: r.action, targetType: r.target_type, targetId: r.target_id,
      ip: r.ip, userAgent: r.user_agent, details: r.details, createdAt: Number(r.created_at),
    })),
  };
}

const csvCell = (v: unknown) => {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function auditCsv(items: AuditRow[]): string {
  const head = ['time', 'actor', 'actor_kind', 'action', 'target_type', 'target_id', 'ip', 'user_agent', 'details'];
  const lines = [head.join(',')];
  for (const r of items) {
    lines.push([new Date(r.createdAt).toISOString(), r.actorEmail ?? (r.actorUserId ?? ''), r.actorKind, r.action,
      r.targetType, r.targetId, r.ip, r.userAgent, r.details].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ---- retention ----
export const DEFAULT_RETENTION_DAYS = 730;

export async function retentionDays(): Promise<number> {
  const n = Number(await getSetting('audit_retention_days'));
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}

/** Delete rows older than the retention period. The only code path (with restore + the test reset) allowed to. */
export async function pruneAudit(now = Date.now()): Promise<number> {
  const cutoff = now - (await retentionDays()) * 86_400_000;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL seamless.audit_prune = 'on'");
    const r = await c.query('DELETE FROM audit_log WHERE created_at < $1', [cutoff]);
    await c.query('COMMIT');
    const n = r.rowCount ?? 0;
    if (n > 0) await audit(null, 'audit.prune', { type: 'audit_log' }, { deleted: n, retentionDays: await retentionDays() });
    return n;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
