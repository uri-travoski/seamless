import { q, one, run, bumpState } from '../db.ts';
import { sha256 } from '../crypto.ts';
import { getBlob } from '../s3.ts';
import { enqueueOp, type AccountRow } from '../imap/sync.ts';
import { plog } from './settings.ts';

const TICK_MS = 60 * 60 * 1000; // hourly
const BATCH = 200;

/**
 * Safe delete (DESIGN.md §8): once a message is verifiably archived in Seamless,
 * remove the origin copy so the mailbox quota stops growing. A message qualifies only when:
 *   - the account has safe delete switched ON (per-account, default OFF)
 *   - the raw .eml is in S3 AND its sha256 matches the key it was stored under
 *   - it is classified and older than the grace window (origin keeps recent mail)
 * Removal = move to the origin's Trash (its own ~30-day trash is a second net), or
 * expunge when the account is set to that. The local copy becomes the record:
 * origin_state='removed' + a placeholder uid make sync ignore it forever.
 */

export interface SafeDeleteStats { removed: number; failedVerify: number }

export async function safeDeleteCandidates(accountId: number, graceDays: number, now: number): Promise<any[]> {
  return q(`
    SELECT m.id, m.uid, m.mailbox_id, m.subject, m.s3_key, m.user_id
    FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.account_id = ? AND m.origin_state = 'present' AND m.uid > 0
      AND m.classify_state IN ('classified','needs_review')
      AND m.s3_key IS NOT NULL
      AND m.date < ?
      AND (mb.role IS NULL OR mb.role IN ('inbox','archive'))
    ORDER BY m.date
    LIMIT ${BATCH}
  `, [accountId, now - graceDays * 86_400_000]);
}

/** The gate: the blob must exist and hash to the digest embedded in its S3 key. */
export async function verifyBlob(s3Key: string): Promise<boolean> {
  const m = s3Key.match(/([a-f0-9]{64})\.eml$/);
  if (!m) return false;
  try {
    const raw = await getBlob(s3Key);
    return sha256(raw) === m[1];
  } catch {
    return false;
  }
}

export async function sweepSafeDelete(now = Date.now()): Promise<SafeDeleteStats> {
  const stats: SafeDeleteStats = { removed: 0, failedVerify: 0 };
  const accounts = await q<AccountRow>('SELECT * FROM accounts WHERE enabled = true AND safe_delete_enabled = true');

  for (const acct of accounts) {
    const candidates = await safeDeleteCandidates(acct.id, acct.safe_delete_grace_days || 30, now);
    for (const c of candidates) {
      if (!(await verifyBlob(c.s3_key))) {
        stats.failedVerify++;
        await plog(c.user_id, 'safe_delete', `SKIPPED "${c.subject}" — archive copy failed verification`, { emailId: c.id, level: 'warn' });
        continue;
      }
      const op = acct.safe_delete_mode === 'expunge' ? 'expunge' : 'move';
      if (op === 'move') {
        await enqueueOp(acct.id, 'move', { mailboxId: c.mailbox_id, uid: c.uid, targetRole: 'trash' });
      } else {
        await enqueueOp(acct.id, 'expunge', { mailboxId: c.mailbox_id, uid: c.uid });
      }
      // local copy is the record now; sync must never delete it
      await run("UPDATE messages SET origin_state = 'removed', origin_deleted_at = ?, uid = ? WHERE id = ?", [now, -c.id, c.id]);
      stats.removed++;
      await plog(c.user_id, 'safe_delete',
        `origin ${acct.safe_delete_mode === 'expunge' ? 'expunged' : 'trashed'} "${c.subject}" (verified archive copy kept)`, { emailId: c.id });
    }
    if (candidates.length) await bumpState();
  }
  return stats;
}

/** Preview for the UI: how many messages a live run would remove right now. */
export async function safeDeletePreview(userId: number, accountId: number): Promise<{ count: number; oldest: string | null }> {
  const acct = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND user_id = ?', [accountId, userId]);
  if (!acct) return { count: 0, oldest: null };
  const rows = await q<{ c: number; oldest: number | null }>(`
    SELECT COUNT(*) AS c, MIN(m.date) AS oldest
    FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.account_id = ? AND m.origin_state = 'present' AND m.uid > 0
      AND m.classify_state IN ('classified','needs_review') AND m.s3_key IS NOT NULL
      AND m.date < ? AND (mb.role IS NULL OR mb.role IN ('inbox','archive'))
  `, [accountId, Date.now() - (acct.safe_delete_grace_days || 30) * 86_400_000]);
  return { count: rows[0]?.c ?? 0, oldest: rows[0]?.oldest ? new Date(rows[0].oldest).toISOString() : null };
}

export function startSafeDelete(): void {
  setInterval(() => { void sweepSafeDelete().catch((e) => console.error('[safedelete]', e?.message ?? e)); }, TICK_MS);
  setTimeout(() => { void sweepSafeDelete().catch((e) => console.error('[safedelete]', e?.message ?? e)); }, 25_000);
}
