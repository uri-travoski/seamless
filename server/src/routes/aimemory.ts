/** AI transparency + corrections (T8.10): why?, Fix it, Undo, the Corrections list, the AI health line. */
import type { FastifyInstance } from 'fastify';
import { getMsgRow } from '../mail/store.ts';
import { whyForMessage, correctMessage, listCorrections, undoCorrection, aiHealth, retryAi, MemoryError, type CorrectionInput } from '../classify/memory.ts';
import { broadcast } from '../ws.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  app.get('/api/message/:id/why', async (req) => {
    const row = await getMsgRow(uid(req), String((req.params as any).id));
    if (!row) return { visible: false };
    return whyForMessage(uid(req), row);
  });

  app.post('/api/message/:id/correct', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const input: CorrectionInput = {
      labelId: b.labelId === null || b.labelId === undefined || b.labelId === '' ? null : Number(b.labelId),
      retention: b.retention?.mode === 'keep' ? { mode: 'keep' } : b.retention?.mode === 'delete' ? { mode: 'delete', days: Number(b.retention.days) } : null,
      remember: b.remember !== false,
      why: typeof b.why === 'string' ? b.why : '',
    };
    try {
      const res = await correctMessage(uid(req), String((req.params as any).id), input);
      broadcast({ type: 'stateChange' }, uid(req));
      return res;
    } catch (err) {
      if (err instanceof MemoryError) return reply.code(err.status).send({ error: err.message });
      if ((err as any)?.name === 'Forbidden') return reply.code(403).send({ error: (err as Error).message });
      throw err;
    }
  });

  app.get('/api/corrections', async (req) => listCorrections(uid(req)));

  const undo = async (req: any, reply: any) => {
    const ok = await undoCorrection(uid(req), Number(req.params.id));
    if (!ok) return reply.code(404).send({ error: 'not found or already undone' });
    broadcast({ type: 'stateChange' }, uid(req));
    return { ok: true };
  };
  app.post('/api/corrections/:id/undo', undo);
  app.delete('/api/corrections/:id', undo);

  app.get('/api/ai/health', async (req) => aiHealth(uid(req)));
  app.post('/api/ai/retry', async (req) => ({ queued: await retryAi(uid(req)) }));
}
