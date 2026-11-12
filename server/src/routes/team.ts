/** Team settings of a shared mailbox (T8.3): shared snooze, round-robin assignment, "I'm away". */
import type { FastifyInstance } from 'fastify';
import { uid } from './util.ts';
import { audit } from '../audit/log.ts';
import { getTeamSettings, setTeamSettings, setAway, myPools } from '../mail/team.ts';

export function register(app: FastifyInstance): void {
  app.get('/api/accounts/:id/team', async (req) => getTeamSettings(uid(req), Number((req.params as any).id)));

  app.put('/api/accounts/:id/team', async (req) => {
    const accountId = Number((req.params as any).id);
    const b = (req.body ?? {}) as { allowSnooze?: boolean; autoAssign?: string; pool?: number[] };
    const { before, after } = await setTeamSettings(uid(req), accountId, {
      allowSnooze: typeof b.allowSnooze === 'boolean' ? b.allowSnooze : undefined, autoAssign: b.autoAssign, pool: b.pool });
    const poolOf = (t: typeof before) => t.members.filter((m) => m.inPool).map((m) => m.userId);
    await audit(req, 'mailbox.team_settings', { type: 'account', id: accountId }, {
      allowSnooze: [before.allowSnooze, after.allowSnooze], autoAssign: [before.autoAssign, after.autoAssign], pool: [poolOf(before), poolOf(after)] });
    return after;
  });

  /** The signed-in user switches themselves away / back for one mailbox's round robin. */
  app.put('/api/accounts/:id/team/away', async (req) => {
    const accountId = Number((req.params as any).id);
    const away = !!(req.body as any)?.away;
    await setAway(uid(req), accountId, away);
    await audit(req, 'mailbox.round_robin_away', { type: 'account', id: accountId }, { away });
    return { ok: true, away };
  });

  app.get('/api/team/pools', async (req) => myPools(uid(req)));
}
