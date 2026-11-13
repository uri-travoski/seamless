/** T10.3: database maintenance framework — tasks, log, lock, schedule, orphan files, admin API. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resetDb, makeUser, makeAccount, makeMailbox, blobStore, blobAges, ingest, rawEmail } from './helpers.ts';

const { q, one, run, pool } = await import('../src/db.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');
const { config } = await import('../src/config.ts');
const { mailStore } = await import('../src/s3.ts');
const E = await import('../src/maintenance/engine.ts');
const T = await import('../src/maintenance/tasks.ts');
const { markBusy } = await import('../src/maintenance/busy.ts');
const { runDueJobs } = await import('../src/jobs/runner.ts');

const DAY = 86_400_000;
const now = () => Date.now();
const ago = (days: number) => now() - days * DAY;
let ADMIN: number, A: number;
let app: Awaited<ReturnType<typeof makeApp>>;
let ckAdmin = '', ckA = '';
const api = (ck: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck } });
const count = async (table: string, where = 'true') => Number((await one<{ c: string }>(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`))!.c);
const run1 = (id: string, o: Partial<Parameters<typeof E.runTask>[1]> = {}) => E.runTask(id, { trigger: 'manual', userId: ADMIN, ...o });

beforeEach(async () => {
  await resetDb(); resetLimiters();
  await run('DELETE FROM jobs');
  blobStore.clear(); blobAges.clear();
  E.setMaintenancePause(0);
  ADMIN = await makeUser('admin@x.test', 'admin'); A = await makeUser('a@x.test');
  app = await makeApp();
  ckAdmin = await login(app, 'admin@x.test'); ckA = await login(app, 'a@x.test');
  await run('DELETE FROM events');   // sign-ins emit events: start each test with none
});
afterEach(() => { E.setMaintenancePause(100); });

describe('cleanup tasks keep what they must (age boundaries)', () => {
  it('finished jobs: done > 7 d and failed > 30 d go; pending/running and newer stay', async () => {
    const ins = (status: string, fin: number | null) => run('INSERT INTO jobs(kind, run_at, status, finished_at, created_at) VALUES (?,?,?,?,?)', ['x', now(), status, fin, now()]);
    await ins('done', ago(8)); await ins('done', ago(6)); await ins('failed', ago(20)); await ins('failed', ago(31)); await ins('pending', null); await ins('running', null);
    const log = await run1('jobs');
    expect(log.status).toBe('ok'); expect(log.rowsRemoved).toBe(2);
    expect(await count('jobs', "kind = 'x'")).toBe(4);
    expect(await count('jobs', "kind = 'x' AND status IN ('pending','running')")).toBe(2);
  });

  it('events > 90 d go, newer stay', async () => {
    await run('INSERT INTO events(user_id, type, created_at) VALUES (?,?,?),(?,?,?)', [A, 't', ago(91), A, 't', ago(89)]);
    expect((await run1('events')).rowsRemoved).toBe(1);
    expect(await count('events')).toBe(1);
  });

  it('notifications: read > 90 d and unread > 180 d go; unread 100 d stays', async () => {
    const n = (read: boolean, days: number) => run('INSERT INTO notifications(user_id, type, title, read_at, created_at, updated_at) VALUES (?,?,?,?,?,?)', [A, 't', 'x', read ? ago(1) : null, ago(days), ago(days)]);
    await n(true, 91); await n(true, 89); await n(false, 100); await n(false, 181);
    expect((await run1('notifications')).rowsRemoved).toBe(2);
    expect(await count('notifications')).toBe(2);
  });

  it('alerts: resolved+read > 90 d go; open critical alerts and unread resolved stay', async () => {
    const al = (state: string, read: number | null, resolved: number | null, opened: number) =>
      run('INSERT INTO alerts(user_id, kind, source_type, source_id, title, state, read_at, resolved_at, opened_at) VALUES (?,?,?,?,?,?,?,?,?)', [A, 'k', 's', String(Math.random()), 't', state, read, resolved, opened]);
    await al('resolved', ago(100), ago(100), ago(120));   // goes
    await al('resolved', ago(10), ago(10), ago(20));      // too new
    await al('resolved', null, ago(100), ago(120));       // never read: stays
    await al('open', null, null, ago(400));               // open for a year: stays
    expect((await run1('alerts')).rowsRemoved).toBe(1);
    expect(await count('alerts')).toBe(3);
    expect(await count('alerts', "state = 'open'")).toBe(1);
  });

  it('webhook deliveries: ok > 30 d, failed/giving_up > 60 d', async () => {
    const hid = Number((await q<{ id: number }>("INSERT INTO webhooks(user_id, name, url, secret_enc, event_types, created_at) VALUES (?,?,?,?,?,?) RETURNING id", [A, 'h', 'http://x.test', 'x', ['a'], now()]))[0].id);
    const eid = Number((await q<{ id: number }>("INSERT INTO events(user_id, type, created_at) VALUES (?,?,?) RETURNING id", [A, 't', now()]))[0].id);
    const d = (status: string, days: number) => run('INSERT INTO webhook_deliveries(webhook_id, event_id, status, created_at) VALUES (?,?,?,?)', [hid, eid, status, ago(days)]);
    await d('ok', 31); await d('ok', 29); await d('failed', 61); await d('failed', 45); await d('giving_up', 61); await d('pending', 90);
    expect((await run1('webhooks')).rowsRemoved).toBe(3);
    expect(await count('webhook_deliveries')).toBe(3);
  });

  it('processing logs > 60 d, bounces > 180 d', async () => {
    await run('INSERT INTO processing_logs(kind, message, created_at) VALUES (?,?,?),(?,?,?)', ['k', 'm', ago(61), 'k', 'm', ago(59)]);
    expect((await run1('processing_logs')).rowsRemoved).toBe(1);
    const { rowId } = await seedMail();
    await run('INSERT INTO bounces(user_id, message_id, recipient, created_at) VALUES (?,?,?,?),(?,?,?,?)', [A, rowId, 'r1', ago(181), A, rowId, 'r2', ago(179)]);
    expect((await run1('bounces')).rowsRemoved).toBe(1);
    expect(await count('bounces')).toBe(1);
  });

  it('stale devices and dead API tokens', async () => {
    await run('INSERT INTO mobile_devices(user_id, fcm_token, last_seen_at, created_at) VALUES (?,?,?,?),(?,?,?,?)', [A, 't'.repeat(30), ago(91), ago(200), A, 'u'.repeat(30), ago(10), ago(200)]);
    await run('INSERT INTO push_subscriptions(user_id, endpoint, keys_json, created_at) VALUES (?,?,?,?)', [A, 'https://e/1', '{}', ago(200)]);
    const d = await run1('devices');
    expect(d.rowsRemoved).toBe(1);                         // the old phone; the browser sub stays: its owner signed in just now
    expect(await count('mobile_devices')).toBe(1);
    const tok = (revoked: number | null, expires: number | null) => run('INSERT INTO api_tokens(user_id, name, token_hash, prefix, revoked_at, expires_at, created_at) VALUES (?,?,?,?,?,?,?)', [A, 'n', String(Math.random()), 'p', revoked, expires, ago(500)]);
    await tok(ago(91), null); await tok(ago(10), null); await tok(null, ago(91)); await tok(null, null); await tok(null, now() + DAY);
    expect((await run1('api_tokens')).rowsRemoved).toBe(2);
    expect(await count('api_tokens')).toBe(3);
  });

  it('browser push subscription of a user who signed in recently is kept', async () => {
    await run('INSERT INTO push_subscriptions(user_id, endpoint, keys_json, created_at) VALUES (?,?,?,?)', [A, 'https://e/1', '{}', ago(200)]);
    await run('UPDATE sessions SET last_seen_at = ? WHERE user_id = ?', [now(), A]);
    expect((await run1('devices')).rowsRemoved).toBe(0);
  });

  it('expired sessions go, live ones stay', async () => {
    await run('INSERT INTO sessions(token, user_id, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?)', ['old', A, ago(5), ago(5), ago(1)]);
    const before = await count('sessions');
    expect((await run1('sessions')).rowsRemoved).toBe(1);
    expect(await count('sessions')).toBe(before - 1);
  });

  it('seen tables: old rows go unless the mail is still on the server', async () => {
    const acct = await makeAccount('p@x.test', { userId: A });
    const pop = await makeAccount('pop@x.test', { userId: A });
    const keep = await makeAccount('keep@x.test', { userId: A });
    await run("UPDATE accounts SET inbound_kind = 'pop3', pop3_leave_on_server = true WHERE id = ?", [keep]);
    await run("UPDATE accounts SET inbound_kind = 'pop3', pop3_leave_on_server = false WHERE id = ?", [pop]);
    await run('INSERT INTO push_seen(account_id, dedupe_key, created_at) VALUES (?,?,?),(?,?,?)', [acct, 'a', ago(61), acct, 'b', ago(59)]);
    await run('INSERT INTO pop3_seen(account_id, uidl, fetched_at) VALUES (?,?,?),(?,?,?),(?,?,?)', [pop, 'u1', ago(61), pop, 'u2', ago(59), keep, 'u3', ago(300)]);
    await run('INSERT INTO catchall_seen(account_id, source_key, handled, created_at) VALUES (?,?,?,?),(?,?,?,?)', [acct, 'k1', true, ago(61), acct, 'k2', false, ago(300)]);
    const log = await run1('seen');
    expect(log.rowsRemoved).toBe(3);                       // push a, pop3 u1, catchall k1
    expect(await count('push_seen')).toBe(1);
    expect(await count('pop3_seen', "uidl IN ('u2','u3')")).toBe(2);
    expect(await count('catchall_seen', "source_key = 'k2'")).toBe(1);
  });

  it('tracking opens: old raw rows fold into one summary row, totals + last open kept, idempotent', async () => {
    const ins = (token: string, days: number, proxied = false) => run('INSERT INTO tracking_opens(token, ts, ip, ua, proxied) VALUES (?,?,?,?,?)', [token, ago(days), '1.1.1.1', 'ua', proxied]);
    await ins('tk', 400); await ins('tk', 380); await ins('tk', 370); await ins('tk', 366, true); await ins('tk', 10);
    const log = await run1('tracking_opens');
    expect(log.rowsRemoved).toBe(2);                       // 3 real old rows → 1 summary, 1 proxied old row → 1 summary (net −2)
    expect(await count('tracking_opens')).toBe(3);         // 2 summaries + 1 recent
    expect(Number((await one<{ s: string }>("SELECT SUM(n) AS s FROM tracking_opens WHERE NOT proxied"))!.s)).toBe(4);
    const sum = await one<any>("SELECT * FROM tracking_opens WHERE client = 'archived' AND NOT proxied");
    expect(Number(sum.n)).toBe(3); expect(Number(sum.ts)).toBeGreaterThan(ago(371));
    expect((await run1('tracking_opens')).rowsRemoved).toBe(0);
  });

  it('orphan rows: only rows pointing at deleted messages go', async () => {
    const { rowId } = await seedMail();
    await run('INSERT INTO message_fts(message_id, subject, body, addrs) VALUES (?,?,?,?)', [rowId, 's', 'b', 'a']).catch(() => {});
    const gone = rowId + 9999;
    const tryIns = async (sql: string, p: unknown[]) => { try { await run('SET session_replication_role = replica'); await run(sql, p); } finally { await run('SET session_replication_role = DEFAULT'); } };
    const c = await pool.connect();
    try {
      await c.query('SET session_replication_role = replica');   // an orphan can only exist if the FK did not stop it
      await c.query('INSERT INTO message_fts(message_id, subject, body, addrs) VALUES ($1,$2,$3,$4)', [gone, 's', 'b', 'a']);
      await c.query("INSERT INTO ai_decisions(user_id, email_id, tier, output, created_at) VALUES ($1,$2,'t','o',$3)", [A, gone, now()]);
      await c.query('INSERT INTO attachment_text(user_id, message_id, part_id, created_at) VALUES ($1,$2,$3,$4)', [A, gone, 'p', now()]);
    } finally { await c.query('SET session_replication_role = DEFAULT').catch(() => {}); c.release(); }
    void tryIns;
    const live = await count('message_fts', `message_id = ${rowId}`);
    const log = await run1('orphan_rows');
    expect(log.rowsRemoved).toBe(3);
    expect(await count('message_fts', `message_id = ${rowId}`)).toBe(live);   // the real message's row is untouched
    expect(await count('message_fts', `message_id = ${gone}`)).toBe(0);
  });

  it('stopped disposable addresses: stopped > 6 months removed, newer kept; quarantine past its days removed', async () => {
    const acct = await makeAccount('d@x.test', { userId: A });
    const addr = (a: string, status: string, stopped: number | null) => run('INSERT INTO disposable_addresses(user_id, account_id, address, status, stopped_at, created_at) VALUES (?,?,?,?,?,?)', [A, acct, a, status, stopped, ago(400)]);
    await addr('old@d.test', 'stopped', ago(184)); await addr('new@d.test', 'stopped', ago(100)); await addr('live@d.test', 'active', null);
    const log = await run1('disposable');
    expect(log.details.addresses).toBe(1);
    expect((await q<any>('SELECT address FROM disposable_addresses ORDER BY address')).map((r) => r.address)).toEqual(['live@d.test', 'new@d.test']);
  });

  it('audit log retention goes through the framework', async () => {
    const c = await pool.connect();
    try {
      await c.query("INSERT INTO audit_log(actor_kind, action, created_at) VALUES ('user','old',$1),('user','new',$2)", [ago(731), ago(5)]);
    } finally { c.release(); }
    expect((await run1('audit')).rowsRemoved).toBe(1);
    expect(await count('audit_log', "action = 'new'")).toBeGreaterThan(0);
    expect(await count('audit_log', "action = 'old'")).toBe(0);
  });
});

async function seedMail(subject = 'hi', to = `m${Math.random().toString(36).slice(2, 6)}@x.test`) {
  const acct = await makeAccount(to, { userId: A });
  const mb = await makeMailbox(acct, 'INBOX', 'inbox');
  return (await ingest(acct, mb, rawEmail({ subject, from: 'x@y.test', to }))) as any;
}

describe('framework rules', () => {
  it('batches deletes (more than 5,000 rows in one task) and removes them all', async () => {
    await run(`INSERT INTO events(user_id, type, created_at) SELECT ?, 't', ? FROM generate_series(1, 5600)`, [A, ago(100)]);
    const log = await run1('events');
    expect(log.status).toBe('ok'); expect(log.rowsRemoved).toBe(5600);
    expect(await count('events')).toBe(0);
  });

  it('a dry run (Preview) changes nothing, reports the numbers and logs dry_run', async () => {
    await run('INSERT INTO events(user_id, type, created_at) VALUES (?,?,?),(?,?,?)', [A, 't', ago(100), A, 't', ago(1)]);
    const log = await run1('events', { dryRun: true });
    expect(log.dryRun).toBe(true); expect(log.rowsRemoved).toBe(1); expect(log.bytesFreed).toBeGreaterThan(0);
    expect(await count('events')).toBe(2);
    expect((await E.queryLog({ dryRun: true })).items).toHaveLength(1);
    expect(await count('maintenance_log', 'dry_run = false')).toBe(0);
  });

  it('the advisory lock stops two tasks running at once; the second is logged as skipped', async () => {
    const c = await pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(7310003)');
      const log = await run1('events');
      expect(log.status).toBe('skipped'); expect(log.error).toMatch(/another maintenance task/);
      expect(log.rowsRemoved).toBe(0);
    } finally { await c.query('SELECT pg_advisory_unlock(7310003)'); c.release(); }
    expect((await run1('events')).status).toBe('ok');
  });

  it('is skipped while a backup runs (previews still work), and while an archive runs', async () => {
    const done = markBusy('backup');
    try {
      expect((await run1('events')).status).toBe('skipped');
      expect((await run1('events', { dryRun: true })).status).toBe('ok');
    } finally { done(); }
    expect((await run1('events')).status).toBe('ok');
    await run("INSERT INTO mail_archives(user_id, name, older_than_days, scope, mode, status, options, cutoff, created_at) VALUES (?,?,?,?,?,?,?::jsonb,?,?)", [A, 'a', 30, 'all', 'copy', 'running', '{}', now(), now()]).catch(async () => {
      await run("INSERT INTO mail_archives(user_id, name, older_than_days, status, created_at) VALUES (?,?,?,?,?)", [A, 'a', 30, 'running', now()]);
    });
    expect((await run1('events')).status).toBe('skipped');
  });

  it('log rows: auto, manual, failed, with who ran it; two failures in a row raise an admin alert, a success clears it', async () => {
    await E.runTask('events', { trigger: 'auto' });
    await run1('events');
    let rows = (await E.queryLog({})).items;
    expect(rows.map((r) => r.trigger).sort()).toEqual(['auto', 'manual']);
    expect(rows.find((r) => r.trigger === 'manual')!.userName).toBe('admin');
    expect(rows.find((r) => r.trigger === 'auto')!.userId).toBeNull();

    const orig = mailStore.listInfo;
    (mailStore as any).listInfo = async () => { throw new Error('bucket down'); };
    try {
      const f1 = await run1('orphan_files', { opts: {} });          // a real (manual) run fails: failure 1
      expect(f1.status).toBe('failed');
      const dry = await E.runTask('orphan_files', { trigger: 'auto' });   // auto without auto-delete = report only (dry run): not counted
      expect(dry.dryRun).toBe(true); expect(dry.status).toBe('failed');
      expect(await count('alerts', "kind = 'maintenance.failed'")).toBe(0);
      await E.updateTaskSettings('orphan_files', { autoDelete: true });
      const f2 = await E.runTask('orphan_files', { trigger: 'auto' });
      expect(f2.status).toBe('failed'); expect(f2.error).toMatch(/bucket down/);
      expect(await count('alerts', "kind = 'maintenance.failed' AND state = 'open' AND user_id = " + ADMIN)).toBe(1);
      expect(await count('alerts', "kind = 'maintenance.failed' AND user_id = " + A)).toBe(0);
    } finally { (mailStore as any).listInfo = orig; }
    expect((await E.runTask('orphan_files', { trigger: 'auto' })).status).toBe('ok');
    expect(await count('alerts', "kind = 'maintenance.failed' AND state = 'open'")).toBe(0);
    rows = (await E.queryLog({ status: 'failed' })).items;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(E.logCsv(rows).split('\n')[0]).toContain('rows_removed');
  });
});

describe('scheduling', () => {
  it('boot seeds settings and one pending job per automatic task; the old audit.prune job is retired', async () => {
    await run("INSERT INTO jobs(kind, run_at, payload, created_at) VALUES ('audit.prune', ?, '{}'::jsonb, ?)", [now() + DAY, now()]);
    await E.ensureMaintenanceJobs();
    await E.ensureMaintenanceJobs();                                   // twice: no duplicates
    const auto = T.TASKS.filter((t) => !t.manualOnly);
    expect(await count('jobs', "kind = 'maintenance.run' AND status = 'pending'")).toBe(auto.length);
    expect(await count('jobs', "kind = 'audit.prune' AND status = 'pending'")).toBe(0);
    expect(await count('maintenance_settings')).toBe(T.TASKS.length);
    const s = await E.getTaskSettings('sessions');
    expect(s!.intervalHours).toBe(6);
    expect((await E.getTaskSettings('vacuum_full'))!.enabled).toBe(false);
  });

  it('the job runs the task, logs it as auto and queues the next run one interval later; disabled tasks end the chain', async () => {
    await E.ensureMaintenanceJobs();
    await run("UPDATE jobs SET run_at = ? WHERE kind = 'maintenance.run' AND payload->>'task' = 'events'", [now() - 1000]);
    await runDueJobs();
    const log = (await E.queryLog({ task: 'events' })).items[0];
    expect(log.trigger).toBe('auto');
    const next = await E.nextRunAt('events');
    expect(next).toBeGreaterThan(now() + 167 * 3_600_000);
    await E.updateTaskSettings('events', { enabled: false });
    expect(await E.nextRunAt('events')).toBeNull();
  });

  it('changing the interval reschedules the waiting job', async () => {
    await E.ensureMaintenanceJobs();
    await E.updateTaskSettings('bounces', { intervalHours: 1000 });
    expect(await count('jobs', "kind = 'maintenance.run' AND status = 'pending' AND payload->>'task' = 'bounces'")).toBe(1);
    expect(await count('jobs', "kind = 'maintenance.run' AND status = 'cancelled' AND payload->>'task' = 'bounces'")).toBe(1);
    await expect(E.updateTaskSettings('bounces', { intervalHours: 0 })).rejects.toThrow();
    await expect(E.updateTaskSettings('sessions', { retentionDays: 5 })).rejects.toThrow(/no retention/);
    await expect(E.updateTaskSettings('events', { autoDelete: true })).rejects.toThrow();
  });

  it('a custom retention is used by the task', async () => {
    await run('INSERT INTO events(user_id, type, created_at) VALUES (?,?,?)', [A, 't', ago(20)]);
    await E.updateTaskSettings('events', { retentionDays: 10 });
    expect((await run1('events')).rowsRemoved).toBe(1);
  });
});

describe('orphan files', () => {
  const uploads = path.join(config.dataDir, 'uploads');
  afterEach(() => { for (const f of ['orphan-old', 'orphan-new']) fs.rmSync(path.join(uploads, f), { force: true }); });

  it('lists only unreferenced, old objects in the app prefixes; never recent or referenced (shared) ones', async () => {
    const acct = await makeAccount('o@x.test', { userId: A });
    const put = (k: string, age: number) => { blobStore.set(k, Buffer.from('x'.repeat(10))); blobAges.set(k, ago(age)); };
    put('msg/1/orphan-old.eml', 10);                 // orphan
    put('msg/1/orphan-new.eml', 2);                  // too recent
    put('msg/1/used.eml', 30);                       // referenced by a message
    put('quarantine/1/held.eml', 30);                // referenced by quarantine
    put('outbound/1/queued.eml', 30);                // referenced by a queued append
    put('seamless/blobs/msg/1/mirror.eml', 30);      // backup mirror: other prefix, never listed
    put('backups/x/db.ndjson.gz', 30);
    const mb = await makeMailbox(acct, 'INBOX', 'inbox');
    const { rowId } = (await ingest(acct, mb, rawEmail({ subject: 's', from: 'a@b.test', to: 'o@x.test' }))) as any;
    await run('UPDATE messages SET s3_key = ? WHERE id = ?', ['msg/1/used.eml', rowId]);
    await run('INSERT INTO quarantined_mail(user_id, unknown_id, s3_key, received_at) VALUES (?,?,?,?)', [A, 1, 'quarantine/1/held.eml', now()]).catch(() => {});
    await run('INSERT INTO op_queue(account_id, op, payload, created_at) VALUES (?,?,?,?)', [acct, 'append', JSON.stringify({ s3Key: 'outbound/1/queued.eml' }), now()]);
    const { items } = await T.findOrphans(now(), 7);
    const keys = items.map((i) => i.key).filter((k) => !k.startsWith('msg/' + acct + '/') || true);
    expect(keys).toContain('msg/1/orphan-old.eml');
    expect(keys).not.toContain('msg/1/orphan-new.eml');
    expect(keys).not.toContain('msg/1/used.eml');
    expect(keys).not.toContain('outbound/1/queued.eml');
    expect(keys.some((k) => k.includes('mirror') || k.startsWith('backups'))).toBe(false);
  });

  it('a preview deletes nothing; the weekly auto run only reports; deleting needs the explicit run and spares what is in use', async () => {
    blobStore.set('msg/9/a.eml', Buffer.from('aaaa')); blobAges.set('msg/9/a.eml', ago(10));
    blobStore.set('msg/9/b.eml', Buffer.from('bbbb')); blobAges.set('msg/9/b.eml', ago(10));
    const prev = await run1('orphan_files', { dryRun: true });
    expect(prev.rowsRemoved).toBe(2); expect(prev.details.items).toHaveLength(2); expect(blobStore.size).toBe(2);
    const auto = await E.runTask('orphan_files', { trigger: 'auto' });
    expect(auto.dryRun).toBe(true); expect(blobStore.size).toBe(2);       // report only unless "delete automatically" is ticked
    // only the keys asked for, and re-checked: b.eml gets referenced between the listing and the delete
    const { rowId } = await seedMail('s2', 'o2@x.test');
    await run('UPDATE messages SET s3_key = ? WHERE id = ?', ['msg/9/b.eml', rowId]);
    const del = await run1('orphan_files', { opts: { keys: ['msg/9/a.eml', 'msg/9/b.eml'] } });
    expect(del.rowsRemoved).toBe(1); expect(del.bytesFreed).toBe(4);
    expect(blobStore.has('msg/9/a.eml')).toBe(false); expect(blobStore.has('msg/9/b.eml')).toBe(true);
  });

  it('with "delete automatically" ticked the weekly run deletes; upload files older than 7 days are found too', async () => {
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, 'orphan-old'), 'zz'); fs.utimesSync(path.join(uploads, 'orphan-old'), new Date(ago(9)), new Date(ago(9)));
    fs.writeFileSync(path.join(uploads, 'orphan-new'), 'zz');
    blobStore.set('msg/9/c.eml', Buffer.from('cc')); blobAges.set('msg/9/c.eml', ago(9));
    await E.updateTaskSettings('orphan_files', { autoDelete: true });
    const log = await E.runTask('orphan_files', { trigger: 'auto' });
    expect(log.dryRun).toBe(false); expect(log.rowsRemoved).toBe(2);
    expect(blobStore.has('msg/9/c.eml')).toBe(false);
    expect(fs.existsSync(path.join(uploads, 'orphan-old'))).toBe(false);
    expect(fs.existsSync(path.join(uploads, 'orphan-new'))).toBe(true);
  });
});

describe('vacuum, analyze, reindex', () => {
  it('picks tables over 20 % dead rows (and big deletes); index bloat estimate', () => {
    const t = (name: string, rows: number, dead: number) => ({ name, sizeBytes: 1, rows, dead, deadPct: Math.round(dead / (rows + dead) * 1000) / 10 });
    expect(T.pickVacuumTables([t('a', 100, 10), t('b', 100, 100), t('c', 1000, 20), t('d', 5, 5)], {})).toEqual(['b']);
    expect(T.pickVacuumTables([t('a', 100, 1)], { a: 20_000 })).toEqual(['a']);
    expect(T.indexBloatPct(20_000_000, 100_000, 8)).toBeGreaterThan(80);
    expect(T.indexBloatPct(2_000_000, 100_000, 8)).toBeLessThan(40);
    expect(T.indexBloatPct(0, 0, 0)).toBe(0);
  });

  it('analyze and vacuum run for real; reindex and VACUUM FULL previews report', async () => {
    expect((await run1('analyze')).status).toBe('ok');
    const v = await run1('vacuum', { opts: { tables: ['events', 'nope; DROP TABLE users'] } });
    expect(v.status).toBe('ok'); expect(v.details.vacuumed).toEqual(['events']);
    expect((await run1('reindex', { dryRun: true })).status).toBe('ok');
    expect((await run1('vacuum_full', { dryRun: true })).status).toBe('ok');
    const full = await run1('vacuum_full', { opts: { tables: ['bounces'] } });
    expect(full.status).toBe('ok'); expect(full.details.rewritten).toEqual(['bounces']);
    expect((await E.runTask('vacuum_full', { trigger: 'auto' })).status).toBe('skipped');   // never by itself
  });

  it('rebuilds a bloated index (forced by a tiny size threshold)', async () => {
    await run(`INSERT INTO events(user_id, type, created_at) SELECT ?, 't', ? FROM generate_series(1, 3000)`, [A, now()]);
    await run('DELETE FROM events');
    const r = await run1('reindex', { opts: { minBytes: 1 } });
    expect(r.status).toBe('ok');
  });
});

describe('admin API', () => {
  it('is admin only: members get 403 on every route', async () => {
    for (const [m, u] of [['GET', '/api/maintenance'], ['PUT', '/api/maintenance/tasks/events'], ['POST', '/api/maintenance/tasks/events/preview'],
      ['POST', '/api/maintenance/tasks/events/run'], ['POST', '/api/maintenance/run-safe'], ['GET', '/api/maintenance/log'], ['GET', '/api/maintenance/log.csv']] as const) {
      const r = await api(ckA, m, u, {});
      expect(r.statusCode, `${m} ${u}`).toBe(403);
    }
    expect(await count('maintenance_log')).toBe(0);
  });

  it('overview, settings, preview, run, run-all, log filters + CSV, audit entries', async () => {
    await run('INSERT INTO events(user_id, type, created_at) VALUES (?,?,?)', [A, 't', ago(100)]);
    const o = (await api(ckAdmin, 'GET', '/api/maintenance')).json();
    expect(o.database.sizeBytes).toBeGreaterThan(0);
    expect(o.database.tables.length).toBeLessThanOrEqual(10);
    expect(o.tasks.map((t: any) => t.id)).toContain('orphan_files');
    expect(o.tasks.find((t: any) => t.id === 'vacuum_full').manualOnly).toBe(true);

    const bad = await api(ckAdmin, 'PUT', '/api/maintenance/tasks/events', { intervalHours: -4 });
    expect(bad.statusCode).toBe(400);
    const ok = await api(ckAdmin, 'PUT', '/api/maintenance/tasks/events', { retentionDays: 30, intervalHours: 48 });
    expect(ok.statusCode).toBe(200); expect(ok.json().settings.retentionDays).toBe(30);
    expect((await api(ckAdmin, 'PUT', '/api/maintenance/tasks/nope', {})).statusCode).toBe(404);

    const prev = await api(ckAdmin, 'POST', '/api/maintenance/tasks/events/preview', {});
    expect(prev.json().dryRun).toBe(true); expect(prev.json().rowsRemoved).toBe(1);
    expect(await count('events')).toBe(1);
    const r = await api(ckAdmin, 'POST', '/api/maintenance/tasks/events/run', {});
    expect(r.json().rowsRemoved).toBe(1); expect(r.json().trigger).toBe('manual');

    expect((await api(ckAdmin, 'POST', '/api/maintenance/tasks/vacuum_full/run', {})).statusCode).toBe(400);
    expect((await api(ckAdmin, 'POST', '/api/maintenance/tasks/orphan_files/run', {})).statusCode).toBe(400);
    expect((await api(ckAdmin, 'POST', '/api/maintenance/tasks/vacuum_full/run', { confirm: true, tables: ['bounces'] })).json().status).toBe('ok');

    const all = (await api(ckAdmin, 'POST', '/api/maintenance/run-safe', {})).json();
    expect(all.results.length).toBe(T.TASKS.filter((t) => t.safe).length);
    expect(all.results.every((l: any) => l.status === 'ok')).toBe(true);
    expect(all.results.map((l: any) => l.task)).not.toContain('orphan_files');

    const log = (await api(ckAdmin, 'GET', '/api/maintenance/log?task=events&trigger=manual&status=ok')).json();
    expect(log.items.length).toBeGreaterThanOrEqual(2); expect(log.items.every((l: any) => l.task === 'events')).toBe(true);
    const csv = await api(ckAdmin, 'GET', '/api/maintenance/log.csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/); expect(csv.body.split('\n')[0]).toContain('task');
    const acts = (await q<any>("SELECT action FROM audit_log WHERE action LIKE 'maintenance.%'")).map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(['maintenance.settings', 'maintenance.run', 'maintenance.run_all', 'maintenance.log_export']));
  });
});
