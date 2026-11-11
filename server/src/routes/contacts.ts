/** Contacts + vCard. */
import type { FastifyInstance } from 'fastify';
import { q, run } from '../db.ts';
import { listContacts, contactToVcf, importVcf, harvestContacts } from '../contacts.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- contacts ----
  app.get('/api/contacts', async (req) => {
    const includeHidden = (req.query as any).hidden === '1';
    return (await listContacts(uid(req), includeHidden)).map((c) => ({
      id: c.id, displayName: c.display_name, org: c.org, notes: c.notes, emails: c.emails,
      sentCount: c.sent_count, receivedCount: c.received_count,
      lastInteractionAt: c.last_interaction_at ? new Date(c.last_interaction_at).toISOString() : null,
      autoCreated: c.auto_created, hidden: c.hidden,
    }));
  });

  app.put('/api/contacts/:id', async (req) => {
    const b = req.body as any;
    await run('UPDATE contacts SET display_name = ?, org = ?, notes = ?, hidden = ?, auto_created = false, updated_at = ? WHERE id = ? AND user_id = ?',
      [b.displayName ?? '', b.org ?? '', b.notes ?? '', !!b.hidden, Date.now(), Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.delete('/api/contacts/:id', async (req) => {
    await run('DELETE FROM contacts WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.get('/api/contacts/suggest', async (req) => {
    const term = String((req.query as any).q ?? '').toLowerCase();
    if (!term) return [];
    const rows = await q<any>(`
      SELECT c.display_name, ce.email FROM contacts c JOIN contact_emails ce ON ce.contact_id = c.id
      WHERE c.user_id = ? AND c.hidden = false AND (lower(c.display_name) LIKE ? OR ce.email LIKE ?)
      ORDER BY GREATEST(c.sent_count, c.received_count) DESC LIMIT 8
    `, [uid(req), `%${term}%`, `%${term}%`]);
    return rows.map((r) => ({ name: r.display_name, email: r.email }));
  });

  app.get('/api/contacts/export.vcf', async (req, reply) => {
    const cards = (await listContacts(uid(req))).map(contactToVcf).join('');
    reply.header('Content-Type', 'text/vcard; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="seamless-contacts.vcf"');
    return reply.send(cards);
  });

  app.post('/api/contacts/import', async (req, reply) => {
    const part = await (req as any).file();
    if (!part) return reply.code(400).send({ error: 'no file' });
    const created = await importVcf(uid(req), (await part.toBuffer()).toString('utf8'));
    return { created };
  });

  app.post('/api/contacts/harvest', async () => ({ scanned: await harvestContacts() }));
}
