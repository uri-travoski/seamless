import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { authenticator } from 'otplib';
import { resetDb, TEST_USER, makeUser } from './helpers.ts';
import { makeApp, resetLimiters, login } from './app.ts';
import { run, one, q } from '../src/db.ts';
import { cookieOptions, sessionUser, createSession, IDLE_MS, ABSOLUTE_MS } from '../src/auth/sessions.ts';
import { cspDirectives } from '../src/security/headers.ts';
import { startTotp, confirmTotp, verifyTotp, useRecoveryCode } from '../src/auth/mfa.ts';
import { decrypt } from '../src/crypto.ts';

const app = await makeApp();
afterAll(() => app.close());

beforeEach(async () => { await resetDb(); resetLimiters(); });

describe('F-01 cookies + headers', () => {
  it('session cookie is Secure and __Host- prefixed on https, plain on http', () => {
    expect(cookieOptions(true)).toMatchObject({ name: '__Host-smsession', secure: true, httpOnly: true, path: '/' });
    expect(cookieOptions(false)).toMatchObject({ name: 'smsession', secure: false, httpOnly: true });
  });

  it('serves a CSP and the other security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(String(res.headers['permissions-policy'])).toContain('camera=()');
  });

  it('CSP keeps the reading pane working: inline styles allowed, scripts not', () => {
    const d = cspDirectives(false);
    expect(d.styleSrc).toContain("'unsafe-inline'");
    expect(d.scriptSrc).not.toContain("'unsafe-inline'");
    expect(d.imgSrc).toEqual(expect.arrayContaining(['data:', 'https:']));
    expect(cspDirectives(true).imgSrc).not.toContain('http:');
  });

  it('tracking pixel is embeddable cross-origin', async () => {
    const res = await app.inject({ method: 'GET', url: `/t/${'b'.repeat(32)}.gif` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('OAuth callback escapes the error param and allows only its own nonce script', async () => {
    const cookie = await login(app);
    const res = await app.inject({ method: 'GET', url: '/api/oauth/google/callback?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E', headers: { cookie } });
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;img');
    const nonce = String(res.headers['content-security-policy']).match(/nonce-([a-f0-9]+)/)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.body).toContain(`<script nonce="${nonce}">`);
  });
});

describe('F-01 rate limits', () => {
  it('11th failed login within 15 minutes returns 429', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'test@local', password: 'nope' } });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    // even the right password is refused while blocked
    const ok = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'test@local', password: 'password123' } });
    expect(ok.statusCode).toBe(429);
  });

  it('per-email limit holds across different IPs', async () => {
    for (let i = 0; i < 10; i++) {
      await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'test@local', password: 'x' }, remoteAddress: `10.0.0.${i + 1}` });
    }
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'test@local', password: 'x' }, remoteAddress: '10.0.1.1' });
    expect(res.statusCode).toBe(429);
  });

  it('pixel: only 30 hits per minute recorded, same-IP repeats deduped from notifications', async () => {
    const token = 'c'.repeat(32);
    for (let i = 0; i < 31; i++) {
      await app.inject({ method: 'GET', url: `/t/${token}.gif`, remoteAddress: '1.2.3.4' });
    }
    const n = await one<{ c: number }>('SELECT COUNT(*) AS c FROM tracking_opens WHERE token = ?', [token]);
    expect(n?.c).toBe(30);
  });
});

describe('F-01 sessions', () => {
  it('an idle-expired session is refused and removed', async () => {
    const token = await createSession(TEST_USER, {}, Date.now() - IDLE_MS - 1000);
    expect(await sessionUser(token)).toBeNull();
    expect(await one('SELECT 1 FROM sessions WHERE token = ?', [token])).toBeUndefined();
  });

  it('the absolute cap applies even when active', async () => {
    const created = Date.now() - ABSOLUTE_MS - 1;
    const token = await createSession(TEST_USER, {}, created);
    await run('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token = ?', [Date.now() + IDLE_MS, Date.now(), token]);
    expect(await sessionUser(token)).toBeNull();
  });

  it('expired session returns 401 over HTTP', async () => {
    const token = await createSession(TEST_USER, {}, Date.now() - IDLE_MS - 5000);
    const res = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: `smsession=${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('a revoked session is refused immediately; sign out everywhere keeps the current one', async () => {
    const a = await login(app);
    const b = await login(app);
    const list = (await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: a } })).json() as any[];
    expect(list).toHaveLength(2);
    expect(list.every((s) => !('token' in s))).toBe(true);
    const other = list.find((s) => !s.current)!;
    expect((await app.inject({ method: 'DELETE', url: `/api/sessions/${other.id}`, headers: { cookie: a } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: b } })).statusCode).toBe(401);

    const c = await login(app);
    await app.inject({ method: 'POST', url: '/api/sessions/revoke-others', headers: { cookie: a } });
    expect((await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: c } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: a } })).statusCode).toBe(200);
  });

  it('user B cannot list or revoke user A sessions', async () => {
    await makeUser('b@local');
    const a = await login(app);
    const bCookie = await login(app, 'b@local');
    const aList = (await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: a } })).json() as any[];
    const bList = (await app.inject({ method: 'GET', url: '/api/sessions', headers: { cookie: bCookie } })).json() as any[];
    expect(bList.map((s) => s.id)).not.toContain(aList[0].id);
    const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${aList[0].id}`, headers: { cookie: bCookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe('F-02 two-factor', () => {
  const codeAt = async (userId: number, at: number) => {
    const row = await one<{ secret_enc: string }>('SELECT secret_enc FROM user_mfa WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    return authenticator.clone({ epoch: at }).generate(decrypt(row!.secret_enc));
  };

  it('enrol → login needs a code; wrong fails, right passes, replay fails', async () => {
    const cookie = await login(app);
    const start = (await app.inject({ method: 'POST', url: '/api/security/totp/start', headers: { cookie } })).json();
    expect(start.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(start.qr).toMatch(/^data:image\/png;base64,/);
    const confirm = await app.inject({ method: 'POST', url: '/api/security/totp/confirm', headers: { cookie }, payload: { code: await codeAt(TEST_USER, Date.now()) } });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().recoveryCodes).toHaveLength(10);

    const step1 = (await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'test@local', password: 'password123' } })).json();
    expect(step1.mfaRequired).toBe(true);
    expect(step1.mfaToken).toBeTruthy();

    const wrong = await app.inject({ method: 'POST', url: '/api/login/mfa', payload: { mfaToken: step1.mfaToken, code: '000000' } });
    expect(wrong.statusCode).toBe(401);

    // next time step so it isn't a replay of the enrolment code
    const code = await codeAt(TEST_USER, Date.now() + 30_000);
    await run('UPDATE user_mfa SET last_step = ? WHERE user_id = ?', [Math.floor(Date.now() / 30_000), TEST_USER]);
    const ok = await app.inject({ method: 'POST', url: '/api/login/mfa', payload: { mfaToken: step1.mfaToken, code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.cookies.find((c) => c.name === 'smsession')).toBeTruthy();

    // same code again (same step) is a replay
    const step2 = (await app.inject({ method: 'POST', url: '/api/login', payload: { email: 'test@local', password: 'password123' } })).json();
    const replay = await app.inject({ method: 'POST', url: '/api/login/mfa', payload: { mfaToken: step2.mfaToken, code } });
    expect(replay.statusCode).toBe(401);
  });

  it('verifyTotp rejects a replay within the same window', async () => {
    await startTotp(TEST_USER, 'test@local');
    const now = Date.now();
    const c1 = await codeAt(TEST_USER, now);
    expect(await confirmTotp(TEST_USER, c1)).toHaveLength(10);
    const c2 = await codeAt(TEST_USER, now + 30_000);
    expect(await verifyTotp(TEST_USER, c2, { now: now + 30_000 })).toBe(true);
    expect(await verifyTotp(TEST_USER, c2, { now: now + 30_000 })).toBe(false);
  });

  it('a recovery code works once only', async () => {
    await startTotp(TEST_USER, 'test@local');
    const codes = (await confirmTotp(TEST_USER, await codeAt(TEST_USER, Date.now())))!;
    expect(await useRecoveryCode(TEST_USER, codes[3])).toBe(true);
    expect(await useRecoveryCode(TEST_USER, codes[3])).toBe(false);
    expect(await useRecoveryCode(TEST_USER, codes[3].toUpperCase().replace('-', ' '))).toBe(false);
    expect(await useRecoveryCode(TEST_USER, codes[4].toUpperCase())).toBe(true);
    const left = await q('SELECT 1 FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL', [TEST_USER]);
    expect(left).toHaveLength(8);
  });

  it('admin can require 2FA: a user without it is told to enrol', async () => {
    const cookie = await login(app);
    expect((await app.inject({ method: 'PUT', url: '/api/security/policy', headers: { cookie }, payload: { mfaRequired: true } })).statusCode).toBe(200);
    const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    expect(me.mfaEnrollRequired).toBe(true);
    await run("DELETE FROM settings WHERE key = 'mfa_required'");
  });

  it('members cannot change the 2FA policy', async () => {
    await makeUser('m@local');
    const cookie = await login(app, 'm@local');
    expect((await app.inject({ method: 'PUT', url: '/api/security/policy', headers: { cookie }, payload: { mfaRequired: true } })).statusCode).toBe(403);
  });
});
