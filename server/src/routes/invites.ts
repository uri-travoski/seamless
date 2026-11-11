/** Calendar invites: card data comes with the message body; RSVP, .ics download, CalDAV (T4 F-33). */
import type { FastifyInstance } from 'fastify';
import { uid } from './util.ts';
import { getInvite, inviteIcs, rsvp, getConnection, setConnection, deleteConnection, addToCalendar } from '../mail/invites.ts';

export function register(app: FastifyInstance): void {
  const nf = (reply: any) => reply.code(404).send({ error: 'not found' });

  app.get('/api/invites/:id', async (req, reply) => (await getInvite(uid(req), Number((req.params as any).id))) ?? nf(reply));

  app.get('/api/invites/:id/ics', async (req, reply) => {
    const r = await inviteIcs(uid(req), Number((req.params as any).id));
    if (!r) return nf(reply);
    return reply.header('Content-Type', 'text/calendar; charset=utf-8').header('Content-Disposition', `attachment; filename="${r.filename}"`).send(r.ics);
  });

  app.post('/api/invites/:id/rsvp', async (req) => {
    const b = (req.body ?? {}) as any;
    return rsvp(uid(req), Number((req.params as any).id), String(b.partstat ?? '').toUpperCase(), String(b.note ?? ''));
  });

  app.post('/api/invites/:id/caldav', async (req) => addToCalendar(uid(req), Number((req.params as any).id)));

  app.get('/api/calendar-connection', async (req) => (await getConnection(uid(req))) ?? { url: null, username: null });
  app.put('/api/calendar-connection', async (req) => {
    const b = (req.body ?? {}) as any;
    await setConnection(uid(req), String(b.url ?? ''), String(b.username ?? ''), String(b.password ?? ''));
    return { ok: true };
  });
  app.delete('/api/calendar-connection', async (req) => { await deleteConnection(uid(req)); return { ok: true }; });
}
