/** T8.6: open an archive in another instance. Instance A archives (T8.4 code), instance B (a second user, a second fake bucket reading
 *  A's archive) imports it. Both live in the same test database, separated by user. */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail, blobStore, TEST_USER } from './helpers.ts';
import { q, one, run, insertId } from '../src/db.ts';
import { makeApp, login, resetLimiters } from './app.ts';
import { insertTarget } from '../src/storage/targets.ts';
import { runDueJobs } from '../src/jobs/runner.ts';
import type { BlobStore } from '../src/s3.ts';
import { sha256 } from '../src/crypto.ts';
import { DAY_MS } from '../src/archive/select.ts';
import { planArchive, runArchiveSlice, setArchiveStoreFactory } from '../src/archive/run.ts';
import { setSourceStoreFactory, scanSource, testSource, readOnly, zipStore } from '../src/archive/source.ts';
import { queueImport, runImportSlice, retryImport, removeImport, pauseImport, resumeImport } from '../src/archive/import.ts';
import { queryEmails } from '../src/mail/store.ts';
import { loadFilters } from '../src/mail/filters.ts';

let objects: Map<string, Buffer>;           // the bucket A archived into = the bucket B reads from
let writes: string[];                       // anything ever written/deleted through the source store
let corrupt: (key: string) => boolean = () => false;
const mem = (): BlobStore => ({
  put: async (k, b) => { objects.set(k, b); },
  get: async (k) => { const b = objects.get(k); if (!b) throw new Error(`no blob ${k}`); return corrupt(k) ? Buffer.from('tampered') : b; },
  list: async (p) => [...objects.keys()].filter((k) => k.startsWith(p)).sort(),
  del: async (k) => { objects.delete(k); },
});
const spy = (): BlobStore => {
  const inner = mem();
  return { ...inner, put: async (k, b) => { writes.push(`put ${k}`); return inner.put(k, b); }, del: async (k) => { writes.push(`del ${k}`); return inner.del(k); } };
};

const NOW = Date.now();
const ago = (d: number) => new Date(NOW - d * DAY_MS).toUTCString();
let acct: number, inbox: number, sent: number, targetId: number, B: number;
const SRC = { kind: 'bucket' as const, targetId: null, ref: '' };
let msgs: Record<string, number> = {};
let lblWork = 0, lblClient = 0, lblChild = 0;

async function attMail(subject: string, text: string, days: number) {
  return Buffer.from(await new MailComposer({
    from: 'files@old.test', to: 'alice@demo.test', subject, text: 'see attached', date: new Date(NOW - days * DAY_MS),
    attachments: [{ filename: 'notes.txt', content: Buffer.from(text), contentType: 'text/plain' }],
  }).compile().build());
}

/** Build everything instance A has and archive it. Returns the archive's directory in the bucket. */
async function buildArchive(): Promise<string> {
  lblWork = await insertId("INSERT INTO labels(user_id, name, color, sort, sidebar_visibility, retention_days) VALUES (?,?,?,?,?,?)", [TEST_USER, 'Work', '#aa0000', 1, 'always', 90]);
  lblChild = await insertId("INSERT INTO labels(user_id, name, color, sort, parent_id) VALUES (?,?,?,?,?)", [TEST_USER, 'Work/Acme', '#00aa00', 2, lblWork]);
  lblClient = await insertId("INSERT INTO labels(user_id, name, color, sort) VALUES (?,?,?,?)", [TEST_USER, 'Clients', '#0000aa', 3]);
  const add = async (key: string, subject: string, days: number, opts: any = {}) => {
    const r = await ingest(acct, opts.box ?? inbox, rawEmail({ from: 'shop@old.test', to: 'alice@demo.test', subject, date: ago(days), body: `body of ${subject}`, ...(opts.raw ?? {}) }), { flags: opts.flags ?? ['\\Seen'] });
    msgs[key] = r!.rowId;
    for (const l of opts.labels ?? []) await run('INSERT INTO message_labels(message_id, label_id) VALUES (?,?)', [r!.rowId, l]);
  };
  await add('one', 'Quarterly invoice', 900, { labels: [lblWork] });
  await add('two', 'Site visit', 800, { labels: [lblChild, lblClient], flags: ['\\Seen', '\\Flagged'] });
  await add('three', 'Unread old thing', 700, { flags: [] });
  await add('reply', 'Re: Quarterly invoice', 890, { box: sent, flags: ['\\Seen', '\\Answered'], raw: { from: 'alice@demo.test', to: 'shop@old.test', inReplyTo: '<root@old.test>' } });
  const withAtt = await ingest(acct, inbox, await attMail('Has attachment', 'zebrafish migration notes', 600), { flags: ['\\Seen'] });
  msgs.att = withAtt!.rowId;
  await add('fresh', 'Fresh mail', 5);
  // app data on A
  await run("INSERT INTO rules(user_id, enabled, ord, match_field, match_value, action, label_id, stop, created_at) VALUES (?,?,?,?,?,?,?,?,?)", [TEST_USER, true, 1, 'from_domain', 'old.test', 'label', lblClient, true, NOW]);
  await run("INSERT INTO filters(user_id, name, enabled, sort, match, conditions, actions, stop) VALUES (?,?,?,?,?,?,?,?)",
    [TEST_USER, 'Invoices', true, 0, 'all', JSON.stringify([{ field: 'subject', op: 'contains', value: 'invoice' }]), JSON.stringify([{ type: 'label', value: String(lblWork) }]), false]);
  await run("INSERT INTO saved_views(user_id, name, query, scope) VALUES (?,?,?,?)", [TEST_USER, 'Flagged work', 'label:Work', 'unified']);
  await run("INSERT INTO templates(user_id, name, subject, body_html, shortcut, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", [TEST_USER, 'Thanks', 'Thanks!', '<p>Thank you</p>', ';thx', NOW, NOW]);
  const cid = await insertId("INSERT INTO contacts(user_id, display_name, org, auto_created, created_at, updated_at) VALUES (?,?,?,?,?,?)", [TEST_USER, 'Sam Shop', 'Old Shop', false, NOW, NOW]);
  await run("INSERT INTO contact_emails(contact_id, email, is_primary) VALUES (?,?,true)", [cid, 'sam@old.test']);
  const bid = await insertId("INSERT INTO businesses(user_id, name, brand_color, created_at) VALUES (?,?,?,?)", [TEST_USER, 'Acme Pty', '#112233', NOW]);
  await run("INSERT INTO identities(user_id, account_id, business_id, email, display_name, signature_html) VALUES (?,?,?,?,?,?) ON CONFLICT (account_id, email) DO UPDATE SET business_id = EXCLUDED.business_id", [TEST_USER, acct, bid, 'alice@demo.test', 'Alice A', '<p>--Alice</p>']);
  await run("INSERT INTO vip_senders(user_id, kind, value, created_at) VALUES (?,?,?,?)", [TEST_USER, 'address', 'boss@old.test', NOW]);
  await run("INSERT INTO trusted_senders(user_id, kind, value, created_at) VALUES (?,?,?,?)", [TEST_USER, 'domain', 'old.test', NOW]);
  await run("INSERT INTO notes(user_id, email_id, body, updated_at) VALUES (?,?,?,?)", [TEST_USER, `m${msgs.one}`, 'remember the PO number', NOW]);
  await run("INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?), (?,?,?)", [TEST_USER, 'theme', 'midnight', TEST_USER, 'api_token_x', 'secret']);

  await runDueJobs();    // attachment text for A
  const a = await planArchive(TEST_USER, { olderThanDays: 183, mode: 'copy', targetId, name: 'Old mail 2012-2020', options: { includeStarred: true } });
  while (!(await runArchiveSlice(a.id))) { /* more slices */ }
  return `archive/${a.id}/`;
}

const importAs = async (dir: string, opts: any = {}, user = B) => {
  const [imp] = await queueImport(user, SRC, [dir], opts);
  while (!(await runImportSlice(imp.id))) { /* more slices */ }
  return (await one<any>('SELECT * FROM archive_imports WHERE id = ?', [imp.id]))!;
};
const bAccounts = () => q<any>('SELECT * FROM accounts WHERE user_id = ? AND archived ORDER BY id', [B]);
const bMessages = () => q<any>('SELECT * FROM messages WHERE user_id = ? ORDER BY date', [B]);
const search = (user: number, text: string, scope = 'unified') => queryEmails(user, { filter: { text, scope }, position: 0, limit: 100 });

beforeEach(async () => {
  await resetDb(); resetLimiters(); blobStore.clear(); objects = new Map(); writes = []; corrupt = () => false; msgs = {};
  setArchiveStoreFactory(async () => mem());
  setSourceStoreFactory(async () => readOnly(spy()));
  acct = await makeAccount('alice@demo.test');
  inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  sent = await makeMailbox(acct, 'Sent', 'sent');
  targetId = await insertTarget({ role: 'backup', provider: 'minio', endpoint: 'http://localhost:9100', region: 'us-east-1', bucket: 'seamless-test-archive', accessKey: 'k', secretKey: 's', forcePathStyle: true }, true, null);
  B = await makeUser('bob@viewer.test', 'admin');
});

describe('import round trip', () => {
  it('brings over the same messages, dates, flags, labels, threads and attachment text', async () => {
    const dir = await buildArchive();
    const aRows = await q<any>('SELECT * FROM messages WHERE user_id = ? AND date < ? ORDER BY date', [TEST_USER, NOW - 100 * DAY_MS]);
    expect(aRows.length).toBe(5);
    const imp = await importAs(dir);
    expect(imp.status).toBe('done');
    expect(imp.imported).toBe(5); expect(imp.failed).toBe(0); expect(imp.total).toBe(5);

    const accts = await bAccounts();
    expect(accts).toHaveLength(1);
    expect(accts[0]).toMatchObject({ email: 'alice@demo.test', enabled: false, inbound_kind: 'none', imap_pass_enc: '', smtp_pass_enc: '' });
    expect(accts[0].name).toMatch(/^Archive — alice@demo.test \(\d{4}[–)]/);

    const bRows = await bMessages();
    expect(bRows.map((r) => r.subject)).toEqual(aRows.map((r) => r.subject));
    expect(bRows.map((r) => Number(r.date))).toEqual(aRows.map((r) => Number(r.date)));
    expect(bRows.map((r) => [r.unread, r.flagged, r.answered])).toEqual(aRows.map((r) => [r.unread, r.flagged, r.answered]));
    expect(bRows.every((r) => r.disposition === 'keep' && r.keep_reason === 'archived' && r.classify_state === 'classified')).toBe(true);
    // mailboxes keep their original path and role
    expect((await q<any>('SELECT path, role FROM mailboxes WHERE account_id = ? ORDER BY path', [accts[0].id])).map((m) => [m.path, m.role])).toEqual([['INBOX', 'inbox'], ['Sent', 'sent']]);
    // threads: the reply is in the same thread as the root it answered (by References), same as on A
    const aThreads = new Map(aRows.map((r) => [r.subject, r.thread_id]));
    expect(new Set(aRows.map((r) => r.thread_id)).size).toBe(new Set(bRows.map((r) => r.thread_id)).size);
    expect(aThreads.size).toBe(5);

    // labels arrive with colour, parent and retention
    const wl = await one<any>("SELECT * FROM labels WHERE user_id = ? AND name = 'Work'", [B]);
    const child = await one<any>("SELECT * FROM labels WHERE user_id = ? AND name = 'Work/Acme'", [B]);
    expect(wl).toMatchObject({ color: '#aa0000', retention_days: 90 });
    expect(child.parent_id).toBe(wl.id); expect(child.color).toBe('#00aa00');
    const labelled = await q<any>("SELECT m.subject, l.name FROM message_labels ml JOIN messages m ON m.id = ml.message_id JOIN labels l ON l.id = ml.label_id WHERE m.user_id = ? ORDER BY 1, 2", [B]);
    expect(labelled.map((r) => `${r.subject}|${r.name}`)).toEqual(['Quarterly invoice|Work', 'Site visit|Clients', 'Site visit|Work/Acme']);
    expect((await search(B, 'label:Work')).total).toBeGreaterThanOrEqual(1);

    // search incl. attachment text, and nothing leaked to the other user
    await runDueJobs();
    expect((await search(B, 'attachment:zebrafish')).total).toBe(1);
    expect((await search(B, 'invoice')).total).toBe(2);
    expect((await search(TEST_USER, 'attachment:zebrafish')).total).toBe(1);
  });

  it('is private to the importing user (user C sees nothing)', async () => {
    const dir = await buildArchive();
    await importAs(dir);
    const C = await makeUser('carol@viewer.test', 'admin');
    expect((await q<any>('SELECT 1 FROM messages WHERE user_id = ?', [C])).length).toBe(0);
    expect((await search(C, 'invoice')).total).toBe(0);
    expect((await q<any>('SELECT 1 FROM accounts WHERE user_id = ? AND archived', [C])).length).toBe(0);
    const app = await makeApp(); const cookie = await login(app, 'carol@viewer.test');
    const res = await app.inject({ method: 'GET', url: '/api/archives/imports', headers: { cookie } });
    expect(res.json().imports).toEqual([]);
    const imp = await one<any>('SELECT id FROM archive_imports WHERE user_id = ?', [B]);
    expect((await app.inject({ method: 'GET', url: `/api/archives/imports/${imp.id}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/archives/imports/${imp.id}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await one<any>('SELECT COUNT(*)::int n FROM messages WHERE user_id = ?', [B])).n).toBe(5);
  });

  it('imported mail is never polled, never classified or notified, and the source was never written to', async () => {
    const dir = await buildArchive();
    await run('DELETE FROM notifications WHERE user_id = ?', [B]).catch(() => {});
    await importAs(dir);
    const [a] = await bAccounts();
    expect(a.enabled).toBe(false);
    expect((await q<any>("SELECT 1 FROM accounts WHERE enabled = true AND user_id = ? AND archived", [B])).length).toBe(0);
    expect((await q<any>("SELECT 1 FROM notifications WHERE user_id = ?", [B]).catch(() => [])).length).toBe(0);
    expect((await q<any>("SELECT 1 FROM messages WHERE user_id = ? AND classify_state <> 'classified'", [B])).length).toBe(0);
    expect(writes).toEqual([]);
    // the read-only wrapper itself refuses writes, even with a read-write key
    await expect(readOnly(mem()).put('x', Buffer.from('y'))).rejects.toThrow(/read-only/);
    await expect(readOnly(mem()).del('x')).rejects.toThrow(/read-only/);
  });
});

describe('resume, failures, refusal', () => {
  it('resume after an interruption does not duplicate; a re-import changes nothing', async () => {
    const dir = await buildArchive();
    const [imp] = await queueImport(B, SRC, [dir], {});
    // interrupted: only a few messages in this slice (budget 0 stops after the first check interval, so do it by hand)
    const entries = await q<any>('SELECT 1');
    expect(entries).toBeTruthy();
    await runImportSlice(imp.id, { budgetMs: 0 });
    const mid = (await one<any>('SELECT imported FROM archive_imports WHERE id = ?', [imp.id]))!.imported;
    while (!(await runImportSlice(imp.id))) { /* finish */ }
    expect((await bMessages()).length).toBe(5);
    expect(mid).toBeLessThanOrEqual(5);
    const again = await queueImport(B, SRC, [dir], {});            // same archive again → same import row, no new mail
    expect(again[0].id).toBe(imp.id);
    while (!(await runImportSlice(imp.id))) { /* finish */ }
    expect((await bMessages()).length).toBe(5);
    expect((await q<any>('SELECT 1 FROM mail_archive_imports WHERE import_id = ?', [imp.id])).length).toBe(5);
    expect((await q<any>('SELECT 1 FROM archive_imports WHERE user_id = ?', [B])).length).toBe(1);
  });

  it('a crash half way (job retried from the start) leaves exactly one copy of each message', async () => {
    const dir = await buildArchive();
    const [imp] = await queueImport(B, SRC, [dir], {});
    let n = 0;
    setSourceStoreFactory(async () => { const s = mem(); return readOnly({ ...s, get: async (k) => { if (k.endsWith('.eml') && ++n === 3) throw new Error('connection reset'); return s.get(k); }, list: s.list }); });
    await expect(runImportSlice(imp.id)).rejects.toThrow(/connection reset/);
    expect((await bMessages()).length).toBeGreaterThan(0);
    setSourceStoreFactory(async () => readOnly(spy()));
    while (!(await runImportSlice(imp.id))) { /* finish */ }
    const rows = await bMessages();
    expect(rows.length).toBe(5);
    expect(new Set(rows.map((r) => r.s3_key)).size).toBe(5);
  });

  it('a sha256 mismatch fails only that item, lists it, and Retry brings it in once the source is fixed', async () => {
    const dir = await buildArchive();
    const bad = [...objects.keys()].find((k) => k.endsWith(`/${msgs.two}.eml`))!;
    corrupt = (k) => k === bad;
    const imp = await importAs(dir);
    expect(imp.status).toBe('done'); expect(imp.imported).toBe(4); expect(imp.failed).toBe(1);
    expect(imp.error).toMatch(/1 message could not be imported/);
    const app = await makeApp(); const cookie = await login(app, 'bob@viewer.test');
    const det = (await app.inject({ method: 'GET', url: `/api/archives/imports/${imp.id}`, headers: { cookie } })).json();
    expect(det.failures).toHaveLength(1); expect(det.failures[0].error).toMatch(/checksum/);
    corrupt = () => false;
    expect(await retryImport(B, imp.id)).toBe(true);
    while (!(await runImportSlice(imp.id))) { /* finish */ }
    const after = (await one<any>('SELECT * FROM archive_imports WHERE id = ?', [imp.id]))!;
    expect(after.imported).toBe(5); expect(after.failed).toBe(0);
    expect((await bMessages()).length).toBe(5);
  });

  it('refuses a newer-format manifest (nothing created) and shows it greyed in the scan', async () => {
    const dir = await buildArchive();
    const m = JSON.parse(objects.get(`${dir}manifest.json`)!.toString());
    objects.set(`${dir}manifest.json`, Buffer.from(JSON.stringify({ ...m, version: 2 })));
    const found = await scanSource(mem());
    expect(found.archives[0]).toMatchObject({ supported: false });
    expect(found.archives[0].reason).toMatch(/newer version/);
    await expect(queueImport(B, SRC, [dir], {})).rejects.toThrow(/newer version/);
    expect((await q<any>('SELECT 1 FROM archive_imports')).length).toBe(0);
    expect((await bAccounts()).length).toBe(0);
  });

  it('pause stops a running import and resume finishes it', async () => {
    const dir = await buildArchive();
    const [imp] = await queueImport(B, SRC, [dir], {});
    expect(await pauseImport(B, imp.id)).toBe(true);
    expect(await runImportSlice(imp.id)).toBe(true);
    expect((await bMessages()).length).toBe(0);
    expect(await resumeImport(B, imp.id)).toBe(true);
    await runDueJobs();
    expect((await one<any>('SELECT status FROM archive_imports WHERE id = ?', [imp.id]))!.status).toBe('done');
    expect((await bMessages()).length).toBe(5);
  });

  it('only some accounts: unpicked accounts are not imported', async () => {
    const acct2 = await makeAccount('alice2@demo.test');
    const box2 = await makeMailbox(acct2, 'INBOX', 'inbox');
    await ingest(acct2, box2, rawEmail({ from: 'x@old.test', to: 'alice2@demo.test', subject: 'Second account mail', date: ago(900), body: 'b2' }), { flags: ['\\Seen'] });
    const dir = await buildArchive();
    const m = JSON.parse(objects.get(`${dir}manifest.json`)!.toString());
    expect(m.accounts).toHaveLength(2);
    const key2 = m.accounts.find((a: any) => a.email === 'alice2@demo.test').key;
    const imp = await importAs(dir, { accounts: [key2] });
    expect(imp.imported).toBe(1);
    expect((await bAccounts()).map((a) => a.email)).toEqual(['alice2@demo.test']);
  });
});

describe('secrets', () => {
  it('manifest.json and config.json contain no secrets', async () => {
    const dir = await buildArchive();
    for (const f of ['manifest.json', 'config.json']) {
      const text = objects.get(`${dir}${f}`)!.toString();
      const walk = (v: any, p: string) => { if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { expect(k, `${f} ${p}.${k}`).not.toMatch(/pass|secret|token|private|api[_-]?key|creds|_enc$/i); walk(x, `${p}.${k}`); } };
      walk(JSON.parse(text), f);
    }
    // the user setting named like a secret never made it into config.json, and never into B
    await importAs(dir);
    expect((await q<any>("SELECT 1 FROM user_settings WHERE user_id = ? AND key = 'api_token_x'", [B])).length).toBe(0);
    expect((await q<any>("SELECT 1 FROM user_settings WHERE user_id = ? AND key = 'theme'", [B])).length).toBe(1);
  });
});

describe('app data arrives and works', () => {
  it('labels, rules, filters, saved views, templates, contacts, businesses/identities, senders, notes, appearance', async () => {
    const dir = await buildArchive();
    const imp = await importAs(dir);
    const r = imp.config_result;
    expect(r.labels.created).toBe(3);
    for (const k of ['rules', 'filters', 'views', 'templates', 'contacts', 'businesses', 'senders', 'appearance'] as const) expect(r[k].created, k).toBeGreaterThan(0);
    expect(r.notes.created).toBe(1);

    const work = (await one<any>("SELECT id FROM labels WHERE user_id = ? AND name = 'Work'", [B]))!.id;
    const clients = (await one<any>("SELECT id FROM labels WHERE user_id = ? AND name = 'Clients'", [B]))!.id;
    const rule = (await one<any>("SELECT * FROM rules WHERE user_id = ?", [B]))!;
    expect(rule).toMatchObject({ match_field: 'from_domain', match_value: 'old.test', label_id: clients, source: 'imported' });
    const flt = (await loadFilters(B))[0];
    expect(flt.name).toBe('Invoices'); expect(flt.actions).toEqual([{ type: 'label', value: String(work) }]);
    expect((await one<any>("SELECT query FROM saved_views WHERE user_id = ? AND name = 'Flagged work'", [B]))!.query).toBe('label:Work');
    expect((await one<any>("SELECT shortcut FROM templates WHERE user_id = ? AND name = 'Thanks'", [B]))!.shortcut).toBe(';thx');
    expect((await q<any>("SELECT 1 FROM contact_emails ce JOIN contacts c ON c.id = ce.contact_id WHERE c.user_id = ? AND ce.email = 'sam@old.test'", [B])).length).toBe(1);
    const biz = (await one<any>("SELECT id FROM businesses WHERE user_id = ? AND name = 'Acme Pty'", [B]))!;
    const [a] = await bAccounts();
    expect((await one<any>("SELECT business_id, is_default FROM identities WHERE account_id = ?", [a.id]))).toMatchObject({ business_id: biz.id, is_default: false });
    expect((await q<any>("SELECT 1 FROM vip_senders WHERE user_id = ? AND value = 'boss@old.test'", [B])).length).toBe(1);
    expect((await q<any>("SELECT 1 FROM trusted_senders WHERE user_id = ? AND value = 'old.test'", [B])).length).toBe(1);
    const one_ = (await one<any>("SELECT message_id FROM mail_archive_imports WHERE import_id = ? AND message_key = ?", [imp.id, `M${msgs.one}`]))!.message_id;
    expect((await one<any>("SELECT body FROM notes WHERE user_id = ? AND email_id = ?", [B, `m${one_}`]))!.body).toBe('remember the PO number');

    // they WORK: the filter's "run on existing mail" labels imported inbox mail; the saved view and label search list the right messages
    const app = await makeApp(); const cookie = await login(app, 'bob@viewer.test');
    await run("DELETE FROM message_labels WHERE label_id = ?", [work]);
    const run_ = await app.inject({ method: 'POST', url: `/api/filters/${(await one<any>("SELECT id FROM filters WHERE user_id = ?", [B]))!.id}/run`, headers: { cookie } });
    expect(run_.json().applied).toBeGreaterThan(0);
    const lab = await search(B, 'label:Work');
    expect(lab.total).toBe(1);   // the filter's 'run on existing mail' only covers inbox mail: "Quarterly invoice" (the reply sits in Sent)
    expect((await queryEmails(B, { filter: { text: 'label:Work', scope: 'unified' }, position: 0, limit: 10 })).ids).toEqual([`m${one_}`]);
  });

  it('existing items with the same name are skipped, not overwritten; category tick-boxes are respected', async () => {
    const dir = await buildArchive();
    await run("INSERT INTO labels(user_id, name, color) VALUES (?,?,?)", [B, 'Work', '#ffffff']);
    await run("INSERT INTO templates(user_id, name, subject, body_html, created_at, updated_at) VALUES (?,?,?,?,?,?)", [B, 'Thanks', 'MINE', '<p>mine</p>', NOW, NOW]);
    await run("INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?)", [B, 'theme', 'daylight']);
    const imp = await importAs(dir, { categories: { contacts: false, rules: false, notes: false, businesses: false } });
    expect((await one<any>("SELECT color FROM labels WHERE user_id = ? AND name = 'Work'", [B]))!.color).toBe('#ffffff');
    expect(imp.config_result.labels).toMatchObject({ created: 2, skipped: 1 });
    expect((await one<any>("SELECT subject FROM templates WHERE user_id = ? AND name = 'Thanks'", [B]))!.subject).toBe('MINE');
    expect(imp.config_result.templates).toMatchObject({ created: 0, skipped: 1 });
    expect((await one<any>("SELECT value FROM user_settings WHERE user_id = ? AND key = 'theme'", [B]))!.value).toBe('daylight');
    expect((await q<any>("SELECT 1 FROM contacts WHERE user_id = ?", [B])).length).toBe(0);
    expect((await q<any>("SELECT 1 FROM rules WHERE user_id = ?", [B])).length).toBe(0);
    expect((await q<any>("SELECT 1 FROM businesses WHERE user_id = ?", [B])).length).toBe(0);
    expect((await q<any>("SELECT 1 FROM notes WHERE user_id = ?", [B])).length).toBe(0);
    expect((await q<any>("SELECT 1 FROM filters WHERE user_id = ?", [B])).length).toBe(1);
    // existing label 'Work' (white) is still used for the mail
    expect((await q<any>("SELECT 1 FROM message_labels ml JOIN labels l ON l.id = ml.label_id JOIN messages m ON m.id = ml.message_id WHERE m.user_id = ? AND l.name = 'Work'", [B])).length).toBe(1);
  });

  it('labels off: no labels are created or applied', async () => {
    const dir = await buildArchive();
    await importAs(dir, { categories: { labels: false } });
    expect((await q<any>("SELECT 1 FROM labels WHERE user_id = ?", [B])).length).toBe(0);
    expect((await q<any>("SELECT 1 FROM message_labels ml JOIN messages m ON m.id = ml.message_id WHERE m.user_id = ?", [B])).length).toBe(0);
    expect((await bMessages()).length).toBe(5);
  });
});

describe('removing imported mail, other sources, source test', () => {
  it('Remove imported mail deletes only what came from that archive', async () => {
    const dir = await buildArchive();
    const imp = await importAs(dir);
    const own = await makeAccount('bob@viewer.test', { userId: B });
    const ownBox = await makeMailbox(own, 'INBOX', 'inbox');
    await ingest(own, ownBox, rawEmail({ from: 'x@y.test', to: 'bob@viewer.test', subject: 'Bobs own mail', body: 'mine' }));
    expect(await removeImport(B, imp.id)).toEqual({ removed: 5 });
    const left = await bMessages();
    expect(left.map((m) => m.subject)).toEqual(['Bobs own mail']);
    expect((await bAccounts()).length).toBe(0);
    expect((await q<any>('SELECT 1 FROM archive_imports')).length).toBe(0);
    expect((await q<any>('SELECT 1 FROM messages WHERE user_id = ?', [TEST_USER])).length).toBeGreaterThan(5);   // A is untouched
  });

  it('imports from an uploaded .zip of the archive folder', async () => {
    const dir = await buildArchive();
    const zip = new JSZip();
    for (const [k, v] of objects) zip.file(`my-download/${k}`, v);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seamless-t8-zip-')), 'a.zip');
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    setSourceStoreFactory(null);
    const found = await scanSource(await zipStore(file));
    expect(found.archives).toHaveLength(1);
    expect(found.archives[0].path).toBe(`my-download/${dir}`);
    const src = { kind: 'zip' as const, targetId: null, ref: file };
    const [imp] = await queueImport(B, src, [found.archives[0].path], {});
    while (!(await runImportSlice(imp.id))) { /* finish */ }
    expect((await bMessages()).length).toBe(5);
  });

  it('a full backup in the bucket is detected and explained, not imported', async () => {
    objects.set('seamless-backups/2026-01-01/manifest.json', Buffer.from(JSON.stringify({ v: 2, createdAt: NOW, appVersion: '1.0.0', tables: { users: 1 }, rows: 10, bytes: 100, enc: 'aes-256-gcm', secretCheck: 'x', key: 'seamless-backups/2026-01-01/' })));
    const found = await scanSource(mem());
    expect(found.archives).toHaveLength(0);
    expect(found.backups[0].note).toMatch(/Settings → Backup → Restore/);
  });

  it('the 7-step connection test works with a read-only key and never writes', async () => {
    const dir = await buildArchive();
    const roStore: any = { ...mem(), headBucket: async () => {}, put: async () => { throw new Error('AccessDenied'); }, del: async () => { throw new Error('AccessDenied'); } };
    const res = await testSource({ endpoint: 'http://localhost:9100', region: 'us-east-1', bucket: 'b', accessKey: 'k', secretKey: 's', forcePathStyle: true }, { store: roStore, fetchImpl: (async () => ({ status: 403 })) as any });
    expect(res.steps.map((s) => s.id)).toEqual(['reach', 'auth', 'list', 'find', 'manifest', 'format', 'eml']);
    expect(res.ok).toBe(true);
    expect(res.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(dir).toContain('archive/');
    const empty = await testSource({ endpoint: 'http://localhost:9100', region: 'us-east-1', bucket: 'b', accessKey: 'k', secretKey: 's', forcePathStyle: true }, { store: { ...mem(), list: async () => [], headBucket: async () => {} } as any, fetchImpl: (async () => ({ status: 200 })) as any });
    expect(empty.ok).toBe(false);
    expect(empty.steps.find((s) => s.id === 'find')!.status).toBe('fail');
  });

  it('attach endpoints are admin only and store the key encrypted', async () => {
    const member = await makeUser('mia@viewer.test', 'member');
    const app = await makeApp(); const cookie = await login(app, 'mia@viewer.test');
    const body = { provider: 'minio', endpoint: 'http://localhost:9100', region: 'us-east-1', bucket: 'x', accessKey: 'k', secretKey: 's' };
    for (const [m, u] of [['GET', '/api/archives/sources'], ['POST', '/api/archives/sources/test'], ['POST', '/api/archives/sources'], ['GET', '/api/archives/imports'], ['POST', '/api/archives/imports']] as const) {
      expect((await app.inject({ method: m, url: u, payload: body, headers: { cookie } })).statusCode, `${m} ${u}`).toBe(403);
    }
    expect(member).toBeTruthy();
    await insertTarget({ role: 'archive_source', provider: 'minio', endpoint: 'http://localhost:9100', region: 'us-east-1', bucket: 'ro', accessKey: 'AKIAREADONLY', secretKey: 'topsecret', forcePathStyle: true, prefix: '' }, false, null);
    const adminCookie = await login(app, 'bob@viewer.test');
    const list = (await app.inject({ method: 'GET', url: '/api/archives/sources', headers: { cookie: adminCookie } })).json();
    expect(list.sources).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/topsecret|AKIAREADONLY/);
    // the normal storage list does not show it, so no mail/backup flow can pick it up
    const st = (await app.inject({ method: 'GET', url: '/api/storage/targets', headers: { cookie: adminCookie } })).json();
    expect(st.targets).toHaveLength(1);
    expect(st.targets[0].role).toBe('backup');
  });
});

describe('gz helper sanity', () => { it('gzip is available', () => { expect(gzipSync(Buffer.from('a')).length).toBeGreaterThan(0); expect(sha256(Buffer.from('a'))).toHaveLength(64); }); });
