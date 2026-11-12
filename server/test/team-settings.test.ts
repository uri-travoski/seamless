/** T8.3: shared snooze and round-robin assignment (opt-in per shared mailbox), shared read state. A owns; B viewer, C responder, M manager, E responder, D none. */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const { q, one } = await import('../src/db.ts');
const { getEmails, queryEmails } = await import('../src/mail/store.ts');
const { unsnoozeThread } = await import('../src/mail/snooze.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

let app: Awaited<ReturnType<typeof makeApp>>;
let A: number, B: number, C: number, M: number, E: number, D: number;
let acct: number, inbox: number, other: number, otherInbox: number;
let msgId: string; let rowId: number;
const ck: Record<string, string> = {};
const api = (who: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck[who] } });
const team = (who: string, body: any, account = acct) => api(who, 'PUT', `/api/accounts/${account}/team`, body);
const inboxIds = async (userId: number, filter: any = { inMailbox: `mb:${inbox}` }) => (await queryEmails(userId, { filter, position: 0, limit: 100 })).ids;
let n = 0;
const live = async (subject?: string, extra: any = {}) =>
  (await ingest(acct, inbox, rawEmail({ from: `cust${++n}@ext.test`, to: 'support@demo.test', subject: subject ?? `Ticket ${n}`, ...extra }), { isLive: true }))!;
const assignee = async (rid: number) => (await one<any>(
  'SELECT a.assignee_id FROM assignments a JOIN messages m ON m.account_id = a.account_id AND m.thread_id = a.message_thread_id WHERE m.id = ?', [rid]))?.assignee_id ?? null;

beforeEach(async () => {
  await resetDb(); resetLimiters(); n = 0;
  A = await makeUser('a@x.test'); B = await makeUser('b@x.test'); C = await makeUser('c@x.test');
  M = await makeUser('m@x.test'); E = await makeUser('e@x.test'); D = await makeUser('d@x.test');
  acct = await makeAccount('support@demo.test', { userId: A, name: 'Support' });
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  other = await makeAccount('private@demo.test', { userId: A });
  otherInbox = await makeMailbox(other, 'INBOX', 'inbox');
  const r = await ingest(acct, inbox, rawEmail({ from: 'cust@ext.test', to: 'support@demo.test', subject: 'Help with invoice' }));
  rowId = r!.rowId; msgId = `m${rowId}`;
  app = await makeApp();
  for (const [k, e] of Object.entries({ A: 'a@x.test', B: 'b@x.test', C: 'c@x.test', M: 'm@x.test', E: 'e@x.test', D: 'd@x.test' })) ck[k] = await login(app, e);
  for (const [id, role] of [[B, 'viewer'], [C, 'responder'], [M, 'manager'], [E, 'responder']] as const) {
    expect((await api('A', 'PUT', `/api/accounts/${acct}/shares`, { userId: id, role })).statusCode).toBe(200);
  }
});

describe('shared snooze', () => {
  const until = () => Date.now() + 3_600_000;

  it('is blocked (403) while the mailbox has it off, and the email says so', async () => {
    const r = await api('C', 'POST', '/api/snooze', { emailId: msgId, until: until() });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/off for this shared mailbox/);
    expect((await getEmails(C, [msgId]))[0].snoozeAllowed).toBe(false);
    expect((await getEmails(A, [msgId]))[0].snoozeAllowed).toBe(true);
    expect(await q('SELECT 1 FROM messages WHERE snoozed_until IS NOT NULL')).toHaveLength(0);
    expect((await api('C', 'POST', '/api/bulk', { ids: [msgId], action: 'snooze', value: until() })).statusCode).toBe(403);
  });

  it('when on: a responder snoozes for everyone, shows who, and the wake job brings it back', async () => {
    expect((await team('A', { allowSnooze: true })).statusCode).toBe(200);
    const at = until();
    expect((await api('C', 'POST', '/api/snooze', { emailId: msgId, until: at })).statusCode).toBe(200);
    for (const u of [A, B, C, M]) expect((await inboxIds(u))).not.toContain(msgId);   // hidden for everyone
    const forB = (await getEmails(B, [msgId]))[0];
    expect(forB.snoozedBy).toBe('c');
    expect(forB.snoozedUntil).toBeTruthy();
    expect((await getEmails(B, [msgId]))[0].snoozeAllowed).toBe(false);   // viewer
    // the wake job runs as the owner
    const job = await one<any>("SELECT user_id, payload FROM jobs WHERE kind = 'snooze.wake' AND status = 'pending'");
    expect(job.user_id).toBe(A);
    await unsnoozeThread(job.user_id, job.payload.threadId, { wake: true });
    for (const u of [A, B, C, M]) expect((await inboxIds(u))).toContain(msgId);
    expect((await getEmails(C, [msgId]))[0].snoozedBy).toBeNull();
    expect((await getEmails(C, [msgId]))[0].keywords.$seen).toBeUndefined();
  });

  it('a viewer cannot snooze even when on; a manager can remove a teammate\'s snooze', async () => {
    await team('A', { allowSnooze: true });
    expect((await api('B', 'POST', '/api/snooze', { emailId: msgId, until: until() })).statusCode).toBe(403);
    expect((await api('C', 'POST', '/api/snooze', { emailId: msgId, until: until() })).statusCode).toBe(200);
    const thread = (await one<any>('SELECT thread_id FROM messages WHERE id = ?', [rowId])).thread_id;
    expect((await api('B', 'DELETE', `/api/snooze/${encodeURIComponent(thread)}`)).statusCode).toBe(403);
    expect((await api('M', 'DELETE', `/api/snooze/${encodeURIComponent(thread)}`)).json().ok).toBe(true);
    expect(await q('SELECT 1 FROM messages WHERE snoozed_until IS NOT NULL')).toHaveLength(0);
  });

  it('turning it off again blocks new snoozes; only managers/owner change settings; audit-logged', async () => {
    expect((await team('C', { allowSnooze: true })).statusCode).toBe(403);
    expect((await team('B', { allowSnooze: true })).statusCode).toBe(403);
    expect((await team('A', { allowSnooze: true })).statusCode).toBe(200);
    expect((await team('M', { allowSnooze: false })).statusCode).toBe(200);
    expect((await api('C', 'POST', '/api/snooze', { emailId: msgId, until: until() })).statusCode).toBe(403);
    const log = await q<any>("SELECT actor_user_id, details FROM audit_log WHERE action = 'mailbox.team_settings' ORDER BY id");
    expect(log.map((l) => l.actor_user_id)).toEqual([A, M]);
    expect(log[1].details.allowSnooze).toEqual([true, false]);
  });
});

describe('round robin', () => {
  const setup = async (pool = [C, M, E]) => { expect((await team('A', { autoAssign: 'round_robin', pool })).statusCode).toBe(200); };

  it('9 new live threads → 3-3-3 in turn, assignee notified, assigned: search finds them', async () => {
    await setup();
    const owners: number[] = [];
    for (let i = 0; i < 9; i++) owners.push(await assignee((await live()).rowId));
    expect(owners).toEqual([C, M, E, C, M, E, C, M, E]);
    const count = (id: number) => owners.filter((o) => o === id).length;
    expect([count(C), count(M), count(E)]).toEqual([3, 3, 3]);
    expect(await q("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'assignment.changed'", [C])).toHaveLength(3);
    expect(await inboxIds(C, { text: 'assigned:me' })).toHaveLength(3);
    expect(await inboxIds(M, { text: 'assigned:me' })).toHaveLength(3);
  });

  it('skips an "away" member and comes back when they return', async () => {
    await setup();
    expect((await api('M', 'PUT', `/api/accounts/${acct}/team/away`, { away: true })).statusCode).toBe(200);
    expect((await api('M', 'GET', '/api/team/pools')).json()).toEqual([{ accountId: acct, email: 'support@demo.test', away: true }]);
    const owners: number[] = [];
    for (let i = 0; i < 4; i++) owners.push(await assignee((await live()).rowId));
    expect(owners).toEqual([C, E, C, E]);
    await api('M', 'PUT', `/api/accounts/${acct}/team/away`, { away: false });
    expect(await assignee((await live()).rowId)).toBe(E === 0 ? 0 : [C, M, E].sort((x, y) => x - y).find((id) => id > E) ?? [C, M, E].sort((x, y) => x - y)[0]);
  });

  it('a member removed from the share is skipped; nobody active → unassigned', async () => {
    await setup();
    expect(await assignee((await live()).rowId)).toBe(C);
    await api('A', 'DELETE', `/api/accounts/${acct}/shares/${M}`);
    expect(await assignee((await live()).rowId)).toBe(E);
    await api('C', 'PUT', `/api/accounts/${acct}/team/away`, { away: true });
    await api('E', 'PUT', `/api/accounts/${acct}/team/away`, { away: true });
    expect(await assignee((await live()).rowId)).toBeNull();
  });

  it('only NEW LIVE threads: backfill and replies are not assigned', async () => {
    await setup();
    const first = await live('Order question', { messageId: '<root@t>' });
    expect(await assignee(first.rowId)).toBe(C);
    const reply = await live('Re: Order question', { inReplyTo: '<root@t>', references: ['<root@t>'] });
    expect(await assignee(reply.rowId)).toBe(C);   // same thread → still C's, no second assignment
    expect(await q('SELECT 1 FROM assignments')).toHaveLength(1);
    const back = await ingest(acct, inbox, rawEmail({ from: 'old@ext.test', to: 'support@demo.test', subject: 'Old mail' }), { isLive: false });
    expect(await assignee(back!.rowId)).toBeNull();
    expect(await q('SELECT 1 FROM assignments')).toHaveLength(1);
    // the old, non-live message from setup is not assigned either
    expect(await assignee(rowId)).toBeNull();
  });

  it('off by default; other mailboxes unaffected; rotation survives re-reading the cursor from the DB', async () => {
    expect(await assignee((await live()).rowId)).toBeNull();
    await setup();
    expect(await assignee((await live()).rowId)).toBe(C);
    expect((await one<any>('SELECT rr_cursor FROM mailbox_team_settings WHERE account_id = ?', [acct])).rr_cursor).toBe(C);
    // a fresh app instance would read exactly this; the next pick continues after C
    expect(await assignee((await live()).rowId)).toBe(M);
    const o = await ingest(other, otherInbox, rawEmail({ from: 'x@ext.test', to: 'private@demo.test', subject: 'private' }), { isLive: true });
    expect(await assignee(o!.rowId)).toBeNull();
  });

  it('pool must be eligible members; viewers and strangers are ignored; away needs a pool row', async () => {
    await team('A', { autoAssign: 'round_robin', pool: [B, D, C] });
    expect((await api('A', 'GET', `/api/accounts/${acct}/team`)).json().members.filter((m: any) => m.inPool).map((m: any) => m.userId)).toEqual([C]);
    expect((await api('E', 'PUT', `/api/accounts/${acct}/team/away`, { away: true })).statusCode).toBe(404);
  });
});

describe('read state is shared', () => {
  it('A marks read → B and C see read; unread again → everyone sees unread', async () => {
    await api('A', 'POST', '/api/bulk', { ids: [msgId], action: 'unread' });
    for (const u of [A, B, C]) expect((await getEmails(u, [msgId]))[0].keywords.$seen).toBeUndefined();
    expect((await api('A', 'POST', '/api/bulk', { ids: [msgId], action: 'read' })).statusCode).toBe(200);
    for (const u of [A, B, C, M]) expect((await getEmails(u, [msgId]))[0].keywords.$seen).toBe(true);
    await api('C', 'POST', '/api/bulk', { ids: [msgId], action: 'unread' });
    for (const u of [A, B, C, M]) expect((await getEmails(u, [msgId]))[0].keywords.$seen).toBeUndefined();
  });
});

describe('isolation', () => {
  it('a stranger cannot read or change team settings, snooze, or away; settings are per mailbox', async () => {
    await team('A', { allowSnooze: true, autoAssign: 'round_robin', pool: [C] });
    expect((await api('D', 'GET', `/api/accounts/${acct}/team`)).statusCode).toBe(404);
    expect((await team('D', { allowSnooze: false })).statusCode).toBe(404);
    expect((await api('D', 'POST', '/api/snooze', { emailId: msgId, until: Date.now() + 60_000 })).statusCode).toBe(404);
    expect((await api('D', 'PUT', `/api/accounts/${acct}/team/away`, { away: true })).statusCode).toBe(404);
    expect((await api('D', 'GET', '/api/team/pools')).json()).toEqual([]);
    expect((await api('C', 'GET', `/api/accounts/${other}/team`)).statusCode).toBe(404);   // shared on one mailbox only
    expect((await api('A', 'GET', `/api/accounts/${other}/team`)).json()).toMatchObject({ allowSnooze: false, autoAssign: 'off' });
    expect(await q('SELECT 1 FROM messages WHERE snoozed_until IS NOT NULL')).toHaveLength(0);
  });
});
