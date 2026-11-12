/** Shared mailboxes (T4 F-32): who can see / work in which mailbox. Owner or admin manages a mailbox's shares. */
import type { FastifyInstance } from 'fastify';
import { q, one, run, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { uid, isAdmin } from './util.ts';
import { clearAssignmentsFor } from '../mail/assignments.ts';
import { emitEvent } from '../events/emit.ts';
import { offersFor } from '../mail/sharedLabels.ts';

const ROLES = ['viewer', 'responder', 'manager'] as const;

/** The account if `req`'s user may manage its shares (owner, or admin). */
async function manageable(req: any, accountId: number) {
  const acct = await one<{ id: number; user_id: number; email: string; name: string }>('SELECT id, user_id, email, name FROM accounts WHERE id = ?', [accountId]);
  if (!acct) return null;
  return acct.user_id === uid(req) || isAdmin(req) ? acct : null;
}

/** Owner side of sharing labels: `on` offers (pending) the chosen labels (none picked = all); `off` stops it. */
async function setLabelSharing(acct: { id: number; user_id: number; email: string }, target: number, on: boolean, labelIds: number[] | undefined, reoffer: boolean): Promise<void> {
  const cur = await one<{ labels_status: string }>('SELECT labels_status FROM mailbox_shares WHERE account_id = ? AND user_id = ?', [acct.id, target]);
  if (!cur) return;
  if (!on) {
    await run("UPDATE mailbox_shares SET labels_shared = false, labels_status = 'none', labels_later_at = NULL WHERE account_id = ? AND user_id = ?", [acct.id, target]);
    await run('DELETE FROM shared_label_offers WHERE account_id = ? AND user_id = ?', [acct.id, target]);
    return;
  }
  // the picked labels must be the owner's own
  const picked = Array.isArray(labelIds) ? [...new Set(labelIds.map(Number).filter(Boolean))] : [];
  const valid = picked.length ? (await q<{ id: number }>('SELECT id FROM labels WHERE user_id = ? AND id = ANY(?::int[])', [acct.user_id, picked])).map((r) => r.id) : [];
  if (Array.isArray(labelIds)) {
    await run('DELETE FROM shared_label_offers WHERE account_id = ? AND user_id = ?', [acct.id, target]);
    for (const id of valid) await run('INSERT INTO shared_label_offers(account_id, user_id, label_id) VALUES (?,?,?)', [acct.id, target, id]);
  }
  const offer = cur.labels_status === 'none' || (cur.labels_status === 'rejected' && reoffer);
  await run(`UPDATE mailbox_shares SET labels_shared = true, labels_status = ? WHERE account_id = ? AND user_id = ?`,
    [offer ? 'pending' : cur.labels_status, acct.id, target]);
  if (offer) {
    const count = valid.length || Number((await one<{ c: number }>('SELECT COUNT(*) AS c FROM labels WHERE user_id = ?', [acct.user_id]))?.c ?? 0);
    const owner = await one<{ name: string; email: string }>('SELECT name, email FROM users WHERE id = ?', [acct.user_id]);
    await emitEvent(target, 'labels.offered', { type: 'account', id: acct.id },
      { accountId: acct.id, email: acct.email, ownerName: owner?.name || owner?.email, count });
  }
}

export function register(app: FastifyInstance): void {
  /** Everything about sharing for the current user: what they share out, and what is shared with them. */
  app.get('/api/shares', async (req) => {
    const userId = uid(req);
    const out = await q<any>(`
      SELECT a.id AS account_id, a.email AS account_email, a.name AS account_name, s.user_id, s.role, s.labels_shared, s.labels_status, u.email, u.name
      FROM accounts a LEFT JOIN mailbox_shares s ON s.account_id = a.id LEFT JOIN users u ON u.id = s.user_id
      WHERE a.user_id = ? ORDER BY a.id, u.email`, [userId]);
    const owned = new Map<number, any>();
    for (const r of out) {
      if (!owned.has(r.account_id)) owned.set(r.account_id, { accountId: r.account_id, email: r.account_email, name: r.account_name, shares: [] });
      if (r.user_id) owned.get(r.account_id).shares.push({ userId: r.user_id, email: r.email, name: r.name, role: r.role, labelsShared: r.labels_shared, labelsStatus: r.labels_status });
    }
    const withMe = await q<any>(`
      SELECT a.id AS account_id, a.email, a.name, s.role, s.labels_shared, s.labels_status, o.email AS owner_email, o.name AS owner_name
      FROM mailbox_shares s JOIN accounts a ON a.id = s.account_id JOIN users o ON o.id = a.user_id
      WHERE s.user_id = ? ORDER BY a.id`, [userId]);
    return {
      owned: [...owned.values()],
      sharedWithMe: withMe.map((r) => ({ accountId: r.account_id, email: r.email, name: r.name, role: r.role, owner: r.owner_email, ownerName: r.owner_name, labelsStatus: r.labels_shared ? r.labels_status : 'none' })),
    };
  });

  /** People a mailbox can be shared with (this is a self-hosted instance: every other user). */
  app.get('/api/shares/people', async (req) =>
    q('SELECT id, email, name FROM users WHERE id <> ? ORDER BY lower(email)', [uid(req)]));

  app.get('/api/accounts/:id/shares', async (req, reply) => {
    const acct = await manageable(req, Number((req.params as any).id));
    if (!acct) return reply.code(404).send({ error: 'not found' });
    const offered = await q<{ user_id: number; label_id: number }>('SELECT user_id, label_id FROM shared_label_offers WHERE account_id = ?', [acct.id]);
    return (await q<any>(`SELECT s.user_id, s.role, s.labels_shared, s.labels_status, u.email, u.name FROM mailbox_shares s JOIN users u ON u.id = s.user_id
      WHERE s.account_id = ? ORDER BY u.email`, [acct.id])).map((r) => ({
      userId: r.user_id, email: r.email, name: r.name, role: r.role, labelsShared: r.labels_shared, labelsStatus: r.labels_status,
      labelIds: offered.filter((o) => o.user_id === r.user_id).map((o) => o.label_id),
    }));
  });

  app.put('/api/accounts/:id/shares', async (req, reply) => {
    const acct = await manageable(req, Number((req.params as any).id));
    if (!acct) return reply.code(404).send({ error: 'not found' });
    const b = (req.body ?? {}) as { userId?: number; role?: string; shareLabels?: boolean; labelIds?: number[]; reoffer?: boolean };
    const target = Number(b.userId);
    if (!(ROLES as readonly string[]).includes(String(b.role))) return reply.code(400).send({ error: 'role must be viewer, responder or manager' });
    if (target === acct.user_id) return reply.code(400).send({ error: 'the owner already has full access' });
    if (!(await one('SELECT 1 FROM users WHERE id = ?', [target]))) return reply.code(400).send({ error: 'unknown user' });
    await run(`INSERT INTO mailbox_shares(account_id, user_id, role, created_at) VALUES (?,?,?,?)
               ON CONFLICT (account_id, user_id) DO UPDATE SET role = excluded.role`, [acct.id, target, b.role, Date.now()]);
    if (typeof b.shareLabels === 'boolean') await setLabelSharing(acct, target, b.shareLabels, b.labelIds, !!b.reoffer);
    await bumpState();
    broadcast({ type: 'stateChange' }, target);
    broadcast({ type: 'stateChange' }, acct.user_id);
    return { ok: true };
  });

  /** What has been offered to me (any answer) — Settings → Labels banner and "Shared with me". */
  app.get('/api/labels/shared', async (req) => offersFor(uid(req)));

  /** accept | reject | later | leave (leave = change my mind after accepting). */
  app.post('/api/labels/shared/:accountId/respond', async (req, reply) => {
    const accountId = Number((req.params as any).accountId);
    const action = String((req.body as any)?.action ?? '');
    const userId = uid(req);
    const cur = await one<{ labels_status: string }>("SELECT labels_status FROM mailbox_shares WHERE account_id = ? AND user_id = ? AND labels_shared AND labels_status <> 'none'", [accountId, userId]);
    if (!cur) return reply.code(404).send({ error: 'no shared labels offered' });
    if (action === 'accept') await run("UPDATE mailbox_shares SET labels_status = 'accepted', labels_later_at = NULL WHERE account_id = ? AND user_id = ?", [accountId, userId]);
    else if (action === 'reject' || action === 'leave') await run("UPDATE mailbox_shares SET labels_status = 'rejected', labels_later_at = NULL WHERE account_id = ? AND user_id = ?", [accountId, userId]);
    else if (action === 'later') {
      if (cur.labels_status !== 'pending') return reply.code(400).send({ error: 'only a pending offer can wait' });
      await run('UPDATE mailbox_shares SET labels_later_at = ? WHERE account_id = ? AND user_id = ?', [Date.now(), accountId, userId]);
    } else return reply.code(400).send({ error: 'action must be accept, reject, later or leave' });
    const owner = await one<{ user_id: number }>('SELECT user_id FROM accounts WHERE id = ?', [accountId]);
    await bumpState();
    broadcast({ type: 'stateChange' }, userId);
    if (owner) broadcast({ type: 'stateChange' }, owner.user_id);
    return { ok: true };
  });

  app.delete('/api/accounts/:id/shares/:userId', async (req, reply) => {
    const acct = await manageable(req, Number((req.params as any).id));
    if (!acct) return reply.code(404).send({ error: 'not found' });
    const target = Number((req.params as any).userId);
    await run('DELETE FROM mailbox_shares WHERE account_id = ? AND user_id = ?', [acct.id, target]);
    await clearAssignmentsFor(acct.id, target);
    await bumpState();
    broadcast({ type: 'stateChange' }, target);
    return { ok: true };
  });
}
