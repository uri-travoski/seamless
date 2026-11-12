/** Saved searches / smart views (T4 F-34). */
import type { FastifyInstance } from 'fastify';
import { uid } from './util.ts';
import { listViews, createView, updateView, deleteView, reorderViews, viewCounts, ensureDefaultViews, viewSuggestions, dismissSuggestions, ViewError } from '../mail/views.ts';

export function register(app: FastifyInstance): void {
  const guard = async (reply: any, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) { if (e instanceof ViewError) return reply.code(e.status).send({ error: e.message }); throw e; }
  };
  app.post('/api/views/defaults', async (req) => { await ensureDefaultViews(uid(req)); return { ok: true }; });
  app.get('/api/views', async (req) => listViews(uid(req)));
  app.get('/api/views/counts', async (req) => viewCounts(uid(req)));
  app.get('/api/views/suggestions', async (req) => viewSuggestions(uid(req)));
  app.post('/api/views/suggestions/dismiss', async (req) => { await dismissSuggestions(uid(req)); return { ok: true }; });
  app.put('/api/views/order', async (req) => {
    await reorderViews(uid(req), (((req.body as any)?.ids ?? []) as unknown[]).map(Number).filter(Number.isFinite));
    return listViews(uid(req));
  });
  app.post('/api/views', async (req, reply) => guard(reply, () => createView(uid(req), (req.body ?? {}) as any)));
  app.put('/api/views/:id', async (req, reply) => guard(reply, () => updateView(uid(req), Number((req.params as any).id), (req.body ?? {}) as any)));
  app.delete('/api/views/:id', async (req, reply) => guard(reply, async () => { await deleteView(uid(req), Number((req.params as any).id)); return { ok: true }; }));
}
