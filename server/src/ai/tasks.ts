import { q, run, bumpState } from '../db.ts';
import { chatComplete, extractJson, getTaskProvider } from './client.ts';
import { getParsed } from '../mail/body.ts';
import { getMsgRow } from '../mail/store.ts';
import { htmlToPlain } from '../mail/send.ts';

async function messageText(rowId: number, maxLen = 4000): Promise<string> {
  const parsed = await getParsed(rowId);
  if (!parsed) return '';
  const text = parsed.text ?? (parsed.html ? htmlToPlain(String(parsed.html)) : '');
  return text.slice(0, maxLen);
}

/** Auto-assign one of the user's labels to an incoming message. */
export async function categorizeEmail(userId: number, rowId: number): Promise<string | null> {
  const provider = await getTaskProvider(userId, 'categorize');
  if (!provider) return null;
  const labels = await q<{ id: number; name: string; description: string }>(
    'SELECT id, name, description FROM labels WHERE user_id = ? ORDER BY sort, id', [userId]);
  if (labels.length === 0) return null;
  const row = await getMsgRow(userId, `m${rowId}`);
  if (!row) return null;
  const body = await messageText(rowId, 2500);

  const labelList = labels.map((l) => `- "${l.name}"${l.description ? `: ${l.description}` : ''}`).join('\n');
  const out = await chatComplete(provider, [
    {
      role: 'system',
      content: `You categorize incoming email into exactly one of the user's labels, or none. Respond with JSON only: {"label": "<label name>"} or {"label": null}. Available labels:\n${labelList}`,
    },
    {
      role: 'user',
      content: `From: ${row.from_name} <${row.from_addr}>\nSubject: ${row.subject}\n\n${body}`,
    },
  ], { json: true, maxTokens: 100 });

  const parsed = extractJson(out);
  const name = parsed?.label;
  if (typeof name !== 'string') return null;
  const label = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (!label) return null;
  await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?) ON CONFLICT DO NOTHING', [rowId, label.id]);
  await bumpState();
  return label.name;
}

export async function summarizeThread(userId: number, threadId: string): Promise<string> {
  const provider = await getTaskProvider(userId, 'summarize');
  if (!provider) throw new Error('No AI provider configured for summarize (Settings > AI)');
  const rows = await q<{ id: number; subject: string; from_name: string; from_addr: string; date: number }>(`
    SELECT m.id, m.subject, m.from_name, m.from_addr, m.date FROM messages m
    JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.user_id = ? AND m.thread_id = ? AND (mb.role IS NULL OR mb.role NOT IN ('trash','junk'))
    ORDER BY m.date ASC
  `, [userId, threadId]);
  if (rows.length === 0) throw new Error('Thread not found');

  const recent = rows.slice(-10);
  const parts: string[] = [];
  for (const r of recent) {
    const text = await messageText(r.id, 3000);
    parts.push(`--- ${new Date(r.date).toISOString().slice(0, 16)} | ${r.from_name} <${r.from_addr}>\n${text}`);
  }
  return chatComplete(provider, [
    {
      role: 'system',
      content: 'Summarize this email thread concisely: 2-5 bullet points covering decisions, asks, and open items. Plain text, "- " bullets, no preamble.',
    },
    { role: 'user', content: `Subject: ${recent[0].subject}\n\n${parts.join('\n\n')}` },
  ], { maxTokens: 500 });
}

export interface TeachDirectives {
  summary: string;
  label: string | null;         // proposed label name (existing or new)
  retentionDays: number | null;
  autoRead: boolean;
  deleteIfUnread: boolean;
}

/** Parse a plain-English "teach the AI" instruction into structured directives. */
export async function parseTeachNote(userId: number, emailId: string, note: string): Promise<TeachDirectives> {
  const fallback: TeachDirectives = { summary: note.trim().slice(0, 160), label: null, retentionDays: null, autoRead: false, deleteIfUnread: false };
  const provider = await getTaskProvider(userId, 'classify');
  const row = await getMsgRow(userId, emailId);
  if (!provider || !row) return fallback;
  const labels = await q<{ name: string; description: string }>(
    'SELECT name, description FROM labels WHERE user_id = ? ORDER BY sort, id', [userId]);
  const labelList = labels.map((l) => `- "${l.name}"${l.description ? `: ${l.description}` : ''}`).join('\n') || '(none yet)';
  const out = await chatComplete(provider, [
    {
      role: 'system',
      content: `Convert the user's instruction about handling an email into structured directives for future similar mail. Respond JSON only: {"summary": string, "label": string|null, "retention_days": number|null, "auto_read": boolean, "delete_if_unread": boolean}. "summary" restates the rule in one short sentence. "label" is a short category name to file matching mail under — reuse one of the user's existing labels if it fits, otherwise propose a concise new name. Existing labels:\n${labelList}`,
    },
    { role: 'user', content: `Email — From: ${row.from_name} <${row.from_addr}>\nSubject: ${row.subject}\n${row.snippet}\n\nInstruction: ${note}` },
  ], { json: true, maxTokens: 200 });
  const p = extractJson(out) ?? {};
  return {
    summary: typeof p.summary === 'string' && p.summary.trim() ? p.summary.trim() : fallback.summary,
    label: typeof p.label === 'string' && p.label.trim() ? p.label.trim() : null,
    retentionDays: Number.isFinite(p.retention_days) ? Number(p.retention_days) : null,
    autoRead: !!p.auto_read,
    deleteIfUnread: !!p.delete_if_unread,
  };
}

export async function draftReply(userId: number, emailId: string, instruction: string): Promise<string> {
  const provider = await getTaskProvider(userId, 'draft');
  if (!provider) throw new Error('No AI provider configured for draft (Settings > AI)');
  const row = await getMsgRow(userId, emailId);
  if (!row) throw new Error('Message not found');
  const body = await messageText(row.id, 5000);
  return chatComplete(provider, [
    {
      role: 'system',
      content: 'Draft a reply to the email below. Match its language and formality. Output only the reply body as plain text paragraphs — no subject line, no signature, no commentary.',
    },
    {
      role: 'user',
      content: `From: ${row.from_name} <${row.from_addr}>\nSubject: ${row.subject}\n\n${body}\n\n---\nInstruction for the reply: ${instruction || 'Write an appropriate reply.'}`,
    },
  ], { maxTokens: 800 });
}

/** Plain text of the last messages of a thread (for template AI fill). */
export async function threadText(userId: number, threadId: string, maxMsgs = 6): Promise<string> {
  const rows = await q<{ id: number; from_name: string; from_addr: string; date: number }>(`
    SELECT m.id, m.from_name, m.from_addr, m.date FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.user_id = ? AND m.thread_id = ? AND (mb.role IS NULL OR mb.role NOT IN ('trash','junk'))
    ORDER BY m.date DESC LIMIT ?`, [userId, threadId, maxMsgs]);
  const parts: string[] = [];
  for (const r of rows.reverse()) parts.push(`--- ${new Date(Number(r.date)).toISOString().slice(0, 16)} | ${r.from_name} <${r.from_addr}>\n${await messageText(r.id, 2500)}`);
  return parts.join('\n\n');
}
