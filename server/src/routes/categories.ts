/** Mailbox categories (T1 F-07): switcher overview, CRUD, members, order. */
import type { FastifyInstance } from 'fastify';
import { bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { one } from '../db.ts';
import {
  scopeAccountIds,
  categoryOverview, createCategory, updateCategory, deleteCategory, setCategoryMembers, reorderCategories,
} from '../mail/categories.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  const changed = async (userId: number) => { await bumpState(); broadcast({ type: 'stateChange' }, userId); };

  app.get('/api/categories', async (req) => categoryOverview(uid(req)));

  /** Space the current scope uses (sidebar footer): sum of stored .eml sizes. */
  app.get('/api/storage/usage', async (req) => {
    const userId = uid(req);
    const scope = String((req.query as any)?.scope ?? 'unified');
    const ids = await scopeAccountIds(userId, scope);
    const row = await one<{ bytes: string | number | null; messages: number }>(
      `SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS messages FROM messages
       WHERE user_id = ? ${ids ? 'AND account_id = ANY(?::int[])' : ''}`, ids ? [userId, ids] : [userId]);
    return { scope, bytes: Number(row?.bytes ?? 0), messages: row?.messages ?? 0 };
  });

  app.post('/api/categories', async (req, reply) => {
    try {
      const id = await createCategory(uid(req), req.body as any);
      const accountIds = (req.body as any)?.accountIds;
      if (Array.isArray(accountIds)) await setCategoryMembers(uid(req), id, accountIds);
      await changed(uid(req));
      return { id };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'could not create' });
    }
  });

  // registered before /:id so "order" isn't read as an id
  app.put('/api/categories/order', async (req) => {
    await reorderCategories(uid(req), ((req.body as any)?.ids ?? []) as number[]);
    await changed(uid(req));
    return { ok: true };
  });

  app.put('/api/categories/:id', async (req, reply) => {
    const ok = await updateCategory(uid(req), Number((req.params as any).id), req.body as any);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    await changed(uid(req));
    return { ok: true };
  });

  app.delete('/api/categories/:id', async (req, reply) => {
    const r = await deleteCategory(uid(req), Number((req.params as any).id));
    if (r === 'missing') return reply.code(404).send({ error: 'not found' });
    if (r === 'builtin') return reply.code(400).send({ error: 'built-in categories cannot be deleted' });
    await changed(uid(req));
    return { ok: true };
  });

  app.put('/api/categories/:id/members', async (req, reply) => {
    const ok = await setCategoryMembers(uid(req), Number((req.params as any).id), ((req.body as any)?.accountIds ?? []) as number[]);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    await changed(uid(req));
    return { ok: true };
  });
}
