import { one } from '../db.ts';
import { sha256 } from '../crypto.ts';

export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  // strip repeated Re:/Fwd:/Fw: prefixes, incl. localized bracketed counters like "Re[2]:"
  const re = /^\s*(re|fwd|fw|aw|sv|vs)(\[\d+\])?\s*:\s*/i;
  while (re.test(s)) s = s.replace(re, '');
  return s.trim().toLowerCase();
}

/**
 * Assign a thread id for an incoming message (scoped to one user, so
 * cross-account copies of the same conversation still merge).
 * 1. If any referenced message-id (References + In-Reply-To) exists locally, join its thread.
 * 2. Else if another copy of the same message-id exists (cross-account), join it.
 * 3. Else start a new thread keyed on this message-id (or content hash fallback).
 */
export async function assignThreadId(userId: number, args: {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
}): Promise<string> {
  const refs = [...args.references];
  if (args.inReplyTo) refs.push(args.inReplyTo);
  const uniq = [...new Set(refs.filter(Boolean))];

  if (uniq.length > 0) {
    const row = await one<{ thread_id: string }>(
      'SELECT thread_id FROM messages WHERE user_id = ? AND message_id = ANY(?) ORDER BY date ASC LIMIT 1',
      [userId, uniq],
    );
    if (row) return row.thread_id;
  }

  if (args.messageId) {
    const row = await one<{ thread_id: string }>(
      'SELECT thread_id FROM messages WHERE user_id = ? AND message_id = ? LIMIT 1',
      [userId, args.messageId],
    );
    if (row) return row.thread_id;
    return 't' + sha256(args.messageId).slice(0, 16);
  }

  return 't' + sha256(String(Math.random()) + Date.now()).slice(0, 16);
}
