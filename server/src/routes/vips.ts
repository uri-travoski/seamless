import type { FastifyInstance } from 'fastify';
import { uid } from './util.ts';
import { listVips, addVip, removeVip, bypassQuiet, VipError } from '../mail/vip.ts';
import { setUserSetting } from '../classify/settings.ts';

export function register(app: FastifyInstance): void {
  const guard = async (reply: any, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) { if (e instanceof VipError) return reply.code(e.status).send({ error: e.message }); throw e; }
  };
  app.get('/api/vips', async (req) => ({ items: await listVips(uid(req)), bypassQuiet: await bypassQuiet(uid(req)) }));
  app.post('/api/vips', async (req, reply) => guard(reply, () => {
    const b = (req.body ?? {}) as any;
    return addVip(uid(req), b.kind ?? 'address', b.value);
  }));
  app.put('/api/vips/settings', async (req) => {
    const on = !!((req.body ?? {}) as any).bypassQuiet;
    await setUserSetting(uid(req), 'vip_bypass_quiet', on ? 'true' : 'false');
    return { bypassQuiet: on };
  });
  app.delete('/api/vips/:id', async (req, reply) => guard(reply, async () => { await removeVip(uid(req), Number((req.params as any).id)); return { ok: true }; }));
}
