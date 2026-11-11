import type { FastifyInstance } from 'fastify';
import { uid } from './util.ts';
import { LeadError, listSources, createSource, updateSource, deleteSource, testSource, listLeads, getLead, setLeadStatus, deleteLead, replyDraft, leadStats } from '../leads/leads.ts';

export function register(app: FastifyInstance): void {
  const guard = async (reply: any, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) { if (e instanceof LeadError) return reply.code(e.status).send({ error: e.message }); throw e; }
  };
  app.get('/api/lead-sources', async (req) => ({ items: await listSources(uid(req)) }));
  app.post('/api/lead-sources', async (req, reply) => guard(reply, () => createSource(uid(req), (req.body ?? {}) as any)));
  app.post('/api/lead-sources/test', async (req, reply) => guard(reply, () => testSource(uid(req), ((req.body ?? {}) as any).query)));
  app.put('/api/lead-sources/:id', async (req, reply) => guard(reply, () => updateSource(uid(req), Number((req.params as any).id), (req.body ?? {}) as any)));
  app.delete('/api/lead-sources/:id', async (req, reply) => guard(reply, async () => { await deleteSource(uid(req), Number((req.params as any).id)); return { ok: true }; }));

  app.get('/api/leads', async (req) => {
    const qs = req.query as Record<string, string>;
    return listLeads(uid(req), {
      business: qs.business, status: qs.status, service: qs.service, q: qs.q,
      from: qs.from ? Number(qs.from) : undefined, to: qs.to ? Number(qs.to) : undefined,
      limit: qs.limit ? Number(qs.limit) : undefined, offset: qs.offset ? Number(qs.offset) : undefined,
    });
  });
  app.get('/api/leads/stats', async (req) => ({ items: await leadStats(uid(req), Number((req.query as any).months) || 12) }));
  app.get('/api/leads/:id', async (req, reply) => guard(reply, async () => {
    const l = await getLead(uid(req), Number((req.params as any).id));
    if (!l) throw new LeadError(404, 'not found');
    return l;
  }));
  app.patch('/api/leads/:id', async (req, reply) => guard(reply, () => setLeadStatus(uid(req), Number((req.params as any).id), String(((req.body ?? {}) as any).status ?? ''))));
  app.delete('/api/leads/:id', async (req, reply) => guard(reply, async () => { await deleteLead(uid(req), Number((req.params as any).id)); return { ok: true }; }));
  app.get('/api/leads/:id/reply', async (req, reply) => guard(reply, () => replyDraft(uid(req), Number((req.params as any).id))));
}
