import { q, one, run } from '../db.ts';
import { getBlob } from '../s3.ts';
import { smtpTransport } from '../mail/send.ts';
import { plog } from './settings.ts';
import type { AccountRow } from '../imap/sync.ts';

const TICK_MS = 10 * 60_000;
const MAX_PER_RUN = 40; // quota guard (sheet: "Forward: max per run")

/**
 * Forwarding-out engine (the sheet's "Forwarding Out" tab): labelled mail is relayed
 * once to the configured address — e.g. everything labelled Receipts to the archive
 * account. The raw message is re-sent unchanged with a new envelope.
 */
export async function sweepForwarding(now = Date.now()): Promise<number> {
  const routes = await q<any>(`
    SELECT r.*, l.name AS label_name FROM routes r
    JOIN labels l ON l.id = r.label_id
    WHERE r.enabled = true
  `);
  let sent = 0;

  for (const route of routes) {
    if (sent >= MAX_PER_RUN) break;
    const candidates = await q<any>(`
      SELECT m.id, m.subject, m.account_id, m.s3_key, m.user_id
      FROM messages m
      JOIN message_labels ml ON ml.message_id = m.id AND ml.label_id = ?
      WHERE m.user_id = ? AND m.forwarded_at IS NULL AND m.s3_key IS NOT NULL
        AND m.classify_state IN ('classified','needs_review')
        AND m.date >= ?
      ORDER BY m.date
      LIMIT ${MAX_PER_RUN}
    `, [route.label_id, route.user_id, route.only_after ?? 0]);

    for (const c of candidates) {
      if (sent >= MAX_PER_RUN) break;
      try {
        const acct = await one<AccountRow>('SELECT * FROM accounts WHERE id = ? AND enabled = true', [c.account_id]);
        if (!acct) { await run('UPDATE messages SET forwarded_at = ? WHERE id = ?', [now, c.id]); continue; }
        const raw = await getBlob(c.s3_key);
        const transport = await smtpTransport(acct);
        await transport.sendMail({ envelope: { from: acct.email, to: [route.forward_to] }, raw });
        await run('UPDATE messages SET forwarded_at = ? WHERE id = ?', [now, c.id]);
        sent++;
        await plog(c.user_id, 'send', `forwarded "${c.subject}" (${route.label_name}) to ${route.forward_to}`, { emailId: c.id });
      } catch (err: any) {
        await plog(c.user_id, 'send', `forward failed for "${c.subject}": ${err?.message ?? err}`, { emailId: c.id, level: 'warn' });
      }
    }
  }
  return sent;
}

export function startForwarding(): void {
  setInterval(() => { void sweepForwarding().catch((e) => console.error('[forward]', e?.message ?? e)); }, TICK_MS);
  setTimeout(() => { void sweepForwarding().catch(() => {}); }, 40_000);
}
