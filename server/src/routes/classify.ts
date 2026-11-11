/** Spreadsheet import, classification/retention ops, review lane, AI decisions, processor notes. */
import type { FastifyInstance } from 'fastify';
import { q, one, run, insertId, bumpState } from '../db.ts';
import { getMsgRow, setLabels } from '../mail/store.ts';
import { parseTeachNote } from '../ai/tasks.ts';
import { getTaskProvider } from '../ai/client.ts';
import { embedText, embeddingInput } from '../classify/ai.ts';
import { broadcast } from '../ws.ts';
import { importWorkbook } from '../import/xlsx.ts';
import { reclassifyUser, kickClassifier } from '../classify/engine.ts';
import { sweepRetention } from '../classify/retention.ts';
import { allUserSettings, setUserSetting } from '../classify/settings.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- spreadsheet import ----
  app.post('/api/import/xlsx', async (req, reply) => {
    const part = await (req as any).file();
    if (!part) return reply.code(400).send({ error: 'no file' });
    const buf = await part.toBuffer();
    const commit = (req.query as any).commit === '1';
    try {
      const preview = await importWorkbook(uid(req), buf, commit);
      if (commit) {
        await reclassifyUser(uid(req));
        broadcast({ type: 'stateChange' }, uid(req));
      }
      return preview;
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'import failed' });
    }
  });

  // ---- classification / retention ops ----
  app.post('/api/classify/run', async (req) => {
    const n = await reclassifyUser(uid(req));
    return { queued: n };
  });

  app.post('/api/retention/sweep', async () => {
    const stats = await sweepRetention();
    kickClassifier();
    return stats;
  });

  app.get('/api/retention/settings', async (req) => {
    const all = await allUserSettings(uid(req));
    return { dryRun: all.dry_run !== 'false', trashDays: Number(all.trash_days) || 30, logRetentionDays: Number(all.log_retention_days) || 90 };
  });

  app.put('/api/retention/settings', async (req) => {
    const b = req.body as any;
    if (b.dryRun !== undefined) await setUserSetting(uid(req), 'dry_run', b.dryRun ? 'true' : 'false');
    if (b.trashDays !== undefined) await setUserSetting(uid(req), 'trash_days', String(Number(b.trashDays) || 30));
    if (b.logRetentionDays !== undefined) await setUserSetting(uid(req), 'log_retention_days', String(Number(b.logRetentionDays) || 90));
    return { ok: true };
  });

  // ---- review lane ----
  app.get('/api/review/count', async (req) => {
    const row = await one<{ c: number }>("SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND classify_state = 'needs_review'", [uid(req)]);
    return { count: row?.c ?? 0 };
  });

  /** One-tap review decision: set labels (or none) and mark the message decided. */
  app.post('/api/review/:id/resolve', async (req) => {
    const emailId = String((req.params as any).id);
    const b = (req.body ?? {}) as { labelIds?: number[] };
    const row = await getMsgRow(uid(req), emailId, 'write');
    if (!row) return { ok: false };
    if (Array.isArray(b.labelIds)) await setLabels(uid(req), emailId, b.labelIds);
    await run("UPDATE messages SET classify_state = 'classified', review_reason = NULL WHERE id = ?", [row.id]);
    await bumpState();
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  // ---- ai decisions ("why this label?") ----
  app.get('/api/message/:id/decisions', async (req) => {
    const row = await getMsgRow(uid(req), (req.params as any).id);
    if (!row) return [];
    const rows = await q<any>('SELECT tier, model, output, confidence, reason, created_at FROM ai_decisions WHERE email_id = ? ORDER BY id DESC LIMIT 5', [row.id]);
    return rows.map((r) => ({
      tier: r.tier, model: r.model, output: JSON.parse(r.output), confidence: r.confidence,
      reason: r.reason, createdAt: new Date(r.created_at).toISOString(),
    }));
  });

  // ---- processor notes ("teach the AI about this sender") ----
  app.get('/api/processor-notes', async (req) =>
    (await q<any>('SELECT * FROM processor_notes WHERE user_id = ? AND active = true ORDER BY id DESC', [uid(req)])).map((n) => ({
      id: n.id, scope: n.scope, scopeValue: n.scope_value, note: n.note, labelId: n.label_id,
      autoRead: n.auto_read, retentionDays: n.retention_days, deleteIfUnread: n.delete_if_unread, active: n.active,
    })));

  // parse a plain-English instruction into directives + candidate labels (no save yet)
  app.post('/api/processor-notes/parse', async (req) => {
    const b = req.body as any;
    const d = await parseTeachNote(uid(req), String(b.emailId ?? ''), String(b.note ?? ''));
    let existingMatches: { id: number; name: string }[] = [];
    if (d.label) {
      const want = d.label.toLowerCase();
      const words = new Set(want.split(/\W+/).filter(Boolean));
      const labels = await q<{ id: number; name: string }>('SELECT id, name FROM labels WHERE user_id = ? ORDER BY sort, id', [uid(req)]);
      existingMatches = labels
        .map((l) => {
          const ln = l.name.toLowerCase();
          let score = ln === want ? 1 : (ln.includes(want) || want.includes(ln)) ? 0.7 : 0;
          if (!score) {
            const lw = ln.split(/\W+/).filter(Boolean);
            const overlap = lw.filter((w) => words.has(w)).length;
            score = overlap / Math.max(1, words.size + lw.length - overlap);
          }
          return { id: l.id, name: l.name, score };
        })
        .filter((x) => x.score > 0.2)
        .sort((a, b2) => b2.score - a.score).slice(0, 3)
        .map(({ id, name }) => ({ id, name }));
    }
    return { ...d, existingMatches };
  });

  app.post('/api/processor-notes', async (req) => {
    const b = req.body as any;
    // "Teach the AI" content-similarity note (from the reading pane)
    if (b.emailId) {
      const userId = uid(req);
      let labelId: number | null = null;
      if (b.label?.kind === 'existing' && b.label.id) labelId = Number(b.label.id);
      else if (b.label?.kind === 'new' && b.label.name) {
        labelId = await insertId(
          `INSERT INTO labels(user_id, name, color, description, sort, retention_days, auto_mark_read)
           VALUES (?,?,?, '', 0, ?, ?)
           ON CONFLICT (user_id, name) DO UPDATE SET retention_days = excluded.retention_days, auto_mark_read = excluded.auto_mark_read`,
          [userId, String(b.label.name).trim(), b.color ?? '#2f8ed8', b.retentionDays ?? null, !!b.autoRead]);
      }
      const vecLit = (v: number[]) => '[' + v.map((x) => Number.isFinite(x) ? x.toFixed(6) : '0').join(',') + ']';
      let embedLit: string | null = null; let dim: number | null = null;
      const provider = await getTaskProvider(userId, 'embed');
      const row = await getMsgRow(userId, String(b.emailId));
      if (provider && row) {
        try { const vec = await embedText(provider, embeddingInput(row)); embedLit = vecLit(vec); dim = vec.length; } catch { /* store without anchor */ }
      }
      const id = await insertId(`
        INSERT INTO processor_notes(user_id, scope, scope_value, note, summary, label_id, auto_read, retention_days, delete_if_unread, embedding, embed_dim, active, created_at, updated_at)
        VALUES (?, 'similar', ?, ?, ?, ?, ?, ?, ?, ?::vector, ?, true, ?, ?)
        ON CONFLICT (user_id, scope, scope_value) DO UPDATE SET
          note=excluded.note, summary=excluded.summary, label_id=excluded.label_id, auto_read=excluded.auto_read,
          retention_days=excluded.retention_days, delete_if_unread=excluded.delete_if_unread,
          embedding=excluded.embedding, embed_dim=excluded.embed_dim, active=true, updated_at=excluded.updated_at
      `, [userId, String(b.emailId), b.note ?? '', b.summary ?? '', labelId, !!b.autoRead, b.retentionDays ?? null, !!b.deleteIfUnread, embedLit, dim, Date.now(), Date.now()]);
      await bumpState();
      return { id, labelId };
    }
    // legacy per-sender/domain note
    const scope = b.scope === 'domain' ? 'domain' : 'sender';
    const id = await insertId(`
      INSERT INTO processor_notes(user_id, scope, scope_value, note, label_id, auto_read, retention_days, delete_if_unread, active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,true,?,?)
      ON CONFLICT (user_id, scope, scope_value) DO UPDATE SET
        note = excluded.note, label_id = excluded.label_id, auto_read = excluded.auto_read,
        retention_days = excluded.retention_days, delete_if_unread = excluded.delete_if_unread,
        active = true, updated_at = excluded.updated_at
    `, [uid(req), scope, String(b.scopeValue ?? '').trim().toLowerCase(), b.note ?? '',
        b.labelId ?? null, !!b.autoRead, b.retentionDays ?? null, !!b.deleteIfUnread, Date.now(), Date.now()]);
    return { id };
  });

  app.delete('/api/processor-notes/:id', async (req) => {
    await run('UPDATE processor_notes SET active = false WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });
}
