/** Classification rules + rule suggestions. */
import type { FastifyInstance } from 'fastify';
import { q, one, run, insertId } from '../db.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- classification rules ----
  app.get('/api/rules', async (req) =>
    (await q('SELECT * FROM rules WHERE user_id = ? ORDER BY ord, id', [uid(req)])).map((r: any) => ({
      id: r.id, enabled: r.enabled, ord: r.ord, matchField: r.match_field, matchValue: r.match_value,
      excludeContains: r.exclude_contains, action: r.action, labelId: r.label_id, stop: r.stop,
      note: r.note, source: r.source, hitCount: r.hit_count,
    })));

  app.post('/api/rules', async (req) => {
    const b = req.body as any;
    const id = await insertId(`
      INSERT INTO rules(user_id, enabled, ord, match_field, match_value, exclude_contains, action, label_id, stop, note, source, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `, [uid(req), b.enabled !== false, b.ord ?? 0, b.matchField, b.matchValue, b.excludeContains ?? '',
        b.action === 'ai' ? 'ai' : 'label', b.action === 'ai' ? null : b.labelId, b.stop !== false, b.note ?? '', 'manual', Date.now()]);
    return { id };
  });

  app.put('/api/rules/:id', async (req) => {
    const b = req.body as any;
    await run(`
      UPDATE rules SET enabled=?, ord=?, match_field=?, match_value=?, exclude_contains=?, action=?, label_id=?, stop=?, note=?
      WHERE id=? AND user_id=?
    `, [b.enabled !== false, b.ord ?? 0, b.matchField, b.matchValue, b.excludeContains ?? '',
        b.action === 'ai' ? 'ai' : 'label', b.action === 'ai' ? null : b.labelId, b.stop !== false, b.note ?? '',
        Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.delete('/api/rules/:id', async (req) => {
    await run('DELETE FROM rules WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  // ---- rule suggestions (promoted from corrections) ----
  app.get('/api/suggestions', async (req) =>
    (await q<any>("SELECT * FROM rule_suggestions WHERE user_id = ? AND status = 'pending' ORDER BY evidence DESC", [uid(req)])).map((s) => ({
      id: s.id, matchField: s.match_field, matchValue: s.match_value, labelId: s.label_id, evidence: s.evidence,
    })));

  app.post('/api/suggestions/:id/accept', async (req) => {
    const s = await one<any>('SELECT * FROM rule_suggestions WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    if (!s) return { ok: false };
    const maxOrd = (await one<{ m: number }>('SELECT COALESCE(MAX(ord),0) AS m FROM rules WHERE user_id = ?', [uid(req)]))?.m ?? 0;
    await insertId(`
      INSERT INTO rules(user_id, enabled, ord, match_field, match_value, exclude_contains, action, label_id, stop, note, source, created_at)
      VALUES (?,true,?,?,?,'','label',?,true,'promoted from your corrections','promoted',?)
    `, [uid(req), maxOrd + 10, s.match_field, s.match_value, s.label_id, Date.now()]);
    await run("UPDATE rule_suggestions SET status = 'accepted' WHERE id = ?", [s.id]);
    return { ok: true };
  });

  app.post('/api/suggestions/:id/dismiss', async (req) => {
    await run("UPDATE rule_suggestions SET status = 'dismissed' WHERE id = ? AND user_id = ?", [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });
}
