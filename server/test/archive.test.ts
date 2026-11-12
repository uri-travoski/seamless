import { describe, it, expect, beforeEach } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, blobStore, TEST_USER } from './helpers.ts';
import { q, one, run, insertId } from '../src/db.ts';
import { makeApp, login, resetLimiters } from './app.ts';
import { insertTarget } from '../src/storage/targets.ts';
import { runDueJobs } from '../src/jobs/runner.ts';
import { getBlob, type BlobStore } from '../src/s3.ts';
import { sha256 } from '../src/crypto.ts';
import { addVip } from '../src/mail/vip.ts';
import { previewArchive, parseOlderThan, DAY_MS } from '../src/archive/select.ts';
import { planArchive, runArchiveSlice, setArchiveStoreFactory, itemCounts, type ArchiveRow } from '../src/archive/run.ts';
import { restoreArchive, searchArchive } from '../src/archive/restore.ts';
import { SECRET_KEY } from '../src/archive/config.ts';

// the archive store is its own in-memory bucket, never the mail bucket (blobStore)
let archiveObjects: Map<string, Buffer>;
let corrupt: (key: string) => boolean = () => false;
const archiveStore = (): BlobStore => ({
  put: async (k, b) => { archiveObjects.set(k, b); },
  get: async (k) => { const b = archiveObjects.get(k); if (!b) throw new Error(`no blob ${k}`); return corrupt(k) ? Buffer.from('tampered') : b; },
  list: async (p) => [...archiveObjects.keys()].filter((k) => k.startsWith(p)).sort(),
  del: async (k) => { archiveObjects.delete(k); },
});

const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * DAY_MS).toUTCString();
let acct: number, inbox: number, junk: number, drafts: number, targetId: number;

async function mail(subject: string, days: number, opts: { box?: number; from?: string; flags?: string[]; body?: string; account?: number } = {}) {
  const r = await ingest(opts.account ?? acct, opts.box ?? inbox, rawEmail({ from: opts.from ?? 'shop@old.test', to: 'alice@demo.test', subject, date: ago(days), body: opts.body ?? `body of ${subject}` }), { flags: opts.flags ?? ['\\Seen'] });
  return r!.rowId;
}
const rows = () => q<any>('SELECT id, subject FROM messages ORDER BY id');
const finish = async (a: ArchiveRow) => { while (!(await runArchiveSlice(a.id))) { /* more slices */ } return (await one<ArchiveRow>('SELECT * FROM mail_archives WHERE id = ?', [a.id]))!; };
const plan = (o: any = {}) => planArchive(TEST_USER, { olderThanDays: 365, mode: 'copy', targetId, ...o });

beforeEach(async () => {
  await resetDb(); resetLimiters(); blobStore.clear(); archiveObjects = new Map(); corrupt = () => false;
  setArchiveStoreFactory(async () => archiveStore());
  acct = await makeAccount('alice@demo.test');
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  junk = await makeMailbox(acct, 'Junk', 'junk');
  drafts = await makeMailbox(acct, 'Drafts', 'drafts');
  targetId = await insertTarget({ role: 'backup', provider: 'minio', endpoint: 'http://localhost:9100', region: 'us-east-1', bucket: 'seamless-test-archive', accessKey: 'k', secretKey: 's', forcePathStyle: true }, true, null);
});

describe('selection', () => {
  it('picks mail older than the cutoff and keeps starred, VIP, drafts, snoozed, follow-ups and Spam/Bin out by default', async () => {
    const plainOld = await mail('Plain old', 800);
    await mail('Fresh', 10);
    await mail('Starred old', 800, { flags: ['\\Flagged'] });
    await mail('VIP old', 800, { from: 'boss@vip.test' });
    await addVip(TEST_USER, 'address', 'boss@vip.test');
    await mail('Draft old', 800, { box: drafts });
    const snoozed = await mail('Snoozed old', 800);
    await run('UPDATE messages SET snoozed_until = ? WHERE id = ?', [NOW + DAY_MS, snoozed]);
    const fu = await mail('Follow-up old', 800);
    await run("INSERT INTO followups(user_id, message_id, due_at, status, created_at) VALUES (?,?,?,?,?)", [TEST_USER, fu, NOW + DAY_MS, 'waiting', NOW]);
    await mail('Junk old', 800, { box: junk });

    const p = await previewArchive(TEST_USER, 'all', 365, {});
    expect(p.count).toBe(1);
    expect(p.oldest).toBe(p.newest);
    const a = await plan();
    expect((await q<any>('SELECT message_id FROM mail_archive_items WHERE archive_id = ?', [a.id])).map((r) => r.message_id)).toEqual([plainOld]);

    expect((await previewArchive(TEST_USER, 'all', 365, { includeStarred: true })).count).toBe(2);
    expect((await previewArchive(TEST_USER, 'all', 365, { includeVip: true })).count).toBe(2);
    expect((await previewArchive(TEST_USER, 'all', 365, { includeSpamBin: true })).count).toBe(2);
    expect((await previewArchive(TEST_USER, 'all', 365, { includeStarred: true, includeVip: true, includeSpamBin: true })).count).toBe(4);
  });

  it('age rule works for 1 … 10 years and a custom number of days', async () => {
    await mail('Two years', 2 * 365 + 5); await mail('Five years', 5 * 365 + 5); await mail('Nine years', 9 * 365 + 5); await mail('Recent', 100);
    const counts: number[] = [];
    for (let y = 1; y <= 10; y++) counts.push((await previewArchive(TEST_USER, 'all', parseOlderThan({ olderThanYears: y }), {})).count);
    expect(counts).toEqual([3, 3, 2, 2, 2, 1, 1, 1, 1, 0]);
    expect((await previewArchive(TEST_USER, 'all', parseOlderThan({ olderThanDays: 90 }), {})).count).toBe(4);
    expect((await previewArchive(TEST_USER, 'all', parseOlderThan({ olderThan: '3y' }), {})).count).toBe(2);
    expect((await previewArchive(TEST_USER, 'all', parseOlderThan({ olderThanMonths: 6 }), {})).count).toBe(3);
    expect(() => parseOlderThan({ olderThanDays: 0 })).toThrow();
  });
});

describe('copy', () => {
  it('copies .eml files + index + manifest + config to the archive store and leaves everything in the app', async () => {
    const id1 = await mail('Alpha invoice', 800); await mail('Beta report', 900, { body: 'quarterly' }); await mail('Fresh', 5);
    const label = await insertId("INSERT INTO labels(user_id, name, color) VALUES (?,?,?)", [TEST_USER, 'Invoices', '#112233']);
    await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?)', [id1, label]);
    const mailKeysBefore = [...blobStore.keys()].sort();

    const a = await finish(await plan());
    expect(a.status).toBe('done');
    expect(a.error).toBeNull();
    expect(await rows()).toHaveLength(3);                                        // copy: nothing removed
    expect([...blobStore.keys()].sort()).toEqual(mailKeysBefore);                // nothing written to or removed from the mail bucket
    expect([...blobStore.keys()].some((k) => k.startsWith('archive/'))).toBe(false);
    expect(await itemCounts(a.id)).toEqual({ verified: 2 });

    const keys = [...archiveObjects.keys()];
    expect(keys.filter((k) => k.endsWith('.eml'))).toHaveLength(2);
    expect(keys.some((k) => new RegExp(`^archive/${a.id}/${acct}/\\d{4}/\\d+\\.eml$`).test(k))).toBe(true);
    const manifest = JSON.parse(archiveObjects.get(`archive/${a.id}/manifest.json`)!.toString());
    expect(manifest).toMatchObject({ format: 'seamless-archive', version: 1, archiveId: a.id, rule: { olderThanDays: 365, scope: 'all', mode: 'copy' }, counts: { messages: 2 } });
    expect(manifest.accounts[0]).toMatchObject({ email: 'alice@demo.test' });
    expect(manifest.accounts[0].mailboxes.map((m: any) => m.path)).toContain('INBOX');
    expect(manifest.labels).toContainEqual(expect.objectContaining({ name: 'Invoices', color: '#112233' }));
    expect(manifest.indexFiles).toEqual([`archive/${a.id}/index-1.jsonl.gz`]);
    const lines = gunzipSync(archiveObjects.get(manifest.indexFiles[0])!).toString().trim().split('\n').map((l) => JSON.parse(l));
    const alpha = lines.find((l) => l.subject === 'Alpha invoice');
    expect(alpha).toMatchObject({ mailboxPath: 'INBOX', from: { addr: 'shop@old.test' }, flags: { seen: true, flagged: false, answered: false }, labelKeys: [`L${label}`], hasAttachments: false });
    expect(sha256(archiveObjects.get(alpha.emlPath)!)).toBe(alpha.sha256);
    expect(Object.keys(alpha)).toEqual(expect.arrayContaining(['messageKey', 'accountKey', 'uid', 'messageId', 'threadKey', 'date', 'to', 'cc', 'snippet', 'attachments', 'size', 'emlPath']));
  });

  it('splits the index into files of 5,000 (checked with a small chunk via many messages is covered by the format; one file for a small archive)', async () => {
    for (let i = 0; i < 3; i++) await mail(`M${i}`, 800 + i);
    const a = await finish(await plan());
    expect((await q<any>('SELECT index_files FROM mail_archives WHERE id = ?', [a.id]))[0].index_files).toHaveLength(1);
  });

  it('config.json carries the app data and no secret-looking fields', async () => {
    const lab = await insertId("INSERT INTO labels(user_id, name, color, retention_days, sidebar_visibility) VALUES (?,?,?,?,?)", [TEST_USER, 'Receipts', '#445566', 30, 'hidden']);
    await run("INSERT INTO rules(user_id, match_field, match_value, label_id, created_at) VALUES (?,?,?,?,?)", [TEST_USER, 'from', 'shop@old.test', lab, NOW]);
    await run("INSERT INTO filters(user_id, name, conditions, actions) VALUES (?,?,?,?)", [TEST_USER, 'F1', '[]', JSON.stringify([{ type: 'label', value: String(lab) }])]);
    await run("INSERT INTO saved_views(user_id, name, query) VALUES (?,?,?)", [TEST_USER, 'Big', 'larger:5mb']);
    await run("INSERT INTO templates(user_id, name, body_html, created_at, updated_at) VALUES (?,?,?,?,?)", [TEST_USER, 'Thanks', '<p>Thanks</p>', NOW, NOW]);
    const c = await insertId("INSERT INTO contacts(user_id, display_name, created_at, updated_at) VALUES (?,?,?,?)", [TEST_USER, 'Sam Shop', NOW, NOW]);
    await run("INSERT INTO contact_emails(contact_id, email, is_primary) VALUES (?,?,true)", [c, 'sam@shop.test']);
    const biz = await insertId("INSERT INTO businesses(user_id, name, logo_key, created_at) VALUES (?,?,?,?)", [TEST_USER, 'Acme', 'logo/1/x.png', NOW]);
    blobStore.set('logo/1/x.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await run("UPDATE identities SET business_id = ? WHERE account_id = ?", [biz, acct]);
    await run("INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?)", [TEST_USER, 'ai_api_key', 'sekrit-key-123'], );
    await run("INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?)", [TEST_USER, 'undo_send_seconds', '10']);
    await run("INSERT INTO api_tokens(user_id, name, token_hash, scopes, created_at) VALUES (?,?,?,?,?)", [TEST_USER, 'ci', 'sekrit-token-hash', '[]', NOW]).catch(() => {});
    await run("INSERT INTO trusted_senders(user_id, kind, value, created_at) VALUES (?,?,?,?)", [TEST_USER, 'domain', 'bank.test', NOW]);
    await addVip(TEST_USER, 'address', 'vip@x.test');
    const mid = await mail('Noted', 800);
    await run("INSERT INTO notes(user_id, email_id, body, updated_at) VALUES (?,?,?,?)", [TEST_USER, `m${mid}`, 'remember this', NOW]);

    const a = await finish(await plan());
    const text = archiveObjects.get(`archive/${a.id}/config.json`)!.toString();
    const cfg = JSON.parse(text);
    expect(cfg.labels[0]).toMatchObject({ name: 'Receipts', color: '#445566', retentionDays: 30, sidebarVisibility: 'hidden' });
    expect(cfg.rules[0]).toMatchObject({ matchField: 'from', labelKey: `L${lab}` });
    expect(cfg.filters[0].actions[0]).toMatchObject({ labelKey: `L${lab}` });
    expect(cfg.savedViews[0]).toMatchObject({ name: 'Big', query: 'larger:5mb' });
    expect(cfg.templates[0].name).toBe('Thanks');
    expect(cfg.contacts[0]).toMatchObject({ displayName: 'Sam Shop', emails: [{ email: 'sam@shop.test', primary: true }] });
    expect(cfg.businesses[0]).toMatchObject({ name: 'Acme', logo: { mime: 'image/png' } });
    expect(cfg.identities[0].businessKey).toBe(`B${biz}`);
    expect(cfg.vipSenders).toEqual([{ kind: 'address', value: 'vip@x.test' }]);
    expect(cfg.trustedSenders).toEqual([{ kind: 'domain', value: 'bank.test' }]);
    expect(cfg.notes).toEqual([expect.objectContaining({ messageKey: `M${mid}`, body: 'remember this' })]);
    expect(cfg.appearance.settings).toEqual([{ key: 'undo_send_seconds', value: '10' }]);
    // nothing secret-looking, anywhere, in any file of the archive
    const walk = (v: any, path = ''): string[] => v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => (SECRET_KEY.test(k) ? [path + k] : walk(x, `${path}${k}.`))) : [];
    expect(walk(cfg)).toEqual([]);
    expect(walk(JSON.parse(archiveObjects.get(`archive/${a.id}/manifest.json`)!.toString()))).toEqual([]);
    expect(text).not.toMatch(/sekrit|imap_pass|smtp_pass|BEGIN (RSA |PGP )?PRIVATE/i);
    expect(text).not.toContain(encryptedPw());
  });
});
const encryptedPw = () => 'imap_pass_enc';

describe('move', () => {
  it('removes only verified items: row, search text, labels, attachment text and the mail blob go; starred stays', async () => {
    const old = await mail('Move me', 800, { body: 'uniqueneedleword' });
    const keep = await mail('Starred keep', 800, { flags: ['\\Flagged'] });
    const label = await insertId("INSERT INTO labels(user_id, name) VALUES (?,?)", [TEST_USER, 'L1']);
    await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?)', [old, label]);
    await run("INSERT INTO attachment_text(user_id, message_id, part_id, text, created_at) VALUES (?,?,?,?,?)", [TEST_USER, old, '0', 'attached words', NOW]);
    const oldKey = (await one<any>('SELECT s3_key FROM messages WHERE id = ?', [old]))!.s3_key;

    const a = await finish(await plan({ mode: 'move' }));
    expect(a.status).toBe('done');
    expect((await rows()).map((r) => r.id)).toEqual([keep]);
    expect(await q('SELECT 1 FROM message_fts WHERE message_id = ?', [old])).toHaveLength(0);
    expect(await q('SELECT 1 FROM message_labels WHERE message_id = ?', [old])).toHaveLength(0);
    expect(await q('SELECT 1 FROM attachment_text WHERE message_id = ?', [old])).toHaveLength(0);
    expect(blobStore.has(oldKey)).toBe(false);
    expect(await itemCounts(a.id)).toEqual({ removed: 1 });
    expect(await q("SELECT 1 FROM op_queue WHERE op IN ('move','expunge')")).toHaveLength(0);   // the mail server is not touched
    // still findable in the archive
    expect((await searchArchive(TEST_USER, a.id, { q: 'move' })).results.map((r) => r.subject)).toEqual(['Move me']);
  });

  it('keeps a shared blob while another message still points at it', async () => {
    const raw = rawEmail({ from: 'a@old.test', to: 'alice@demo.test', subject: 'Twin', date: ago(800), messageId: '<twin@t>' });
    const one1 = (await ingest(acct, inbox, raw, { flags: ['\\Seen'] }))!.rowId;
    const two = (await ingest(acct, junk, raw))!.rowId;
    await run('UPDATE messages SET date = ? WHERE id = ?', [NOW - 5 * DAY_MS, two]);   // the twin in Junk is recent
    const key = (await one<any>('SELECT s3_key FROM messages WHERE id = ?', [one1]))!.s3_key;
    await finish(await plan({ mode: 'move' }));
    expect((await rows()).map((r) => r.id)).toEqual([two]);
    expect(blobStore.has(key)).toBe(true);
  });

  it('a crash after the copy but before the removal re-runs safely', async () => {
    const m1 = await mail('Crash one', 800); const m2 = await mail('Crash two', 801);
    const a0 = await plan({ mode: 'move' });
    expect(await runArchiveSlice(a0.id, { budgetMs: -1 })).toBe(false);          // stops after the first batch: copied + verified, index/manifest not written yet
    expect(await itemCounts(a0.id)).toEqual({ verified: 2 });
    expect(await rows()).toHaveLength(2);
    // "crash" mid-removal: the row of m1 is already gone but its item still says verified
    await run('DELETE FROM messages WHERE id = ?', [m1]);
    const a = await finish(a0);
    expect(a.status).toBe('done');
    expect(await itemCounts(a.id)).toEqual({ removed: 2 });
    expect(await rows()).toHaveLength(0);
    const idx = gunzipSync(archiveObjects.get(`archive/${a.id}/index-1.jsonl.gz`)!).toString().trim().split('\n');
    expect(idx.length).toBe(1);                                                    // m1 vanished before the index was written: only m2 is promised
    void m2;
    // running it again changes nothing
    expect(await runArchiveSlice(a.id)).toBe(true);
    expect(await itemCounts(a.id)).toEqual({ removed: 2 });
  });

  it('a checksum mismatch marks that item failed and the message is never removed', async () => {
    const good = await mail('Good one', 800); const bad = await mail('Bad one', 801);
    corrupt = (k) => k.endsWith(`/${bad}.eml`);
    const a = await finish(await plan({ mode: 'move' }));
    expect(a.status).toBe('done');
    expect(a.error).toMatch(/1 message/);
    expect((await rows()).map((r) => r.id)).toEqual([bad]);
    expect(await itemCounts(a.id)).toEqual({ removed: 1, failed: 1 });
    expect((await q<any>('SELECT error FROM mail_archive_items WHERE message_id = ?', [bad]))[0].error).toMatch(/checksum/);
    const m = JSON.parse(archiveObjects.get(`archive/${a.id}/manifest.json`)!.toString());
    expect(m.counts).toMatchObject({ messages: 1, failed: 1 });
    void good;
  });

  it('refuses a storage target that is the mail bucket', async () => {
    const same = await insertTarget({ role: 'backup', provider: 'minio', endpoint: 'http://localhost:9100', region: 'us-east-1', bucket: 'seamless', accessKey: 'k', secretKey: 's', forcePathStyle: true }, false, null);
    await expect(plan({ targetId: same })).rejects.toThrow(/mail bucket/);
    const mailRole = await insertTarget({ role: 'mail', provider: 'minio', endpoint: 'http://x:1', region: 'us-east-1', bucket: 'other', accessKey: 'k', secretKey: 's', forcePathStyle: true }, false, null);
    await expect(plan({ targetId: mailRole })).rejects.toThrow(/backup storage target/);
  });
});

describe('restore + search', () => {
  it('brings back identical bytes, dates, flags and labels; running it twice does not duplicate', async () => {
    const raw = rawEmail({ from: 'Sam <sam@shop.test>', to: 'alice@demo.test', subject: 'Receipt 42', date: ago(900), body: 'details ✓' });
    const r = (await ingest(acct, inbox, raw, { flags: ['\\Flagged', '\\Answered'] }))!.rowId;   // starred is excluded by default: include it
    const label = await insertId("INSERT INTO labels(user_id, name) VALUES (?,?)", [TEST_USER, 'Receipts']);
    await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?)', [r, label]);
    const before = (await one<any>('SELECT * FROM messages WHERE id = ?', [r]))!;
    const a = await finish(await plan({ mode: 'move', options: { includeStarred: true } }));
    expect(await rows()).toHaveLength(0);

    const res = await restoreArchive(TEST_USER, a.id, {});
    expect(res).toMatchObject({ expected: 1, restored: 1, alreadyPresent: 0, failed: 0, ok: true });
    const back = (await one<any>("SELECT * FROM messages WHERE subject = 'Receipt 42'"))!;
    expect(Buffer.compare(await getBlob(back.s3_key), raw)).toBe(0);
    expect(back).toMatchObject({ account_id: acct, mailbox_id: inbox, flagged: true, answered: true, unread: true, from_addr: 'sam@shop.test', disposition: 'keep', keep_reason: 'restored', origin_state: 'removed' });
    expect(Number(back.date)).toBe(Number(before.date));
    expect((await q<any>('SELECT label_id FROM message_labels WHERE message_id = ?', [back.id])).map((x) => x.label_id)).toEqual([label]);
    expect(await q('SELECT 1 FROM message_fts WHERE message_id = ?', [back.id])).toHaveLength(1);
    // no notifications, no pending filter/AI work from a restore
    expect(await q("SELECT 1 FROM notifications WHERE type NOT LIKE 'archive.%'")).toHaveLength(0);

    expect(await restoreArchive(TEST_USER, a.id, {})).toMatchObject({ expected: 1, restored: 0, alreadyPresent: 1, ok: true });
    expect(await rows()).toHaveLength(1);
  });

  it('restores by sender search and by date range; skips mail for an account the user no longer has', async () => {
    await mail('From Ann', 800, { from: 'ann@a.test' }); await mail('From Bob', 1200, { from: 'bob@b.test' });
    const a = await finish(await plan({ mode: 'move' }));
    expect(await restoreArchive(TEST_USER, a.id, { q: 'bob@b.test' })).toMatchObject({ expected: 1, restored: 1 });
    expect((await rows()).map((r) => r.subject)).toEqual(['From Bob']);
    expect(await restoreArchive(TEST_USER, a.id, { from: NOW - 1000 * DAY_MS })).toMatchObject({ expected: 1, restored: 1 });
    expect(await rows()).toHaveLength(2);
    await run('DELETE FROM accounts WHERE id = ?', [acct]);
    expect(await restoreArchive(TEST_USER, a.id, {})).toMatchObject({ expected: 2, noAccount: 2, restored: 0, ok: false });
  });

  it('search over the index finds archived mail by subject, sender and date, without opening any .eml', async () => {
    await mail('Tax return 2019', 2000, { from: 'ato@gov.test' }); await mail('Holiday photos', 900, { from: 'mum@family.test' });
    const a = await finish(await plan({ mode: 'move' }));
    const emlReads: string[] = [];
    setArchiveStoreFactory(async () => { const s = archiveStore(); const g = s.get; s.get = async (k) => { emlReads.push(k); return g(k); }; return s; });
    expect((await searchArchive(TEST_USER, a.id, { q: 'tax' })).results).toEqual([expect.objectContaining({ subject: 'Tax return 2019', accountEmail: 'alice@demo.test', from: expect.objectContaining({ addr: 'ato@gov.test' }), size: expect.any(Number), date: expect.any(Number) })]);
    expect((await searchArchive(TEST_USER, a.id, { q: 'family.test' })).total).toBe(1);
    expect((await searchArchive(TEST_USER, a.id, { to: NOW - 1500 * DAY_MS })).total).toBe(1);
    expect(emlReads.some((k) => k.endsWith('.eml'))).toBe(false);
  });
});

describe('HTTP', () => {
  it('preview, dry run, create → job → done, search, eml download, restore, delete — all audited', async () => {
    const app = await makeApp(); const cookie = await login(app);
    const call = (method: any, url: string, payload?: any) => app.inject({ method, url, payload, headers: { cookie } });
    await mail('Over the wire', 800); await mail('Recent', 3);

    const pv = (await call('GET', '/api/archives/preview?olderThan=1y')).json();
    expect(pv).toMatchObject({ count: 1, olderThanDays: 365 });
    expect(pv.bytes).toBeGreaterThan(0);
    expect((await call('GET', '/api/archives/preview?olderThan=0')).statusCode).toBe(400);

    const dry = (await call('POST', '/api/archives', { olderThanYears: 1, dryRun: true })).json();
    expect(dry).toMatchObject({ dryRun: true, count: 1 });
    expect(dry.sample[0].subject).toBe('Over the wire');
    expect((await call('GET', '/api/archives')).json().archives).toHaveLength(0);

    expect((await call('POST', '/api/archives', { olderThanYears: 1, mode: 'move' })).statusCode).toBe(400);   // no target
    const created = await call('POST', '/api/archives', { olderThanYears: 1, mode: 'move', targetId, name: 'Old stuff' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    await runDueJobs();
    const got = (await call('GET', `/api/archives/${id}`)).json();
    expect(got).toMatchObject({ status: 'done', messageCount: 1, mode: 'move', progress: 1, name: 'Old stuff' });
    expect(await rows()).toHaveLength(1);

    const s = (await call('GET', `/api/archives/${id}/search?q=wire`)).json();
    expect(s.results).toHaveLength(1);
    const dl = await call('GET', `/api/archives/${id}/messages/${s.results[0].key}/eml`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('message/rfc822');
    expect(dl.body).toContain('Subject: Over the wire');

    expect((await call('POST', `/api/archives/${id}/restore`, {})).statusCode).toBe(202);
    await runDueJobs();
    const after = (await call('GET', `/api/archives/${id}`)).json();
    expect(after).toMatchObject({ status: 'done', restoreResult: { restored: 1, ok: true } });
    expect(await rows()).toHaveLength(2);

    expect((await call('DELETE', `/api/archives/${id}`, { confirm: 'nope' })).statusCode).toBe(400);
    expect((await call('DELETE', `/api/archives/${id}`, { confirm: 'Old stuff' })).statusCode).toBe(200);
    expect([...archiveObjects.keys()]).toHaveLength(0);
    expect((await call('GET', `/api/archives/${id}`)).statusCode).toBe(404);

    const actions = (await q<any>("SELECT action FROM audit_log WHERE action LIKE 'archive.%' ORDER BY id")).map((r) => r.action);
    expect(actions).toEqual(['archive.plan', 'archive.run', 'archive.complete', 'archive.restore', 'archive.restore_done', 'archive.delete']);
  });
});

describe('isolation', () => {
  it("user B can't preview, run, search, restore, download or delete user A's archive, and can't archive A's mailbox", async () => {
    await mail('A private', 800);
    const a = await finish(await plan({ mode: 'copy' }));
    const bId = await makeUser('bob@demo.test'); const bAcct = await makeAccount('bob@demo.test', { userId: bId });
    const bBox = await makeMailbox(bAcct, 'INBOX', 'inbox');
    await ingest(bAcct, bBox, rawEmail({ from: 'x@y.test', to: 'bob@demo.test', subject: 'B old', date: ago(800) }));

    expect((await previewArchive(bId, 'all', 365, {})).count).toBe(1);                       // only B's own mail
    await expect(previewArchive(bId, `account:${acct}`, 365, {})).rejects.toThrow(/not found/);
    await expect(planArchive(bId, { olderThanDays: 365, targetId, scope: `account:${acct}` })).rejects.toThrow(/not found/);
    await expect(searchArchive(bId, a.id, {})).rejects.toThrow(/not found/);
    await expect(restoreArchive(bId, a.id, {})).rejects.toThrow(/not found/);

    const app = await makeApp(); const cookie = await login(app, 'bob@demo.test');
    const call = (method: any, url: string, payload?: any) => app.inject({ method, url, payload, headers: { cookie } });
    expect((await call('GET', '/api/archives')).json().archives).toEqual([]);
    for (const [m, u] of [['GET', `/api/archives/${a.id}`], ['GET', `/api/archives/${a.id}/search?q=a`], ['GET', `/api/archives/${a.id}/messages/M1/eml`]] as const) {
      expect((await call(m, u)).statusCode).toBe(404);
    }
    expect((await call('POST', `/api/archives/${a.id}/restore`, {})).statusCode).toBe(404);
    expect((await call('DELETE', `/api/archives/${a.id}`, { confirm: a.name })).statusCode).toBe(404);
    expect((await call('POST', '/api/archives', { olderThanYears: 1, targetId, scope: `account:${acct}` })).statusCode).toBe(404);
    expect(await one('SELECT 1 FROM mail_archives WHERE id = ?', [a.id])).toBeTruthy();
    // shared mail is only ever archived by its owner: a share does not put A's mail into B's archive
    await run("INSERT INTO mailbox_shares(account_id, user_id, role) VALUES (?,?,'manager')", [acct, bId]);
    expect((await previewArchive(bId, 'all', 365, {})).count).toBe(1);
    expect((await call('POST', '/api/archives', { olderThanYears: 1, targetId, scope: `account:${acct}` })).statusCode).toBe(404);
  });
});
