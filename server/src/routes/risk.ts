/** Phishing warnings: mark safe, report, and the trusted-senders list (T2 F-20). */
import type { FastifyInstance } from 'fastify';
import { q, one, run, insertId } from '../db.ts';
import { getMsgRow, moveEmail } from '../mail/store.ts';
import { domainOf } from '../mail/risk.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  app.post('/api/risk/:emailId/safe', async (req, reply) => {
    const row = await getMsgRow(uid(req), String((req.params as any).emailId), 'write');
    if (!row) return reply.code(404).send({ error: 'not found' });
    await run(`INSERT INTO trusted_senders(user_id, kind, value, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`,
      [uid(req), 'address', row.from_addr.toLowerCase(), Date.now()]);
    await run(`UPDATE message_risk SET level = 'none', score = 0, reasons = '[]'::jsonb WHERE message_id = ?`, [row.id]);
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true, trusted: row.from_addr.toLowerCase() };
  });

  app.post('/api/risk/:emailId/report', async (req, reply) => {
    const row = await getMsgRow(uid(req), String((req.params as any).emailId), 'write');
    if (!row) return reply.code(404).send({ error: 'not found' });
    await moveEmail(uid(req), `m${row.id}`, 'u:junk');
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  app.get('/api/trusted-senders', async (req) =>
    (await q<any>('SELECT id, kind, value, created_at FROM trusted_senders WHERE user_id = ? ORDER BY value', [uid(req)]))
      .map((r) => ({ id: r.id, kind: r.kind, value: r.value, createdAt: Number(r.created_at) })));

  app.post('/api/trusted-senders', async (req, reply) => {
    const b = (req.body ?? {}) as { value?: string };
    const v = String(b.value ?? '').trim().toLowerCase().replace(/^@/, '');
    if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$|^[^\s@]+\.[^\s@]+$/.test(v)) return reply.code(400).send({ error: 'Enter an email address or a domain' });
    const kind = v.includes('@') ? 'address' : 'domain';
    const id = await insertId(`INSERT INTO trusted_senders(user_id, kind, value, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING`, [uid(req), kind, kind === 'domain' ? domainOf(`x@${v}`) : v, Date.now()]);
    return { ok: true, id };
  });

  app.delete('/api/trusted-senders/:id', async (req, reply) => {
    const n = await run('DELETE FROM trusted_senders WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return n ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });
}
