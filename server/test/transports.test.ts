import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb, makeUser, makeAccount, makeMailbox, TEST_USER } from './helpers.ts';

const sent: { envelope: any; raw: Buffer }[] = [];
vi.mock('nodemailer', async (orig) => {
  const real = await orig<any>();
  return { default: { ...real.default, createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 'ok' }; }, verify: async () => true }) } };
});

const { sendEmail } = await import('../src/mail/send.ts');
const { q, one, run } = await import('../src/db.ts');
const { registerAdapter } = await import('../src/transport/registry.ts');
const { TransportError } = await import('../src/transport/types.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

function payload(accountId: number) {
  return { accountId, fromEmail: 'alice@demo.test', to: [{ name: '', email: 'bob@x.test' }], cc: [], bcc: [], subject: 'Hello', html: '<p>hi</p>', attachmentIds: [], track: false };
}

let acct: number;
let app: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
const calls: string[] = [];
let primaryError: Error | null = null;

beforeEach(async () => {
  await resetDb(); resetLimiters(); sent.length = 0; calls.length = 0; primaryError = null;
  acct = await makeAccount('alice@demo.test');
  await makeMailbox(acct, 'INBOX', 'inbox');
  app = await makeApp(); cookie = await login(app);
  registerAdapter('fake-primary', () => ({ kind: 'fake-primary', send: async () => { calls.push('primary'); if (primaryError) throw primaryError; return { providerMessageId: 'p1' }; }, test: async () => ({ ok: true, steps: [] }) }));
  registerAdapter('fake-backup', () => ({ kind: 'fake-backup', send: async () => { calls.push('backup'); return {}; }, test: async () => ({ ok: true, steps: [] }) }));
});

const api = (method: any, url: string, body?: any, ck = cookie) => app.inject({ method, url, payload: body, headers: { cookie: ck } });

describe('F-22 transports', () => {
  it('an account with no transport still sends over its own SMTP', async () => {
    await sendEmail(TEST_USER, payload(acct));
    expect(sent).toHaveLength(1);
    expect(sent[0].envelope).toEqual({ from: 'alice@demo.test', to: ['bob@x.test'] });
  });

  it('stores config encrypted and never returns secrets', async () => {
    const r = await api('POST', '/api/transports', { kind: 'smtp', name: 'Brevo', config: { preset: 'brevo', user: 'u', pass: 'SUPERSECRET-KEY' } });
    expect(r.statusCode).toBe(200);
    const row = await one<{ config_enc: string }>('SELECT config_enc FROM transports');
    expect(row!.config_enc).not.toContain('SUPERSECRET');
    const list = await api('GET', '/api/transports');
    expect(list.body).not.toContain('SUPERSECRET');
    const t = list.json()[0];
    expect(t.hasApiKey).toBe(true);
    expect(t.config.pass).toBeUndefined();
    // editing with a blank secret keeps the old one
    await api('PUT', `/api/transports/${t.id}`, { name: 'Brevo 2', config: { preset: 'brevo', user: 'u', pass: '' } });
    const after = await one<{ config_enc: string }>('SELECT config_enc FROM transports');
    const { decrypt } = await import('../src/crypto.ts');
    expect(JSON.parse(decrypt(after!.config_enc)).pass).toBe('SUPERSECRET-KEY');
  });

  it('test endpoint reports steps', async () => {
    const { id } = (await api('POST', '/api/transports', { kind: 'smtp', name: 'S', config: { host: 'smtp.example.test', user: 'u', pass: 'p' } })).json();
    const r = (await api('POST', `/api/transports/${id}/test`)).json();
    expect(r.ok).toBe(true);
    expect(r.steps[0].name).toBeTruthy();
  });

  it('user B cannot read, edit, test, delete or assign user A\'s transport', async () => {
    const { id } = (await api('POST', '/api/transports', { kind: 'smtp', name: 'A', config: { host: 'h.test', user: 'u', pass: 'p' } })).json();
    const b = await makeUser('b@local');
    const { hashPassword } = await import('../src/crypto.ts');
    await run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword('password123'), b]);
    const bAcct = await makeAccount('bob@demo.test', { userId: b });
    const ck = await login(app, 'b@local');
    expect((await api('GET', '/api/transports', undefined, ck)).json()).toEqual([]);
    expect((await api('PUT', `/api/transports/${id}`, { name: 'x', config: {} }, ck)).statusCode).toBe(404);
    expect((await api('POST', `/api/transports/${id}/test`, undefined, ck)).statusCode).toBe(404);
    expect((await api('DELETE', `/api/transports/${id}`, undefined, ck)).statusCode).toBe(404);
    expect((await api('PUT', `/api/accounts/${bAcct}/transport`, { transportId: id }, ck)).statusCode).toBe(400);
    // nor use it as a fallback
    expect((await api('POST', '/api/transports', { kind: 'smtp', name: 'B', config: { host: 'h.test' }, fallbackId: id }, ck)).statusCode).toBe(400);
    // and A cannot assign B's account
    expect((await api('PUT', `/api/accounts/${bAcct}/transport`, { transportId: id })).statusCode).toBe(404);
    expect(await q('SELECT 1 FROM transports')).toHaveLength(1);
  });

  async function setup(kindFallback = true) {
    const bk = (await api('POST', '/api/transports', { kind: 'fake-backup', name: 'Backup', config: {} })).json().id;
    const pr = (await api('POST', '/api/transports', { kind: 'fake-primary', name: 'Primary', config: {}, fallbackId: kindFallback ? bk : null })).json().id;
    expect((await api('PUT', `/api/accounts/${acct}/transport`, { transportId: pr })).statusCode).toBe(200);
  }

  it('uses the assigned transport instead of SMTP', async () => {
    await setup();
    await sendEmail(TEST_USER, payload(acct));
    expect(calls).toEqual(['primary']);
    expect(sent).toHaveLength(0);
  });

  it('retryable error falls back once and raises send.failed with fallbackUsed', async () => {
    await setup();
    primaryError = new TransportError('503 busy', { retryable: true, status: 503 });
    await sendEmail(TEST_USER, payload(acct));
    expect(calls).toEqual(['primary', 'backup']);
    const ev = await one<{ payload: any }>("SELECT payload FROM events WHERE type = 'send.failed'");
    expect(ev!.payload.fallbackUsed).toBe(true);
    expect(ev!.payload.error).toContain('503');
  });

  it('non-retryable error does not fall back', async () => {
    await setup();
    primaryError = new TransportError('400 bad address', { retryable: false, status: 400 });
    await expect(sendEmail(TEST_USER, payload(acct))).rejects.toThrow('400 bad address');
    expect(calls).toEqual(['primary']);
    expect(await q("SELECT 1 FROM events WHERE type = 'send.failed'")).toHaveLength(0);
  });
});
