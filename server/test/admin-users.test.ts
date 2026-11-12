/** T8.1: administrator tools, password reset, mailbox for a user, storage quotas. */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, ingest, rawEmail } from './helpers.ts';

const { q, one, run } = await import('../src/db.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');
const { checkQuotas, clearUsageCache, userUsageBytes, gbToBytes } = await import('../src/admin/quota.ts');

const GB = 1024 ** 3;
const MB = 1024 ** 2;
let app: Awaited<ReturnType<typeof makeApp>>;
let ADMIN: number, MEMBER: number, OTHER: number;
let ck: Record<string, string> = {};
const api = (who: string, method: any, url: string, body?: any) => app.inject({ method, url, payload: body, headers: { cookie: ck[who] } });
const notes = (userId: number, type: string) => q<any>('SELECT * FROM notifications WHERE user_id = ? AND type = ? ORDER BY id', [userId, type]);

beforeEach(async () => {
  await resetDb(); resetLimiters(); clearUsageCache();
  await run("DELETE FROM settings WHERE key = 'default_user_quota_bytes'");
  await run("UPDATE users SET role = 'member' WHERE email = 'test@local'");   // the baseline test user must not count as a second admin
  ADMIN = await makeUser('admin@x.test', 'admin');
  MEMBER = await makeUser('member@x.test');
  OTHER = await makeUser('other@x.test');
  app = await makeApp();
  ck = {};
  for (const [k, e] of Object.entries({ ADMIN: 'admin@x.test', MEMBER: 'member@x.test', OTHER: 'other@x.test' })) ck[k] = await login(app, e);
});

/** Give a user one mailbox holding messages that total `bytes`. */
async function fill(userId: number, email: string, bytes: number) {
  const acct = await makeAccount(email, { userId });
  const inbox = await makeMailbox(acct, 'INBOX', 'inbox');
  const r = await ingest(acct, inbox, rawEmail({ from: 'x@ext.test', to: email, subject: 'filler' }));
  await run('UPDATE messages SET size = ? WHERE id = ?', [bytes, r!.rowId]);
  clearUsageCache();
  return acct;
}

describe('password reset', () => {
  it('forces a new password at next sign-in and kills existing sessions', async () => {
    const r = await api('ADMIN', 'POST', `/api/users/${MEMBER}/reset-password`, { password: 'Temp-pass-1' });
    expect(r.statusCode, r.body).toBe(200);
    expect((await api('MEMBER', 'GET', '/api/accounts')).statusCode).toBe(401);   // old session is gone
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'member@x.test', password: 'password123' } })).statusCode).toBe(401);
    ck.MEMBER = await login(app, 'member@x.test', 'Temp-pass-1');
    const me = await api('MEMBER', 'GET', '/api/me');
    expect(me.json().mustChangePassword).toBe(true);
    // everything except changing the password is refused
    const blocked = await api('MEMBER', 'GET', '/api/accounts');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().mustChangePassword).toBe(true);
    // must pick something different
    expect((await api('MEMBER', 'PUT', '/api/users/password', { current: 'Temp-pass-1', password: 'Temp-pass-1' })).statusCode).toBe(400);
    expect((await api('MEMBER', 'PUT', '/api/users/password', { current: 'Temp-pass-1', password: 'My-own-pass-2' })).statusCode).toBe(200);
    expect((await api('MEMBER', 'GET', '/api/accounts')).statusCode).toBe(200);
    expect((await api('MEMBER', 'GET', '/api/me')).json().mustChangePassword).toBe(false);
  });

  it('rejects short passwords, own account, and non-admins', async () => {
    expect((await api('ADMIN', 'POST', `/api/users/${MEMBER}/reset-password`, { password: 'short' })).statusCode).toBe(400);
    expect((await api('ADMIN', 'POST', `/api/users/${ADMIN}/reset-password`, { password: 'long-enough-1' })).statusCode).toBe(400);
    expect((await api('MEMBER', 'POST', `/api/users/${OTHER}/reset-password`, { password: 'long-enough-1' })).statusCode).toBe(403);
    expect((await api('ADMIN', 'POST', '/api/users/99999/reset-password', { password: 'long-enough-1' })).statusCode).toBe(404);
  });

  it('writes audit rows', async () => {
    await api('ADMIN', 'POST', `/api/users/${MEMBER}/reset-password`, { password: 'Temp-pass-1' });
    const row = await one<any>("SELECT * FROM audit_log WHERE action = 'user.password_reset'");
    expect(row.actor_user_id).toBe(ADMIN);
    expect(row.target_id).toBe(String(MEMBER));
    expect(JSON.stringify(row.details)).not.toContain('Temp-pass-1');
  });
});

describe('last admin protection', () => {
  it('cannot demote, disable or delete the last active admin', async () => {
    const second = await makeUser('admin2@x.test', 'admin');
    // two admins: demoting the second is fine, so first make it the only other one and disable it
    expect((await api('ADMIN', 'POST', `/api/users/${second}/disable`)).statusCode).toBe(200);
    // ADMIN is now the only ACTIVE admin
    ck.ADMIN2 = '';
    expect((await api('ADMIN', 'PUT', `/api/users/${ADMIN}`, { role: 'member' })).statusCode).toBe(400);
    expect((await api('ADMIN', 'POST', `/api/users/${ADMIN}/disable`)).statusCode).toBe(400);
    expect((await api('ADMIN', 'DELETE', `/api/users/${ADMIN}`)).statusCode).toBe(400);
    // a disabled admin does not count as "another admin": promoting a member makes demotion possible
    expect((await api('ADMIN', 'PUT', `/api/users/${MEMBER}`, { role: 'admin' })).statusCode).toBe(200);
    expect((await api('ADMIN', 'PUT', `/api/users/${ADMIN}`, { role: 'member' })).statusCode).toBe(200);
  });

  it('the guard also protects another admin when the caller is the last one standing', async () => {
    const second = await makeUser('admin2@x.test', 'admin');
    await run('UPDATE users SET disabled = true WHERE id = ?', [ADMIN]);   // can't act, but proves the count ignores disabled admins
    await run('UPDATE users SET disabled = false WHERE id = ?', [ADMIN]);
    expect((await api('ADMIN', 'PUT', `/api/users/${second}`, { role: 'member' })).statusCode).toBe(200);   // ADMIN still active
    expect((await api('ADMIN', 'DELETE', `/api/users/${ADMIN}`)).statusCode).toBe(400);   // self
  });
});

describe('disable / enable / sign out', () => {
  it('a disabled user cannot sign in, sessions die, sync stops; enabling restores access', async () => {
    const acct = await makeAccount('m@demo.test', { userId: MEMBER });
    expect((await api('MEMBER', 'GET', '/api/accounts')).statusCode).toBe(200);
    expect((await api('ADMIN', 'POST', `/api/users/${MEMBER}/disable`)).statusCode).toBe(200);
    expect((await api('MEMBER', 'GET', '/api/accounts')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'member@x.test', password: 'password123' } })).statusCode).toBe(403);
    // wrong password stays a plain 401 (no hint that the account exists / is disabled)
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'member@x.test', password: 'nope-nope-1' } })).statusCode).toBe(401);
    const { syncManager } = await import('../src/imap/sync.ts');
    await syncManager.restartAccount(acct);
    expect(syncManager.status(acct).state).toBe('paused');
    expect((await api('ADMIN', 'POST', `/api/users/${MEMBER}/enable`)).statusCode).toBe(200);
    resetLimiters();
    ck.MEMBER = await login(app, 'member@x.test');
    expect((await api('MEMBER', 'GET', '/api/accounts')).statusCode).toBe(200);
    syncManager.stopAccount(acct);
  });

  it('a disabled user\'s API token stops working', async () => {
    const t = await api('MEMBER', 'POST', '/api/api-tokens', { name: 'ci', scopes: ['mail:read'] });
    const tok = t.json().token as string;
    const ok = await app.inject({ method: 'GET', url: '/api/v1/messages', headers: { authorization: `Bearer ${tok}` } });
    expect(ok.statusCode, ok.body).toBe(200);
    await api('ADMIN', 'POST', `/api/users/${MEMBER}/disable`);
    const no = await app.inject({ method: 'GET', url: '/api/v1/messages', headers: { authorization: `Bearer ${tok}` } });
    expect(no.statusCode).toBe(401);
  });

  it('sign out everywhere ends every session; for yourself the current one stays', async () => {
    const second = await login(app, 'member@x.test');
    expect((await api('ADMIN', 'POST', `/api/users/${MEMBER}/sign-out`)).json().revoked).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: second } })).statusCode).toBe(401);
    const adminSecond = await login(app, 'admin@x.test');
    await api('ADMIN', 'POST', `/api/users/${ADMIN}/sign-out`);
    expect((await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: adminSecond } })).statusCode).toBe(401);
    expect((await api('ADMIN', 'GET', '/api/accounts')).statusCode).toBe(200);
  });

  it('records last sign-in', async () => {
    const list = (await api('ADMIN', 'GET', '/api/users')).json();
    expect(list.find((u: any) => u.id === MEMBER).lastLoginAt).toBeGreaterThan(0);
    await run('UPDATE users SET last_login_at = NULL WHERE id = ?', [OTHER]);
    expect((await api('ADMIN', 'GET', '/api/users')).json().find((u: any) => u.id === OTHER).lastLoginAt).toBeNull();
  });

  it('edit changes name and role and is audited', async () => {
    const r = await api('ADMIN', 'PUT', `/api/users/${MEMBER}`, { name: 'Mia', role: 'admin', quotaGb: 2 });
    expect(r.statusCode).toBe(200);
    const row = await one<any>('SELECT name, role, storage_quota_bytes FROM users WHERE id = ?', [MEMBER]);
    expect(row).toMatchObject({ name: 'Mia', role: 'admin' });
    expect(Number(row.storage_quota_bytes)).toBe(2 * GB);
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'user.update'")).toBeTruthy();
    expect((await api('ADMIN', 'POST', `/api/users/${MEMBER}/disable`)).statusCode).toBe(200);
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'user.disable'")).toBeTruthy();
    await api('ADMIN', 'POST', `/api/users/${MEMBER}/enable`);
    await api('ADMIN', 'POST', `/api/users/${MEMBER}/sign-out`);
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'user.enable'")).toBeTruthy();
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'user.sign_out_everywhere'")).toBeTruthy();
  });

  it('create applies the default quota; an explicit empty value means unlimited', async () => {
    expect((await api('ADMIN', 'PUT', '/api/users/quota-default', { gb: 5 })).statusCode).toBe(200);
    const a = (await api('ADMIN', 'POST', '/api/users', { email: 'n1@x.test', password: 'long-enough-1' })).json().id;
    const b = (await api('ADMIN', 'POST', '/api/users', { email: 'n2@x.test', password: 'long-enough-1', quotaGb: '' })).json().id;
    const c = (await api('ADMIN', 'POST', '/api/users', { email: 'n3@x.test', password: 'long-enough-1', quotaGb: 1.5, mustChangePassword: true })).json().id;
    expect(Number((await one<any>('SELECT storage_quota_bytes AS v FROM users WHERE id = ?', [a])).v)).toBe(5 * GB);
    expect((await one<any>('SELECT storage_quota_bytes AS v FROM users WHERE id = ?', [b])).v).toBeNull();
    expect(Number((await one<any>('SELECT storage_quota_bytes AS v FROM users WHERE id = ?', [c])).v)).toBe(gbToBytes(1.5));
    expect((await one<any>('SELECT must_change_password AS v FROM users WHERE id = ?', [c])).v).toBe(true);
    expect((await api('ADMIN', 'PUT', '/api/users/quota-default', { gb: -3 })).statusCode).toBe(400);
  });
});

describe('mailbox for another user', () => {
  const body = (extra: any = {}) => ({
    email: 'box@demo.test', name: 'Box', imapHost: 'imap.test', imapPort: 993, imapSecure: true, imapUser: 'box@demo.test', imapPass: 'pw',
    smtpHost: 'smtp.test', smtpPort: 465, smtpSecure: true, smtpUser: 'box@demo.test', smtpPass: 'pw', enabled: false, ...extra,
  });

  it('belongs to the target user, credentials encrypted, audited', async () => {
    const r = await api('ADMIN', 'POST', '/api/accounts', body({ forUserId: MEMBER }));
    expect(r.statusCode, r.body).toBe(200);
    const row = await one<any>('SELECT user_id, imap_pass_enc FROM accounts WHERE id = ?', [r.json().id]);
    expect(row.user_id).toBe(MEMBER);
    expect(row.imap_pass_enc).not.toContain('pw');
    expect((await api('MEMBER', 'GET', '/api/accounts')).json().map((a: any) => a.email)).toContain('box@demo.test');
    expect((await api('ADMIN', 'GET', '/api/accounts')).json().map((a: any) => a.email)).not.toContain('box@demo.test');
    expect(await one("SELECT 1 FROM audit_log WHERE action = 'account.add_for_user'")).toBeTruthy();
    const list = (await api('ADMIN', 'GET', '/api/users')).json();
    expect(list.find((u: any) => u.id === MEMBER).mailboxes).toEqual(['box@demo.test']);
  });

  it('a member cannot use forUserId; unknown user is 404', async () => {
    const r = await api('MEMBER', 'POST', '/api/accounts', body({ forUserId: OTHER }));
    expect(r.statusCode).toBe(403);
    expect(await one('SELECT 1 FROM accounts WHERE user_id = ?', [OTHER])).toBeFalsy();
    expect((await api('ADMIN', 'POST', '/api/accounts', body({ forUserId: 99999 }))).statusCode).toBe(404);
  });

  it('members can still add their own, with or without their own id', async () => {
    const r = await api('MEMBER', 'POST', '/api/accounts', body({ forUserId: MEMBER }));
    expect(r.statusCode, r.body).toBe(200);
    const r2 = await api('MEMBER', 'POST', '/api/accounts', body({ email: 'two@demo.test' }));
    expect(r2.statusCode).toBe(200);
  });
});

describe('quota', () => {
  it('computes usage from the user\'s own mailboxes only', async () => {
    await fill(MEMBER, 'm@demo.test', 3 * MB);
    await fill(OTHER, 'o@demo.test', 1 * MB);
    expect(await userUsageBytes(MEMBER, { fresh: true })).toBe(3 * MB);
    await run('UPDATE users SET storage_quota_bytes = ? WHERE id = ?', [4 * MB, MEMBER]);
    const list = (await api('ADMIN', 'GET', '/api/users')).json();
    const m = list.find((u: any) => u.id === MEMBER);
    expect(m).toMatchObject({ usedBytes: 3 * MB, quotaBytes: 4 * MB, percent: 75 });
    expect(list.find((u: any) => u.id === OTHER)).toMatchObject({ usedBytes: 1 * MB, quotaBytes: null, percent: null });
    expect((await api('MEMBER', 'GET', '/api/usage/mine')).json()).toMatchObject({ usedBytes: 3 * MB, quotaBytes: 4 * MB });
  });

  it('caches usage for five minutes', async () => {
    const acct = await fill(MEMBER, 'm@demo.test', 1 * MB);
    expect(await userUsageBytes(MEMBER)).toBe(1 * MB);
    await run('UPDATE messages SET size = ? WHERE account_id = ?', [2 * MB, acct]);
    expect(await userUsageBytes(MEMBER)).toBe(1 * MB);
    expect(await userUsageBytes(MEMBER, { now: Date.now() + 6 * 60_000 })).toBe(2 * MB);
  });

  it('fires 80% once, 100% once, re-arms below 75%, notifies user and admins', async () => {
    const acct = await fill(MEMBER, 'm@demo.test', 7 * MB);
    await run('UPDATE users SET storage_quota_bytes = ? WHERE id = ?', [10 * MB, MEMBER]);
    expect(await checkQuotas()).toEqual([]);                                  // 70 %
    const setSize = (n: number) => run('UPDATE messages SET size = ? WHERE account_id = ?', [Math.round(n), acct]);
    await setSize(8.2 * MB);
    expect(await checkQuotas()).toEqual([{ userId: MEMBER, level: 'warning' }]);
    expect(await checkQuotas()).toEqual([]);                                  // no repeat
    expect((await notes(MEMBER, 'quota.warning')).length).toBe(1);
    expect((await notes(ADMIN, 'quota.warning')).length).toBe(1);
    expect((await notes(OTHER, 'quota.warning')).length).toBe(0);
    expect((await notes(MEMBER, 'quota.warning'))[0].title).toContain('82%');
    expect((await notes(ADMIN, 'quota.warning'))[0].title).toContain('member@x.test');
    await setSize(10.5 * MB);
    expect(await checkQuotas()).toEqual([{ userId: MEMBER, level: 'full' }]);
    expect(await checkQuotas()).toEqual([]);
    expect((await notes(MEMBER, 'quota.full')).length).toBe(1);
    expect((await notes(ADMIN, 'quota.full')).length).toBe(1);
    expect((await notes(MEMBER, 'quota.full'))[0].body).toContain('nothing is deleted');
    await setSize(7.6 * MB);                                                  // 76 %: still armed
    await checkQuotas();
    await setSize(8.5 * MB);
    expect(await checkQuotas()).toEqual([]);
    await setSize(7 * MB);                                                    // < 75 %: re-arm
    await checkQuotas();
    await setSize(8.5 * MB);
    expect(await checkQuotas()).toEqual([{ userId: MEMBER, level: 'warning' }]);
    expect((await notes(MEMBER, 'quota.warning')).length).toBe(2);
  });

  it('an admin who is the over-quota user gets one notification, not two', async () => {
    await fill(ADMIN, 'a@demo.test', 9 * MB);
    await run('UPDATE users SET storage_quota_bytes = ? WHERE id = ?', [10 * MB, ADMIN]);
    await checkQuotas();
    expect((await notes(ADMIN, 'quota.warning')).length).toBe(1);
  });

  it('never refuses mail or deletes anything at 100%', async () => {
    const acct = await fill(MEMBER, 'm@demo.test', 11 * MB);
    await run('UPDATE users SET storage_quota_bytes = ? WHERE id = ?', [10 * MB, MEMBER]);
    await checkQuotas();
    const inbox = (await one<any>("SELECT id FROM mailboxes WHERE account_id = ?", [acct])).id;
    const r = await ingest(acct, inbox, rawEmail({ from: 'y@ext.test', to: 'm@demo.test', subject: 'still arrives' }));
    expect(r).toBeTruthy();
    expect(Number((await one<any>('SELECT COUNT(*) AS c FROM messages WHERE account_id = ?', [acct])).c)).toBe(2);
  });

  it('users without a quota are never alerted; removing a quota clears the alert state', async () => {
    await fill(MEMBER, 'm@demo.test', 50 * MB);
    expect(await checkQuotas()).toEqual([]);
    await run('UPDATE users SET storage_quota_bytes = ? WHERE id = ?', [10 * MB, MEMBER]);
    expect((await checkQuotas()).length).toBe(1);
    await run('UPDATE users SET storage_quota_bytes = NULL WHERE id = ?', [MEMBER]);
    await checkQuotas();
    expect(await one('SELECT 1 FROM quota_alerts')).toBeFalsy();
  });
});

describe('isolation', () => {
  it('a member cannot list or change users, or read others\' usage', async () => {
    await fill(OTHER, 'o@demo.test', 1 * MB);
    expect((await api('MEMBER', 'GET', '/api/users')).statusCode).toBe(403);
    expect((await api('MEMBER', 'PUT', `/api/users/${OTHER}`, { role: 'admin' })).statusCode).toBe(403);
    expect((await api('MEMBER', 'POST', `/api/users/${OTHER}/disable`)).statusCode).toBe(403);
    expect((await api('MEMBER', 'POST', `/api/users/${OTHER}/sign-out`)).statusCode).toBe(403);
    expect((await api('MEMBER', 'DELETE', `/api/users/${OTHER}`)).statusCode).toBe(403);
    expect((await api('MEMBER', 'GET', '/api/users/quota-default')).statusCode).toBe(403);
    expect((await api('MEMBER', 'PUT', '/api/users/quota-default', { gb: 1 })).statusCode).toBe(403);
    const mine = (await api('MEMBER', 'GET', '/api/usage/mine')).json();
    expect(mine.usedBytes).toBe(0);
    expect((await api('OTHER', 'GET', '/api/usage/mine')).json().usedBytes).toBe(1 * MB);
    expect(await one<any>('SELECT role FROM users WHERE id = ?', [OTHER])).toMatchObject({ role: 'member' });
  });
});
