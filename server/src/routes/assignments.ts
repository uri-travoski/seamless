/** Assignment, status and internal comments on shared threads (T4 F-32 part 2). */
import type { FastifyInstance } from 'fastify';
import { uid } from './util.ts';
import { getAssignment, setAssignment, listComments, addComment, listPeople } from '../mail/assignments.ts';

export function register(app: FastifyInstance): void {
  const accountOf = (req: any) => Number((req.body as any)?.accountId ?? (req.query as any)?.accountId);

  app.get('/api/threads/:threadId/assignment', async (req) =>
    (await getAssignment(uid(req), accountOf(req), (req.params as any).threadId)) ?? { accountId: accountOf(req), threadId: (req.params as any).threadId, assigneeId: null, assigneeName: null, status: 'open', dueAt: null, updatedAt: 0 });

  app.put('/api/threads/:threadId/assignment', async (req) => {
    const b = (req.body ?? {}) as any;
    return setAssignment(uid(req), accountOf(req), (req.params as any).threadId, { assigneeId: b.assigneeId, status: b.status, dueAt: b.dueAt });
  });

  app.get('/api/accounts/:id/people', async (req) => listPeople(uid(req), Number((req.params as any).id)));

  app.get('/api/threads/:threadId/comments', async (req) => listComments(uid(req), accountOf(req), (req.params as any).threadId));

  app.post('/api/threads/:threadId/comments', async (req) =>
    addComment(uid(req), accountOf(req), (req.params as any).threadId, (req.body as any)?.body));
}
