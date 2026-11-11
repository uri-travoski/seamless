/**
 * Open tracking: record a pixel hit, rate-limit and dedupe it, and raise `mail.opened`.
 *
 * - 30 recorded hits per minute per token (a forwarded newsletter can't flood the DB).
 * - The same IP hitting the same token within 60 s is stored (the log stays honest) but
 *   not re-broadcast or re-notified.
 */
import { q, one, run, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { pixelLimiter, pixelDedupe } from '../security/ratelimit.ts';
import { emitEvent } from '../events/emit.ts';

export interface OpenResult { recorded: boolean; announced: boolean }

export async function recordOpen(token: string, ip: string, ua: string, now = Date.now()): Promise<OpenResult> {
  if (!pixelLimiter.hit(`tok:${token}`, now)) return { recorded: false, announced: false };
  const fresh = pixelDedupe.hit(`${token}|${ip}`, now);
  await run('INSERT INTO tracking_opens(token, ts, ip, ua) VALUES (?,?,?,?)', [token, now, ip, ua.slice(0, 300)]);
  if (!fresh) return { recorded: true, announced: false };

  // the sent copy carrying this token (Sent first; a token can also sit on a draft/scheduled copy)
  const msg = await one<{ id: number; user_id: number; account_id: number; subject: string; to_json: string }>(`
    SELECT m.id, m.user_id, m.account_id, m.subject, m.to_json
    FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.tracking_token = ?
    ORDER BY CASE mb.role WHEN 'sent' THEN 0 ELSE 1 END, m.id LIMIT 1`, [token]);

  await bumpState();
  if (msg) {
    let to: { name?: string; email?: string }[] = [];
    try { to = JSON.parse(msg.to_json); } catch { /* empty */ }
    const first = to[0];
    const recipient = first ? (first.name || first.email || '') : '';
    await emitEvent(msg.user_id, 'mail.opened', { type: 'message', id: msg.id }, {
      messageId: msg.id, accountId: msg.account_id, subject: msg.subject, recipient, token, ip,
    });
    broadcast({ type: 'stateChange' }, msg.user_id);
  } else {
    broadcast({ type: 'stateChange' });
  }
  return { recorded: true, announced: true };
}

export async function openCount(token: string): Promise<number> {
  return (await q<{ c: number }>('SELECT COUNT(*) AS c FROM tracking_opens WHERE token = ?', [token]))[0]?.c ?? 0;
}
