import { registerJob, enqueueJob } from '../jobs/runner.ts';
import { one } from '../db.ts';
import { pruneAudit } from './log.ts';

const DAY = 86_400_000;

registerJob('audit.prune', async () => {
  try { await pruneAudit(); }
  finally { await enqueueJob(null, 'audit.prune', Date.now() + DAY, {}); }   // next run, even when this one failed
});

/** Make sure exactly one pending daily `audit.prune` job exists. Safe to call on every boot. */
export async function ensureAuditPruneJob(now = Date.now()): Promise<void> {
  const pending = await one(`SELECT 1 FROM jobs WHERE kind = 'audit.prune' AND status IN ('pending','running') LIMIT 1`);
  if (!pending) await enqueueJob(null, 'audit.prune', now + DAY, {});
}
