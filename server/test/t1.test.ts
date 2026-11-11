import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { resetDb, TEST_USER, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';
import { makeApp, resetLimiters, login } from './app.ts';
import { q, one, run, insertId } from '../src/db.ts';
import { queryEmails, listMailboxes } from '../src/mail/store.ts';
import { categoryOverview, ensureBuiltinCategories, setAccountCategories } from '../src/mail/categories.ts';
import { renderTemplate, templateQuestions } from '@seamless/shared';
import { createAppPassword } from '../src/facade/auth.ts';
import { startImapFacade } from '../src/facade/imap.ts';
import { startSmtpFacade } from '../src/facade/smtp.ts';

const app = await makeApp();
afterAll(() => app.close());

/** Three mailboxes: A (work), B (personal), C (work + personal). */
async function threeMailboxes(userId = TEST_USER) {
  await ensureBuiltinCategories(userId);
  const cats = await q<{ id: number; key: string }>('SELECT id, key FROM mailbox_categories WHERE user_id = ?', [userId]);
  const work = cats.find((c) => c.key === 'work')!.id;
  const personal = cats.find((c) => c.key === 'personal')!.id;
  const A = await makeAccount(`a${userId}@x.test`, { userId });
  const B = await makeAccount(`b${userId}@x.test`, { userId });
  const C = await makeAccount(`c${userId}@x.test`, { userId });
  await setAccountCategories(userId, A, [work]);
  await setAccountCategories(userId, B, [personal]);
  await setAccountCategories(userId, C, [work, personal]);
  const inbox: Record<string, number> = {};
  for (const [k, id] of Object.entries({ A, B, C })) {
    inbox[k] = await makeMailbox(id, 'INBOX', 'inbox');
    await makeMailbox(id, 'Sent', 'sent');
    // two unread + one read per mailbox
    for (let i = 0; i < 3; i++) {
      await ingest(id, inbox[k], rawEmail({ from: `s${i}@ext.test`, to: `${k}@x.test`, subject: `${k} mail ${i} quarterly` }),
        { flags: i === 2 ? ['\\Seen'] : [] });
    }
  }
  return { A, B, C, work, personal, inbox };
}

describe('F-07 categories + scope', () => {
  beforeEach(async () => { await resetDb(); resetLimiters(); });

  it('scope category:work lists A + C mail only; unified lists all three', async () => {
    const { A, C, work } = await threeMailboxes();
    const w = await queryEmails(TEST_USER, { filter: { scope: `category:${work}`, inMailbox: 'u:inbox' }, position: 0, limit: 50 });
    expect(w.total).toBe(6);
    const accts = await q<{ account_id: number }>('SELECT DISTINCT account_id FROM messages WHERE id = ANY(?::int[])', [w.ids.map((i) => Number(i.slice(1)))]);
    expect(accts.map((a) => a.account_id).sort()).toEqual([A, C].sort());
    const all = await queryEmails(TEST_USER, { filter: { inMailbox: 'u:inbox' }, position: 0, limit: 50 });
    expect(all.total).toBe(9);
  });

  it('unread counts per category are right and C is not double counted in Unified', async () => {
    const { work, personal } = await threeMailboxes();
    const o = await categoryOverview(TEST_USER);
    expect(o.unifiedUnread).toBe(6);
    expect(o.categories.find((c) => c.id === work)!.unread).toBe(4);
    expect(o.categories.find((c) => c.id === personal)!.unread).toBe(4);
    expect(o.categories.find((c) => c.key === 'disposable')!.unread).toBe(0);
    // the unified Inbox folder count follows the scope too
    const boxes = await listMailboxes(TEST_USER, `category:${personal}`);
    expect(boxes.find((b) => b.id === 'u:inbox')!.unreadEmails).toBe(4);
    expect((await listMailboxes(TEST_USER)).find((b) => b.id === 'u:inbox')!.unreadEmails).toBe(6);
  });

  it('single-mailbox scope', async () => {
    const { B } = await threeMailboxes();
    const r = await queryEmails(TEST_USER, { filter: { scope: `account:${B}` }, position: 0, limit: 50 });
    expect(r.total).toBe(3);
  });

  it('category:work is:unread search works', async () => {
    await threeMailboxes();
    const r = await queryEmails(TEST_USER, { filter: { text: 'category:work is:unread' }, position: 0, limit: 50 });
    expect(r.total).toBe(4);
    const r2 = await queryEmails(TEST_USER, { filter: { text: 'category:Personal quarterly' }, position: 0, limit: 50 });
    expect(r2.total).toBe(6);
  });

  it('built-ins cannot be deleted; deleting a custom one keeps its mailboxes', async () => {
    const { A } = await threeMailboxes();
    const cookie = await login(app);
    const o = (await app.inject({ method: 'GET', url: '/api/categories', headers: { cookie } })).json();
    const work = o.categories.find((c: any) => c.key === 'work');
    expect((await app.inject({ method: 'DELETE', url: `/api/categories/${work.id}`, headers: { cookie } })).statusCode).toBe(400);

    const created = (await app.inject({ method: 'POST', url: '/api/categories', headers: { cookie }, payload: { name: 'Clients', accountIds: [A] } })).json();
    const after = (await app.inject({ method: 'GET', url: '/api/categories', headers: { cookie } })).json();
    expect(after.categories.find((c: any) => c.id === created.id)).toMatchObject({ key: 'clients', accountIds: [A], unread: 2 });
    expect((await app.inject({ method: 'DELETE', url: `/api/categories/${created.id}`, headers: { cookie } })).statusCode).toBe(200);
    expect(await one('SELECT 1 FROM accounts WHERE id = ?', [A])).toBeTruthy();
  });

  it('storage usage follows the scope and stays per user', async () => {
    const { A, work } = await threeMailboxes();
    await run('UPDATE messages SET size = 1000');
    const cookie = await login(app);
    const all = (await app.inject({ method: 'GET', url: '/api/storage/usage', headers: { cookie } })).json();
    expect(all).toMatchObject({ bytes: 9000, messages: 9 });
    const w = (await app.inject({ method: 'GET', url: `/api/storage/usage?scope=category:${work}`, headers: { cookie } })).json();
    expect(w.bytes).toBe(6000);
    const a = (await app.inject({ method: 'GET', url: `/api/storage/usage?scope=account:${A}`, headers: { cookie } })).json();
    expect(a.bytes).toBe(3000);
    await makeUser('b@local');
    const b = (await app.inject({ method: 'GET', url: `/api/storage/usage?scope=account:${A}`, headers: { cookie: await login(app, 'b@local') } })).json();
    expect(b.bytes).toBe(0);
  });

  it('order is configurable and respected', async () => {
    await threeMailboxes();
    const cookie = await login(app);
    const o = (await app.inject({ method: 'GET', url: '/api/categories', headers: { cookie } })).json();
    const ids = o.categories.map((c: any) => c.id).reverse();
    await app.inject({ method: 'PUT', url: '/api/categories/order', headers: { cookie }, payload: { ids } });
    const o2 = (await app.inject({ method: 'GET', url: '/api/categories', headers: { cookie } })).json();
    expect(o2.categories.map((c: any) => c.id)).toEqual(ids);
  });

  it("user B can't scope into user A's category or mailbox", async () => {
    const { work, A } = await threeMailboxes();
    const b = await makeUser('b@local');
    expect((await queryEmails(b, { filter: { scope: `category:${work}` }, position: 0, limit: 50 })).total).toBe(0);
    expect((await queryEmails(b, { filter: { scope: `account:${A}` }, position: 0, limit: 50 })).total).toBe(0);
    const bCookie = await login(app, 'b@local');
    const res = await app.inject({ method: 'PUT', url: `/api/categories/${work}/members`, headers: { cookie: bCookie }, payload: { accountIds: [] } });
    expect(res.statusCode).toBe(404);
    expect((await q('SELECT 1 FROM mailbox_category_members WHERE category_id = ?', [work])).length).toBe(2);
  });
});

describe('F-09 Settings → Mailboxes', () => {
  const IMAP_PORT = 11441;
  const SMTP_PORT = 15881;
  let imapServer: any, smtpServer: any, secret = '';

  beforeAll(async () => {
    await resetDb();
    secret = (await createAppPassword(TEST_USER, 'wizard test', ['imap', 'smtp'])).secret;
    imapServer = startImapFacade(IMAP_PORT);
    smtpServer = startSmtpFacade(SMTP_PORT);
    await new Promise((r) => setTimeout(r, 300));
  });
  afterAll(() => { imapServer?.close(); smtpServer?.close(); });

  const base = { imapHost: '127.0.0.1', imapPort: IMAP_PORT, imapSecure: false, imapUser: 'test@local',
    smtpHost: '127.0.0.1', smtpPort: SMTP_PORT, smtpSecure: false, smtpUser: 'test@local' };

  it('incoming test returns structured steps and lists folders', async () => {
    resetLimiters();
    const cookie = await login(app);
    const r = (await app.inject({ method: 'POST', url: '/api/accounts/test/incoming', headers: { cookie }, payload: { ...base, imapPass: secret } })).json();
    expect(r.ok).toBe(true);
    expect(r.steps.map((s: any) => s.step)).toEqual(['dns', 'tcp', 'tls', 'auth', 'folders']);
    for (const s of r.steps) expect(s).toEqual(expect.objectContaining({ ok: true, ms: expect.any(Number), detail: expect.any(String) }));
  });

  it('a wrong password fails at the auth step with a clear message', async () => {
    resetLimiters();
    const cookie = await login(app);
    const r = (await app.inject({ method: 'POST', url: '/api/accounts/test/incoming', headers: { cookie }, payload: { ...base, imapPass: 'wrong' } })).json();
    expect(r.ok).toBe(false);
    const auth = r.steps.find((s: any) => s.step === 'auth');
    expect(auth.ok).toBe(false);
    expect(auth.detail).toMatch(/Sign-in rejected/);
    expect(r.steps.at(-1).step).toBe('auth');
  });

  it('a closed port fails at tcp', async () => {
    resetLimiters();
    const cookie = await login(app);
    const r = (await app.inject({ method: 'POST', url: '/api/accounts/test/incoming', headers: { cookie }, payload: { ...base, imapPort: 1, imapPass: 'x' } })).json();
    expect(r.ok).toBe(false);
    expect(r.steps.at(-1)).toMatchObject({ step: 'tcp', ok: false });
  });

  it('outgoing test signs in separately', async () => {
    resetLimiters();
    const cookie = await login(app);
    const r = (await app.inject({ method: 'POST', url: '/api/accounts/test/outgoing', headers: { cookie }, payload: { ...base, smtpPass: secret } })).json();
    expect(r.steps.find((s: any) => s.step === 'auth')).toMatchObject({ ok: true });
  });

  it('wizard-created mailbox lands in the chosen categories; the API never returns passwords', async () => {
    resetLimiters();
    const cookie = await login(app);
    const o = (await app.inject({ method: 'GET', url: '/api/categories', headers: { cookie } })).json();
    const personal = o.categories.find((c: any) => c.key === 'personal').id;
    const res = await app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie }, payload: {
      ...base, email: 'new@x.test', name: 'New', imapPass: 'imap-secret-1', smtpPass: 'smtp-secret-1', categoryIds: [personal],
    } });
    const id = res.json().id;
    const list = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie } });
    expect(list.body).not.toContain('imap-secret-1');
    expect(list.body).not.toContain('smtp-secret-1');
    const acct = list.json().find((a: any) => a.id === id);
    expect(acct.categoryIds).toEqual([personal]);
    expect(acct).not.toHaveProperty('imapPass');
    const enc = await one<{ imap_pass_enc: string }>('SELECT imap_pass_enc FROM accounts WHERE id = ?', [id]);
    expect(enc!.imap_pass_enc).not.toContain('imap-secret-1');
    // editing with a blank password keeps the stored one, re-encrypted with SEAMLESS_SECRET
    await app.inject({ method: 'PUT', url: `/api/accounts/${id}`, headers: { cookie }, payload: { ...base, email: 'new@x.test', imapPass: '', smtpPass: 'changed-2', categoryIds: [] } });
    const after = await one<{ imap_pass_enc: string; smtp_pass_enc: string }>('SELECT imap_pass_enc, smtp_pass_enc FROM accounts WHERE id = ?', [id]);
    expect(after!.imap_pass_enc).toBe(enc!.imap_pass_enc);
    const { decrypt } = await import('../src/crypto.ts');
    expect(decrypt(after!.smtp_pass_enc)).toBe('changed-2');
    await run('DELETE FROM accounts WHERE id = ?', [id]);
  });
});

describe('F-11 labels', () => {
  beforeEach(async () => { await resetDb(); resetLimiters(); });

  it('lists counts, nests, refuses cycles, and hides from the sidebar', async () => {
    const cookie = await login(app);
    const parent = (await app.inject({ method: 'POST', url: '/api/labels', headers: { cookie }, payload: { name: 'Clients' } })).json().id;
    const child = (await app.inject({ method: 'POST', url: '/api/labels', headers: { cookie }, payload: { name: 'Acme', parentId: parent } })).json().id;
    const cyc = await app.inject({ method: 'PUT', url: `/api/labels/${parent}`, headers: { cookie }, payload: { parentId: child } });
    expect(cyc.statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: `/api/labels/${child}`, headers: { cookie }, payload: { sidebarVisibility: 'hidden' } });
    const acct = await makeAccount('a@x.test');
    const inbox = await makeMailbox(acct, 'INBOX', 'inbox');
    await ingest(acct, inbox, rawEmail({ from: 'x@y.test', to: 'a@x.test', subject: 'one' }));
    const mid = (await one<{ id: number }>('SELECT id FROM messages'))!.id;
    await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?)', [mid, child]);
    const labels = (await app.inject({ method: 'GET', url: '/api/labels', headers: { cookie } })).json();
    expect(labels.find((l: any) => l.id === child)).toMatchObject({ parentId: parent, sidebarVisibility: 'hidden', total: 1, unread: 1 });
  });

  it('merge moves messages, rules and filters onto the target and deletes the source', async () => {
    const cookie = await login(app);
    const a = await insertId("INSERT INTO labels(user_id, name) VALUES (?, 'Invoices')", [TEST_USER]);
    const b = await insertId("INSERT INTO labels(user_id, name) VALUES (?, 'Bills')", [TEST_USER]);
    const acct = await makeAccount('a@x.test');
    const inbox = await makeMailbox(acct, 'INBOX', 'inbox');
    for (let i = 0; i < 2; i++) await ingest(acct, inbox, rawEmail({ from: 'x@y.test', to: 'a@x.test', subject: `m${i}` }));
    const ids = (await q<{ id: number }>('SELECT id FROM messages ORDER BY id')).map((r) => r.id);
    await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?), (?,?), (?,?)', [ids[0], a, ids[1], a, ids[1], b]);
    await run("INSERT INTO rules(user_id, match_field, match_value, label_id, created_at) VALUES (?, 'from', 'x', ?, 0)", [TEST_USER, a]);
    await run("INSERT INTO filters(user_id, name, actions) VALUES (?, 'f', ?)", [TEST_USER, JSON.stringify([{ type: 'label', value: String(a) }])]);
    const r = await app.inject({ method: 'POST', url: '/api/labels/merge', headers: { cookie }, payload: { sourceId: a, targetId: b } });
    expect(r.statusCode).toBe(200);
    expect(await one('SELECT 1 FROM labels WHERE id = ?', [a])).toBeUndefined();
    expect((await q('SELECT 1 FROM message_labels WHERE label_id = ?', [b])).length).toBe(2);
    expect((await one<any>('SELECT label_id FROM rules'))!.label_id).toBe(b);
    expect(JSON.parse((await one<any>('SELECT actions FROM filters'))!.actions)[0].value).toBe(String(b));
  });

  it('bulk delete only touches your own labels', async () => {
    const mine = await insertId("INSERT INTO labels(user_id, name) VALUES (?, 'Mine')", [TEST_USER]);
    const other = await makeUser('o@local');
    const theirs = await insertId("INSERT INTO labels(user_id, name) VALUES (?, 'Theirs')", [other]);
    const cookie = await login(app);
    await app.inject({ method: 'POST', url: '/api/labels/delete', headers: { cookie }, payload: { ids: [mine, theirs] } });
    expect(await one('SELECT 1 FROM labels WHERE id = ?', [mine])).toBeUndefined();
    expect(await one('SELECT 1 FROM labels WHERE id = ?', [theirs])).toBeTruthy();
  });
});

describe('F-12 templates', () => {
  beforeEach(async () => { await resetDb(); resetLimiters(); });

  it('fills placeholders, escaping inserted values in HTML', () => {
    const out = renderTemplate('<p>Hi {{recipient.first_name}}, quote {{?Amount}} by {{date+7d}} — {{sender.business}} re {{subject}}</p>', {
      recipient: { name: 'Alex <Smith>', email: 'alex@x.test' }, sender: { name: 'Sam', business: 'Sam & Co' },
      subject: 'Office', now: new Date('2026-11-11T02:00:00Z'), answers: { Amount: '$450' },
    }, { html: true });
    expect(out).toBe('<p>Hi Alex, quote $450 by 18 November 2026 — Sam &amp; Co re Office</p>');
  });

  it('first name falls back to the address; unknown tokens stay visible; questions are listed', () => {
    expect(renderTemplate('{{recipient.first_name}} {{nope}}', { recipient: { email: 'jane.doe@x.test' } })).toBe('Jane {{nope}}');
    expect(templateQuestions('{{?Amount}} {{?Due}}', 'again {{?Amount}}')).toEqual(['Amount', 'Due']);
  });

  it('CRUD with unique ;shortcuts, per user', async () => {
    const cookie = await login(app);
    const t = (await app.inject({ method: 'POST', url: '/api/templates', headers: { cookie }, payload: { name: 'Quote', category: 'Sales', subject: 'Quote', bodyHtml: '<p>x</p>', shortcut: 'quote' } })).json();
    const dup = await app.inject({ method: 'POST', url: '/api/templates', headers: { cookie }, payload: { name: 'Q2', bodyHtml: 'y', shortcut: ';quote' } });
    expect(dup.statusCode).toBe(400);
    await app.inject({ method: 'POST', url: `/api/templates/${t.id}/use`, headers: { cookie } });
    const list = (await app.inject({ method: 'GET', url: '/api/templates', headers: { cookie } })).json();
    expect(list[0]).toMatchObject({ name: 'Quote', shortcut: ';quote', useCount: 1, category: 'Sales' });
    await makeUser('b@local');
    const bCookie = await login(app, 'b@local');
    expect((await app.inject({ method: 'GET', url: '/api/templates', headers: { cookie: bCookie } })).json()).toEqual([]);
    expect((await app.inject({ method: 'PUT', url: `/api/templates/${t.id}`, headers: { cookie: bCookie }, payload: { name: 'hijack', bodyHtml: '' } })).statusCode).toBe(404);
  });

  it('templates are part of the backup', async () => {
    const { createBackup } = await import('../src/backup/engine.ts');
    await insertId("INSERT INTO templates(user_id, name, body_html, created_at, updated_at) VALUES (?, 't', 'b', 0, 0)", [TEST_USER]);
    const m = await createBackup({ prefix: 'seamless/test/' });
    for (const t of ['templates', 'mailbox_categories', 'mailbox_category_members', 'notifications', 'events', 'tracked_sends', 'user_mfa']) {
      expect(m.tables).toHaveProperty(t);
    }
    expect(m.tables.templates).toBe(1);
  });
});

describe('F-16 bulk actions', () => {
  beforeEach(async () => { await resetDb(); resetLimiters(); });

  it('"all N matching" runs server-side and can be undone', async () => {
    const { work } = await threeMailboxes();
    const cookie = await login(app);
    const r = (await app.inject({ method: 'POST', url: '/api/bulk', headers: { cookie }, payload: {
      filter: { scope: `category:${work}`, inMailbox: 'u:inbox' }, action: 'read',
    } })).json();
    expect(r.affected).toBe(6);
    expect((await q('SELECT 1 FROM messages WHERE unread = true')).length).toBe(2);   // only B's
    await app.inject({ method: 'POST', url: '/api/bulk/undo', headers: { cookie }, payload: { undoToken: r.undoToken } });
    expect((await q('SELECT 1 FROM messages WHERE unread = true')).length).toBe(6);
  });

  it('archive by ids moves and undo moves back', async () => {
    const { A, inbox } = await threeMailboxes();
    await makeMailbox(A, 'Archive', 'archive');
    const ids = (await q<{ id: number }>('SELECT id FROM messages WHERE account_id = ?', [A])).map((r) => `m${r.id}`);
    const cookie = await login(app);
    const r = (await app.inject({ method: 'POST', url: '/api/bulk', headers: { cookie }, payload: { ids, action: 'archive' } })).json();
    expect(r.affected).toBe(3);
    expect((await q('SELECT 1 FROM messages WHERE mailbox_id = ?', [inbox.A])).length).toBe(0);
    await app.inject({ method: 'POST', url: '/api/bulk/undo', headers: { cookie }, payload: { undoToken: r.undoToken } });
    expect((await q('SELECT 1 FROM messages WHERE mailbox_id = ?', [inbox.A])).length).toBe(3);
  });

  it("another user's undo token does nothing", async () => {
    await threeMailboxes();
    const cookie = await login(app);
    const r = (await app.inject({ method: 'POST', url: '/api/bulk', headers: { cookie }, payload: { filter: {}, action: 'star' } })).json();
    await makeUser('b@local');
    const bCookie = await login(app, 'b@local');
    expect((await app.inject({ method: 'POST', url: '/api/bulk/undo', headers: { cookie: bCookie }, payload: { undoToken: r.undoToken } })).statusCode).toBe(404);
  });

  it('block sender makes a filter and moves the message to Spam', async () => {
    const acct = await makeAccount('a@x.test');
    const inbox = await makeMailbox(acct, 'INBOX', 'inbox');
    const junk = await makeMailbox(acct, 'Junk', 'junk');
    await ingest(acct, inbox, rawEmail({ from: 'Spammy <spam@bad.test>', to: 'a@x.test', subject: 'buy' }));
    const id = (await one<{ id: number }>('SELECT id FROM messages'))!.id;
    const cookie = await login(app);
    const r = (await app.inject({ method: 'POST', url: '/api/block-sender', headers: { cookie }, payload: { emailId: `m${id}` } })).json();
    expect(r).toMatchObject({ ok: true, address: 'spam@bad.test', filterCreated: true });
    expect((await one<any>('SELECT mailbox_id FROM messages WHERE id = ?', [id]))!.mailbox_id).toBe(junk);
    const { filterMatches, loadFilters } = await import('../src/mail/filters.ts');
    const f = (await loadFilters(TEST_USER))[0];
    expect(filterMatches({ from: 'Spammy <spam@bad.test>', to: '', cc: '', subject: '', body: '', hasAttachment: false, accountEmail: '' }, f)).toBe(true);
    expect(filterMatches({ from: 'Ok <notspam@bad.test>', to: '', cc: '', subject: '', body: '', hasAttachment: false, accountEmail: '' }, f)).toBe(false);
  });
});
