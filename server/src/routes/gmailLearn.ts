/** Learn-from-Gmail onboarding. */
import type { FastifyInstance } from 'fastify';
import { one } from '../db.ts';
import { reclassifyUser } from '../classify/engine.ts';
import { runGmailLearn, acceptProposals } from '../import/gmailLearn.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- learn from Gmail ----
  app.post('/api/gmail-learn/:accountId', async (req, reply) => {
    try {
      const importId = await runGmailLearn(uid(req), Number((req.params as any).accountId));
      return { importId };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'could not start' });
    }
  });

  app.get('/api/gmail-learn/:importId/status', async (req, reply) => {
    const imp = await one<any>('SELECT * FROM gmail_imports WHERE id = ? AND user_id = ?', [Number((req.params as any).importId), uid(req)]);
    if (!imp) return reply.code(404).send({ error: 'not found' });
    return { status: imp.status, stats: JSON.parse(imp.stats), proposals: JSON.parse(imp.proposals) };
  });

  app.post('/api/gmail-learn/:importId/accept', async (req, reply) => {
    try {
      const created = await acceptProposals(uid(req), Number((req.params as any).importId), (req.body as any)?.indexes ?? []);
      await reclassifyUser(uid(req));
      return { created };
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'accept failed' });
    }
  });
}
