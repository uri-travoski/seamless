/** Message body, tracking info, blobs, notes, original source, raw .eml. */
import type { FastifyInstance } from 'fastify';
import { getBlob } from '../s3.ts';
import { getEmailBody, getParsed, getTracking } from '../mail/body.ts';
import { buildOriginalPage } from '../mail/original.ts';
import { getMsgRow, setNote } from '../mail/store.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- message body / blobs ----
  app.get('/api/message/:id/body', async (req, reply) => {
    const allowRemote = (req.query as any).remote === '1';
    const body = await getEmailBody(uid(req), (req.params as any).id, allowRemote);
    if (!body) return reply.code(404).send({ error: 'not found' });
    return body;
  });

  app.get('/api/message/:id/tracking', async (req, reply) => {
    const t = await getTracking(uid(req), (req.params as any).id);
    if (!t) return reply.code(404).send({ error: 'not tracked' });
    return t;
  });

  app.get('/api/blob/:id/:partId', async (req, reply) => {
    const { id, partId } = req.params as any;
    const parsed = await getParsed(Number(String(id).replace(/^m/, '')) || 0, uid(req));
    const att = parsed?.attachments[Number(partId)];
    if (!att) return reply.code(404).send({ error: 'not found' });
    const download = (req.query as any).download === '1';
    reply.header('Content-Type', att.contentType || 'application/octet-stream');
    reply.header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(att.filename ?? 'attachment')}"`);
    reply.header('Cache-Control', 'private, max-age=86400');
    return reply.send(att.content);
  });

  app.put('/api/message/:id/note', async (req) => {
    await setNote(uid(req), (req.params as any).id, String((req.body as any)?.body ?? ''));
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  });

  app.get('/api/message/:id/original', async (req, reply) => {
    const html = await buildOriginalPage(uid(req), (req.params as any).id);
    if (!html) return reply.code(404).send({ error: 'not found' });
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(html);
  });

  app.get('/api/raw/:id', async (req, reply) => {
    const row = await getMsgRow(uid(req), (req.params as any).id);
    if (!row || !row.s3_key) return reply.code(404).send({ error: 'not found' });
    const raw = await getBlob(row.s3_key);
    reply.header('Content-Type', 'message/rfc822');
    reply.header('Content-Disposition', `attachment; filename="${row.id}.eml"`);
    return reply.send(raw);
  });
}
