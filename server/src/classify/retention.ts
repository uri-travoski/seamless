import { q, one, run, bumpState } from '../db.ts';
import { moveEmail, destroyEmail } from '../mail/store.ts';
import { getUserSetting, plog, pruneLogs } from './settings.ts';

const TICK_MS = 60 * 60 * 1000; // hourly

let broadcastChange: (userId: number) => void = () => {};
export function onRetention(fn: (userId: number) => void): void { broadcastChange = fn; }

interface Candidate { id: number; user_id: number; subject: string; from_addr: string; delete_at: number }

/**
 * The retention sweep (DESIGN.md §4). Never touches: protected labels, user_touched,
 * trash/junk/sent/drafts/scheduled. Dry-run (default ON) only logs what it would do.
 * Deleting = recoverable Trash; purge only expunges what the sweep itself trashed,
 * after the trash grace window.
 */
export async function sweepRetention(now = Date.now()): Promise<{ trashed: number; purged: number; dryRun: number }> {
  const stats = { trashed: 0, purged: 0, dryRun: 0 };
  const users = await q<{ id: number }>('SELECT id FROM users');

  for (const u of users) {
    const dryRun = (await getUserSetting(u.id, 'dry_run')) !== 'false';
    const trashDays = Number(await getUserSetting(u.id, 'trash_days')) || 30;

    const candidates = await q<Candidate>(`
      SELECT m.id, m.user_id, m.subject, m.from_addr, m.delete_at
      FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE m.user_id = ? AND m.disposition = 'delete' AND m.delete_at IS NOT NULL AND m.delete_at < ?
        AND m.user_touched = false
        AND NOT (m.delete_if_unread AND m.opened_at IS NOT NULL)  -- "delete only if I never read it"
        AND (mb.role IS NULL OR mb.role IN ('inbox','archive'))
        AND NOT EXISTS (
          SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id
          WHERE ml.message_id = m.id AND (l.protected OR l.keep_default)
        )
      ORDER BY m.delete_at
      LIMIT 500
    `, [u.id, now]);

    for (const c of candidates) {
      if (dryRun) {
        stats.dryRun++;
        await plog(u.id, 'retention', `DRY RUN: would trash "${c.subject}" from ${c.from_addr} (due ${new Date(c.delete_at).toISOString().slice(0, 10)})`, { emailId: c.id });
      } else {
        await moveEmail(u.id, `m${c.id}`, 'u:trash');
        await run('UPDATE messages SET trashed_at = ? WHERE id = ?', [now, c.id]);
        stats.trashed++;
        await plog(u.id, 'retention', `trashed "${c.subject}" from ${c.from_addr}`, { emailId: c.id });
      }
    }

    // purge: only messages the sweep itself moved to trash, after the grace window
    const purgeable = await q<{ id: number; subject: string }>(`
      SELECT m.id, m.subject FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
      WHERE m.user_id = ? AND mb.role = 'trash' AND m.trashed_at IS NOT NULL AND m.trashed_at < ?
      LIMIT 500
    `, [u.id, now - trashDays * 86_400_000]);
    for (const p of purgeable) {
      if (dryRun) {
        stats.dryRun++;
        await plog(u.id, 'retention', `DRY RUN: would purge "${p.subject}" from Trash`, { emailId: p.id });
      } else {
        await destroyEmail(u.id, `m${p.id}`); // in trash -> expunge
        stats.purged++;
        await plog(u.id, 'retention', `purged "${p.subject}" from Trash`, { emailId: p.id });
      }
    }

    if (candidates.length || purgeable.length) broadcastChange(u.id);
  }

  await pruneLogs();
  if (stats.trashed || stats.purged) await bumpState();
  return stats;
}

export function startRetention(): void {
  setInterval(() => { void sweepRetention().catch((e) => console.error('[retention]', e?.message ?? e)); }, TICK_MS);
  setTimeout(() => { void sweepRetention().catch((e) => console.error('[retention]', e?.message ?? e)); }, 15_000);
}
