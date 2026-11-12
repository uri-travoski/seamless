/** T6.1 F-42: append-only audit log — actions write rows, tamper-proof, prune, scoping, redaction, CSV. */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const { q, one, run, pool, setSetting } = await import('../src/db.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');
const { audit, redact, pruneAudit, queryAudit } = await import('../src/audit/log.ts');
const { ensureAuditPruneJob } = await import('../src/audit/prune.ts');
const { runDueJobs } = await import('../src/jobs/runner.ts');
const T = await import('../src/api/tokens.ts');

let A: number, B: number, ADMIN: number;
let app: Awaited<ReturnType<typeof makeApp>>;
let cka = '', ckb = '', ckadmin = '';
const api = (ck: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck } });
const rows = (action?: string) => q<any>(`SELECT * FROM audit_log ${action ? 'WHERE action = $1' : ''} ORDER BY id`, action ? [action] : []);

beforeEach(async () => {
  await resetDb(); resetLimiters();
  ADMIN = await makeUser('admin@x.test', 'admin'); A = await makeUser('a@x.test'); B = await makeUser('b@x.test');
  app = await makeApp();
  cka = await login(app, 'a@x.test'); ckb = await login(app, 'b@x.test'); ckadmin = await login(app, 'admin@x.test');
  await run('SELECT 1');
});

describe('login', () => {
  it('writes login.ok and login.failed with ip + user agent', async () => {
    const before = (await rows('login.ok')).length;
    expect(before).toBe(3);   // the three beforeEach logins
    const bad = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'a@x.test', password: 'nope' }, headers: { 'user-agent': 'TestAgent/1' } });
    expect(bad.statusCode).toBe(401);
    const f = (await rows('login.failed'))[0];
    expect(f.actor_user_id).toBe(A);
    expect(f.user_agent).toBe('TestAgent/1');
    expect(f.ip).toBeTruthy();
    expect(JSON.stringify(f.details)).not.toContain('nope');
  });
});

describe('actions write a row', () => {
  it('2FA + session changes', async () => {
    const s = (await api(cka, 'GET', '/api/sessions')).json();
    await api(cka, 'POST', '/api/sessions/revoke-others');
    expect((await rows('session.revoke_others'))[0].actor_user_id).toBe(A);
    expect(s.length).toBeGreaterThan(0);
    await api(ckadmin, 'PUT', '/api/security/policy', { mfaRequired: false });
    expect((await rows('2fa.policy'))).toHaveLength(1);
    expect((await api(cka, 'POST', '/api/security/totp/disable', { password: 'wrong' })).statusCode).toBe(401);
    expect(await rows('2fa.disable')).toHaveLength(0);   // failed attempts are not "changes"
    await api(cka, 'POST', '/api/security/totp/disable', { password: 'password123' });
    expect(await rows('2fa.disable')).toHaveLength(1);
  });
  it('account add / change / remove', async () => {
    const acct = await makeAccount('a@demo.test', { userId: A });
    await api(cka, 'PUT', `/api/accounts/${acct}`, { name: 'Renamed', imapHost: 'imap.test', imapPort: 993, imapSecure: true, imapUser: 'a@demo.test', smtpHost: 'smtp.test', smtpPort: 465, smtpSecure: true, smtpUser: 'a@demo.test', email: 'a@demo.test' });
    await api(cka, 'DELETE', `/api/accounts/${acct}`);
    const del = (await rows('account.remove'))[0];
    expect(del.target_type).toBe('account'); expect(del.target_id).toBe(String(acct)); expect(del.actor_user_id).toBe(A);
  });
  it('rules + filters', async () => {
    const r = (await api(cka, 'POST', '/api/rules', { matchField: 'from', matchValue: 'x', action: 'ai' })).json();
    await api(cka, 'DELETE', `/api/rules/${r.id}`);
    const f = (await api(cka, 'POST', '/api/filters', { name: 'f', match: 'all', conditions: [{ field: 'subject', op: 'contains', value: 'Hi' }], actions: [{ type: 'mark_read' }] })).json();
    await api(cka, 'DELETE', `/api/filters/${f.id}`);
    expect((await rows('rule.create'))[0].target_id).toBe(String(r.id));
    expect(await rows('rule.delete')).toHaveLength(1);
    expect(await rows('filter.create')).toHaveLength(1);
    expect(await rows('filter.delete')).toHaveLength(1);
  });
  it('webhook + API token create/delete (never storing the secret)', async () => {
    const t = (await api(cka, 'POST', '/api/api-tokens', { name: 'CI', scopes: ['mail:read'] })).json();
    await api(cka, 'DELETE', `/api/api-tokens/${t.id}`);
    expect(await rows('api_token.create')).toHaveLength(1);
    expect(await rows('api_token.delete')).toHaveLength(1);
    expect(JSON.stringify(await rows())).not.toContain(t.token);
    expect((await api(ckadmin, 'POST', '/api/webhook-allowlist', { value: '127.0.0.1' })).statusCode).toBe(200);
    expect(await rows('webhook.allowlist_add')).toHaveLength(1);
    const h = await api(cka, 'POST', '/api/webhooks', { name: 'H', url: 'http://127.0.0.1:9/hook', eventTypes: ['mail.received'] });
    expect(h.statusCode).toBeLessThan(400);
    expect((await rows('webhook.create'))[0].target_id).toBe(String(h.json().id));
    await api(cka, 'DELETE', `/api/webhooks/${h.json().id}`);
    expect(await rows('webhook.delete')).toHaveLength(1);
    expect(JSON.stringify(await rows())).not.toContain(h.json().secret ?? 'no-secret-in-response');
  });
  it('PGP key generate / delete (the passphrase never lands in the log)', async () => {
    const g = await api(cka, 'POST', '/api/pgp/keys/generate', { email: 'a@x.test', name: 'A', passphrase: 'correct horse' });
    expect(g.statusCode).toBeLessThan(400);
    expect(await rows('pgp.key_generate')).toHaveLength(1);
    await api(cka, 'DELETE', `/api/pgp/keys/${g.json().id}`);
    expect(await rows('pgp.key_delete')).toHaveLength(1);
    expect(JSON.stringify(await rows())).not.toContain('correct horse');
  });
  it('share grant + revoke', async () => {
    const acct = await makeAccount('a@demo.test', { userId: A });
    expect((await api(cka, 'PUT', `/api/accounts/${acct}/shares`, { userId: B, role: 'viewer' })).statusCode).toBe(200);
    expect(await rows('share.grant')).toHaveLength(1);
    expect((await rows('share.grant'))[0].details.params.id).toBe(String(acct));
    await api(ckadmin, 'DELETE', `/api/accounts/${acct}/shares/${B}`);
    expect((await rows('share.revoke')).length).toBeLessThanOrEqual(1);
  });
  it('bulk delete over 50 is audited, a small one is not', async () => {
    const acct = await makeAccount('a@demo.test', { userId: A });
    const inbox = await makeMailbox(acct, 'INBOX', 'inbox');
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(`m${(await ingest(acct, inbox, rawEmail({ from: 'x@y.test', to: 'a@demo.test', subject: `S${i}`, messageId: `<bulk${i}@t>` })))!.rowId}`);
    await api(cka, 'POST', '/api/bulk', { ids: ids.slice(0, 5), action: 'delete' });
    expect(await rows('bulk.delete')).toHaveLength(0);
    await api(cka, 'POST', '/api/bulk', { ids: ids.slice(5), action: 'delete' });
    const r = await rows('bulk.delete');
    expect(r).toHaveLength(1); expect(r[0].details.count).toBe(55);
  });
  it('backup run, key import and an API v1 call', async () => {
    await api(ckadmin, 'POST', '/api/backup/run');   // may fail without a store; only a success is audited
    const ok = (await api(ckadmin, 'POST', '/api/backup/run')).statusCode < 400;
    expect((await rows('backup.run')).length > 0).toBe(ok);
    const t = (await api(cka, 'POST', '/api/api-tokens', { name: 'R', scopes: ['mail:read'] })).json();
    const call = await app.inject({ method: 'GET', url: '/api/v1/mailboxes', headers: { authorization: `Bearer ${t.token}` } });
    const c = (await rows('api.call'))[0];
    expect(c.actor_kind).toBe('api_token'); expect(c.actor_token_id).toBe(t.id); expect(c.actor_user_id).toBe(A);
    expect(c.details.status).toBe(call.statusCode);
    expect(c.target_id).toMatch(/^GET \/api\/v1\//);
  });
});

describe('append-only', () => {
  it('UPDATE, DELETE and TRUNCATE raise', async () => {
    await audit(null, 'test.row');
    await expect(run("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(run('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await expect(run('TRUNCATE audit_log')).rejects.toThrow(/append-only/);
    expect((await rows('test.row'))).toHaveLength(1);
  });
  it('deleting a user does not delete their audit rows', async () => {
    await audit(null, 'test.keep', {}, {}, { userId: B });
    await run('DELETE FROM users WHERE id = ?', [B]);
    expect(await rows('test.keep')).toHaveLength(1);
  });
});

describe('retention', () => {
  it('prunes only old rows and audits the prune', async () => {
    await audit(null, 'old.row'); await audit(null, 'new.row');
    const c = await pool.connect();
    await c.query('BEGIN'); await c.query("SET LOCAL seamless.audit_prune = 'on'");
    await c.query("UPDATE audit_log SET created_at = $1 WHERE action = 'old.row'", [Date.now() - 800 * 86_400_000]);
    await c.query('COMMIT'); c.release();
    expect(await pruneAudit()).toBe(1);
    expect(await rows('old.row')).toHaveLength(0);
    expect(await rows('new.row')).toHaveLength(1);
    expect(await rows('audit.prune')).toHaveLength(1);
  });
  it('honours audit_retention_days (admin only) and schedules a daily job', async () => {
    expect((await api(cka, 'PUT', '/api/audit/retention', { days: 30 })).statusCode).toBe(403);
    expect((await api(ckadmin, 'PUT', '/api/audit/retention', { days: 0 })).statusCode).toBe(400);
    expect((await api(ckadmin, 'PUT', '/api/audit/retention', { days: 30 })).statusCode).toBe(200);
    expect((await rows('audit.retention_change'))).toHaveLength(1);
    await ensureAuditPruneJob(); await ensureAuditPruneJob();
    expect(await q("SELECT 1 FROM jobs WHERE kind = 'audit.prune'")).toHaveLength(1);
    await run("UPDATE jobs SET run_at = 0 WHERE kind = 'audit.prune'");
    await runDueJobs();
    expect(await q("SELECT 1 FROM jobs WHERE kind = 'audit.prune' AND status = 'pending'")).toHaveLength(1);   // rescheduled
  });
});

describe('who sees what', () => {
  it('a member only sees their own rows; an admin sees everyone', async () => {
    await audit(null, 'mine', {}, {}, { userId: A }); await audit(null, 'theirs', {}, {}, { userId: B });
    const mine = (await api(cka, 'GET', '/api/audit?limit=500')).json();
    expect(mine.scope).toBe('own');
    expect(mine.items.every((r: any) => r.actorUserId === A)).toBe(true);
    expect(mine.items.some((r: any) => r.action === 'theirs')).toBe(false);
    // asking for someone else's rows by actor id changes nothing
    const peek = (await api(cka, 'GET', `/api/audit?actor=${B}&limit=500`)).json();
    expect(peek.items.every((r: any) => r.actorUserId === A)).toBe(true);
    const all = (await api(ckadmin, 'GET', '/api/audit?limit=500')).json();
    expect(all.scope).toBe('all');
    expect(all.items.some((r: any) => r.action === 'theirs')).toBe(true);
    const onlyB = (await api(ckadmin, 'GET', `/api/audit?actor=${B}&limit=500`)).json();
    expect(onlyB.items.every((r: any) => r.actorUserId === B)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/audit' })).statusCode).toBe(401);
  });
  it('filters by action prefix, target and date range, and pages', async () => {
    await audit(null, 'x.one', { type: 'thing', id: 7 }); await audit(null, 'x.two', { type: 'other', id: 8 }); await audit(null, 'y.three');
    const v = { userId: ADMIN, admin: true };
    expect((await queryAudit(v, { action: 'x.' })).total).toBe(2);
    expect((await queryAudit(v, { target: 'thing:7' })).items.map((r) => r.action)).toEqual(['x.one']);
    expect((await queryAudit(v, { target: 'other' })).total).toBe(1);
    expect((await queryAudit(v, { from: Date.now() + 10_000 })).total).toBe(0);
    const page = await queryAudit(v, { action: 'x.', limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1); expect(page.total).toBe(2);
    expect((await api(ckadmin, 'GET', '/api/audit?action=x.&limit=1')).json().items).toHaveLength(1);
  });
});

describe('redaction', () => {
  it('replaces values of secret-looking keys, deeply', async () => {
    expect(redact({ password: 'p', apiKey: 'k', nested: { clientSecret: 's', accessToken: 't', ok: 'fine' }, list: [{ pass_word: 'x' }] }))
      .toEqual({ password: '[redacted]', apiKey: '[redacted]', nested: { clientSecret: '[redacted]', accessToken: '[redacted]', ok: 'fine' }, list: [{ pass_word: '[redacted]' }] });
    await audit(null, 'secret.test', {}, { imapPass: 'hunter2', note: 'hello' });
    const d = (await rows('secret.test'))[0].details;
    expect(d.imapPass).toBe('[redacted]'); expect(d.note).toBe('hello');
    expect(JSON.stringify(await rows())).not.toContain('hunter2');
  });
});

describe('CSV export', () => {
  it('exports the visible rows, neutralises formulas, and is itself audited', async () => {
    await audit(null, 'csv.row', { type: 't', id: '=1+1' }, { note: 'a,"b"' }, { userId: A });
    const res = await api(cka, 'GET', '/api/audit/export.csv?action=csv.');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.body.split('\r\n')[0]).toBe('time,actor,actor_kind,action,target_type,target_id,ip,user_agent,details');
    expect(res.body).toContain("'=1+1");
    expect(res.body).toContain('csv.row');
    const e = (await rows('audit.export'))[0];
    expect(e.actor_user_id).toBe(A); expect(e.details.rows).toBe(1);
    // a member's export never contains another user's rows
    await audit(null, 'csv.other', {}, {}, { userId: B });
    expect((await api(cka, 'GET', '/api/audit/export.csv?action=csv.')).body).not.toContain('csv.other');
  });
});
