/** Shared mailboxes (T4 F-32): who can see / work in which mailbox. Owner or admin manages a mailbox's shares. */
import type { FastifyInstance } from 'fastify';
import { q, one, run, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { uid, isAdmin } from './util.ts';

const ROLES = ['viewer', 'responder', 'manager'] as const;

/** The account if `req`'s user may manage its shares (owner, or admin). */
async function manageable(req: any, accountId: number) {
  const acct = await one<{ id: number; user_id: number; email: string; name: string }>('SELECT id, user_id, email, name FROM accounts WHERE id = ?', [accountId]);
  if (!acct) return null;
  return acct.user_id === uid(req) || isAdmin(req) ? acct : null;
}

export function register(app: FastifyInstance): void {
  /** Everything about sharing for the current user: what they share out, and what is shared with them. */
  app.get('/api/shares', async (req) => {
    const userId = uid(req);
    const out = await q<any>(`
      SELECT a.id AS account_id, a.email AS account_email, a.name AS account_name, s.user_id, s.role, u.email, u.name
      FROM accounts a LEFT JOIN mailbox_shares s ON s.account_id = a.id LEFT JOIN users u ON u.id = s.user_id
      WHERE a.user_id = ? ORDER BY a.id, u.email`, [userId]);
    const owned = new Map<number, any>();
    for (const r of out) {
      if (!owned.has(r.account_id)) owned.set(r.account_id, { accountId: r.account_id, email: r.account_email, name: r.account_name, shares: [] });
      if (r.user_id) owned.get(r.account_id).shares.push({ userId: r.user_id, email: r.email, name: r.name, role: r.role });
    }
    const withMe = await q<any>(`
      SELECT a.id AS account_id, a.email, a.name, s.role, o.email AS owner_email, o.name AS owner_name
      FROM mailbox_shares s JOIN accounts a ON a.id = s.account_id JOIN users o ON o.id = a.user_id
      WHERE s.user_id = ? ORDER BY a.id`, [userId]);
    return {
      owned: [...owned.values()],
      sharedWithMe: withMe.map((r) => ({ accountId: r.account_id, email: r.email, name: r.name, role: r.role, owner: r.owner_email, ownerName: r.owner_name })),
    };
  });

  /** People a mailbox can be shared with (this is a self-hosted instance: every other user). */
  app.get('/api/shares/people', async (req) =>
    q('SELECT id, email, name FROM users WHERE id <> ? ORDER BY lower(email)', [uid(req)]));

  app.get('/api/accounts/:id/shares', async (req, reply) => {
    const acct = await manageable(req, Number((req.params as any).id));
    if (!acct) return reply.code(404).send({ error: 'not found' });
    return (await q<any>(`SELECT s.user_id, s.role, u.email, u.name FROM mailbox_shares s JOIN users u ON u.id = s.user_id
      WHERE s.account_id = ? ORDER BY u.email`, [acct.id])).map((r) => ({ userId: r.user_id, email: r.email, name: r.name, role: r.role }));
  });

  app.put('/api/accounts/:id/shares', async (req, reply) => {
    const acct = await manageable(req, Number((req.params as any).id));
    if (!acct) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as { userId?: number; role?: string };
    const target = Number(b.userId);
    if (!(ROLES as readonly string[]).includes(String(b.role))) return reply.code(400).send({ error: 'role must be viewer, responder or manager' });
    if (target === acct.user_id) return reply.code(400).send({ error: 'the owner already has full access' });
    if (!(await one('SELECT 1 FROM users WHERE id = ?', [target]))) return reply.code(400).send({ error: 'unknown user' });
    await run(`INSERT INTO mailbox_shares(account_id, user_id, role, created_at) VALUES (?,?,?,?)
               ON CONFLICT (account_id, user_id) DO UPDATE SET role = excluded.role`, [acct.id, target, b.role, Date.now()]);
    await bumpState();
    broadcast({ type: 'stateChange' }, target);
    return { ok: true };
  });

  app.delete('/api/accounts/:id/shares/:userId', async (req, reply) => {
    const acct = await manageable(req, Number((req.params as any).id));
    if (!acct) return reply.code(404).send({ error: 'not found' });
    const target = Number((req.params as any).userId);
    await run('DELETE FROM mailbox_shares WHERE account_id = ? AND user_id = ?', [acct.id, target]);
    await bumpState();
    broadcast({ type: 'stateChange' }, target);
    return { ok: true };
  });
}
