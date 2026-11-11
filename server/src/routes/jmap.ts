/** JMAP subset endpoint. */
import type { FastifyInstance } from 'fastify';
import { handleJmapRequest, jmapSession } from '../jmap/api.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- JMAP ----
  app.get('/jmap/session', async () => jmapSession());
  app.post('/jmap/api', async (req) => handleJmapRequest(uid(req), req.body as any));
}
