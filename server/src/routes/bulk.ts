/**
 * Per-email actions at scale (T1 F-16): "select all N matching" runs here in batches,
 * records what each message looked like before, and can undo the lot. Also block-sender.
 */
import type { FastifyInstance } from 'fastify';
import type { EmailQueryFilter } from '@seamless/shared';
import { q, one, insertId, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { queryEmails, getMsgRow, setKeywords, moveEmail, setLabels, destroyEmail } from '../mail/store.ts';
import { randomToken } from '../crypto.ts';
import { uid } from './util.ts';

export type BulkAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'inbox' | 'spam' | 'delete' | 'move' | 'label' | 'unlabel';

interface Snapshot { id: string; mailboxId: number; unread: boolean; flagged: boolean; labelIds: number[]; removed: boolean }

const UNDO_MS = 10 * 60_000;
const MAX = 20_000;
const undoStore = new Map<string, { userId: number; at: number; snaps: Snapshot[] }>();

async function snapshot(userId: number, emailId: string): Promise<Snapshot | null> {
  const row = await getMsgRow(userId, emailId);
  if (!row) return null;
  const labels = await q<{ label_id: number }>('SELECT label_id FROM message_labels WHERE message_id = ?', [row.id]);
  return { id: `m${row.id}`, mailboxId: row.mailbox_id, unread: row.unread, flagged: row.flagged, labelIds: labels.map((l) => l.label_id), removed: false };
}

async function applyOne(userId: number, emailId: string, action: BulkAction, value: string | number | undefined, snap: Snapshot): Promise<void> {
  switch (action) {
    case 'read': return setKeywords(userId, emailId, { $seen: true });
    case 'unread': return setKeywords(userId, emailId, { $seen: false });
    case 'star': return setKeywords(userId, emailId, { $flagged: true });
    case 'unstar': return setKeywords(userId, emailId, { $flagged: false });
    case 'archive': return moveEmail(userId, emailId, 'u:archive');
    case 'inbox': return moveEmail(userId, emailId, 'u:inbox');
    case 'spam': return moveEmail(userId, emailId, 'u:junk');
    case 'move': return moveEmail(userId, emailId, String(value ?? ''));
    case 'label': return setLabels(userId, emailId, [...new Set([...snap.labelIds, Number(value)])]);
    case 'unlabel': return setLabels(userId, emailId, snap.labelIds.filter((l) => l !== Number(value)));
    case 'delete': {
      const role = (await one<{ role: string | null }>('SELECT role FROM mailboxes WHERE id = ?', [snap.mailboxId]))?.role;
      // already in Bin/Spam (or Scheduled): permanent, so it can't be undone
      if (role === 'trash' || role === 'junk' || role === 'scheduled') snap.removed = true;
      return destroyEmail(userId, emailId);
    }
  }
}

/** Ids for the action: explicit ids, or everything matching a list filter (capped). */
async function resolveIds(userId: number, b: { ids?: string[]; filter?: EmailQueryFilter }): Promise<string[]> {
  if (Array.isArray(b.ids) && b.ids.length) return b.ids.map(String).slice(0, MAX);
  if (!b.filter) return [];
  const out: string[] = [];
  for (let pos = 0; pos < MAX; pos += 500) {
    const page = await queryEmails(userId, { filter: b.filter, position: pos, limit: 500 });
    out.push(...page.ids);
    if (page.ids.length < 500) break;
  }
  return out;
}

export async function runBulk(userId: number, b: { ids?: string[]; filter?: EmailQueryFilter; action: BulkAction; value?: string | number }) {
  const ids = await resolveIds(userId, b);
  const snaps: Snapshot[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    for (const id of ids.slice(i, i + 200)) {
      const snap = await snapshot(userId, id);
      if (!snap) continue;
      await applyOne(userId, id, b.action, b.value, snap);
      snaps.push(snap);
    }
    broadcast({ type: 'stateChange' }, userId);   // progress: other tabs follow along
  }
  await bumpState();
  const undoToken = randomToken(12);
  undoStore.set(undoToken, { userId, at: Date.now(), snaps });
  for (const [k, v] of undoStore) if (Date.now() - v.at > UNDO_MS) undoStore.delete(k);
  return { affected: snaps.length, undoToken, undoable: snaps.some((s) => !s.removed) };
}

export async function undoBulk(userId: number, token: string): Promise<number> {
  const entry = undoStore.get(token);
  if (!entry || entry.userId !== userId) return -1;
  undoStore.delete(token);
  let n = 0;
  for (const s of entry.snaps) {
    if (s.removed) continue;
    const row = await getMsgRow(userId, s.id);
    if (!row) continue;
    if (row.mailbox_id !== s.mailboxId) await moveEmail(userId, s.id, `mb:${s.mailboxId}`);
    await setKeywords(userId, s.id, { $seen: !s.unread, $flagged: s.flagged });
    const now = (await q<{ label_id: number }>('SELECT label_id FROM message_labels WHERE message_id = ?', [row.id])).map((l) => l.label_id).sort();
    if (now.join() !== [...s.labelIds].sort().join()) await setLabels(userId, s.id, s.labelIds);
    n++;
  }
  await bumpState();
  broadcast({ type: 'stateChange' }, userId);
  return n;
}

const ACTIONS = new Set<BulkAction>(['read', 'unread', 'star', 'unstar', 'archive', 'inbox', 'spam', 'delete', 'move', 'label', 'unlabel']);

export function register(app: FastifyInstance): void {
  app.post('/api/bulk', async (req, reply) => {
    const b = req.body as { ids?: string[]; filter?: EmailQueryFilter; action: BulkAction; value?: string | number };
    if (!ACTIONS.has(b?.action)) return reply.code(400).send({ error: 'unknown action' });
    if ((b.action === 'label' || b.action === 'unlabel') && !Number(b.value)) return reply.code(400).send({ error: 'label id required' });
    if (b.action === 'move' && !/^(mb|u):/.test(String(b.value ?? ''))) return reply.code(400).send({ error: 'target mailbox required' });
    return runBulk(uid(req), b);
  });

  app.post('/api/bulk/undo', async (req, reply) => {
    const n = await undoBulk(uid(req), String((req.body as any)?.undoToken ?? ''));
    if (n < 0) return reply.code(404).send({ error: 'nothing to undo (it expired)' });
    return { restored: n };
  });

  /** Block sender: a filter that sends their future mail to Spam, and this message goes there now. */
  app.post('/api/block-sender', async (req, reply) => {
    const userId = uid(req);
    const row = await getMsgRow(userId, String((req.body as any)?.emailId ?? ''));
    if (!row) return reply.code(404).send({ error: 'not found' });
    const addr = row.from_addr.toLowerCase();
    const existing = (await q<{ conditions: string }>('SELECT conditions FROM filters WHERE user_id = ?', [userId]))
      .some((f) => (JSON.parse(f.conditions) as any[]).some((c) => c.field === 'from' && String(c.value).toLowerCase() === `<${addr}>`));
    if (!existing) {
      await insertId('INSERT INTO filters(user_id, name, enabled, sort, match, conditions, actions, stop) VALUES (?,?,?,?,?,?,?,?)',
        [userId, `Block ${addr}`, true, 0, 'all', // "from" is matched as `Name <addr>`, so look for the bracketed address exactly
         JSON.stringify([{ field: 'from', op: 'contains', value: `<${addr}>` }]),
         JSON.stringify([{ type: 'move', value: 'junk' }]), true]);
    }
    await moveEmail(userId, `m${row.id}`, 'u:junk');
    broadcast({ type: 'stateChange' }, userId);
    return { ok: true, address: addr, filterCreated: !existing };
  });
}
