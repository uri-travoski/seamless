import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, rawEmail } from './helpers.ts';
import worker, { routeFor, sign as wSign, deliver, handleEmail, type Env, type InboundMessage } from '../../workers/inbound/src/index.ts';

const { one, q } = await import('../src/db.ts');
const { makeApp, login, resetLimiters } = await import('./app.ts');

const env = (over: Partial<Env> = {}): Env => ({
  SEAMLESS_URL: 'https://mail.example.com', ROUTES: JSON.stringify({ 'push.test': 'TOK1', 'vip@other.test': 'TOK2' }),
  SECRETS: JSON.stringify({ TOK1: 's1', TOK2: 's2' }), FALLBACK_ADDRESS: 'me@gmail.test', ...over,
});
const msg = (to: string, raw: Buffer, forwards: string[] = [], rejects: string[] = []): InboundMessage => ({
  from: 'a@x.test', to, raw: new Uint8Array(raw), rawSize: raw.length,
  forward: async (a) => { forwards.push(a); }, setReject: (r) => { rejects.push(r); },
});
const noSleep = async () => {};

describe('worker routing + signing', () => {
  it('routes catch-all by domain, exact address wins, unknown → null', () => {
    const r = JSON.stringify({ 'push.test': 'D', 'vip@push.test': 'V' });
    expect(routeFor('anyone@push.test', r)).toBe('D');
    expect(routeFor('VIP@push.test', r)).toBe('V');
    expect(routeFor('x@nope.test', r)).toBeNull();
    expect(routeFor('x@push.test', 'not json')).toBeNull();
  });

  it('retries 3× on 5xx then forwards to the fallback', async () => {
    const calls: number[] = []; const forwards: string[] = [];
    const ok = await deliver(env(), 'TOK1', 'a@push.test', new Uint8Array([1]), { fetchImpl: async () => { calls.push(1); return { status: 503 }; }, sleep: noSleep });
    expect(ok).toBe(false); expect(calls).toHaveLength(4);
    calls.length = 0;
    await handleEmail(msg('a@push.test', rawEmail({ from: 'a@x.test', to: 'a@push.test', subject: 's' }), forwards), env(), undefined,
      { fetchImpl: async () => { calls.push(1); return { status: 500 }; }, sleep: noSleep });
    expect(forwards).toEqual(['me@gmail.test']);
  });

  it('uses 1s/4s/16s backoff, recovers on a later 2xx, does not retry 4xx', async () => {
    const slept: number[] = []; let n = 0;
    const ok = await deliver(env(), 'TOK1', 'a@push.test', new Uint8Array([1]),
      { fetchImpl: async () => ({ status: ++n < 3 ? 502 : 202 }), sleep: async (ms) => { slept.push(ms); } });
    expect(ok).toBe(true); expect(slept).toEqual([1000, 4000]);
    n = 0;
    expect(await deliver(env(), 'TOK1', 'a@push.test', new Uint8Array([1]), { fetchImpl: async () => { n++; return { status: 401 }; }, sleep: noSleep })).toBe(false);
    expect(n).toBe(1);
    n = 0;
    expect(await deliver(env(), 'TOK1', 'a@push.test', new Uint8Array([1]), { fetchImpl: async () => { n++; throw new Error('down'); }, sleep: noSleep })).toBe(false);
    expect(n).toBe(4);
  });

  it('rejects unknown recipients and oversize messages; spools to R2 first', async () => {
    const rejects: string[] = []; const spooled: string[] = [];
    await handleEmail(msg('x@nope.test', Buffer.from('x'), [], rejects), env());
    await handleEmail(msg('a@push.test', Buffer.alloc(50), [], rejects), env({ MAX_BYTES: '10' }));
    expect(rejects).toEqual(['Unknown recipient', 'Message too large']);
    await handleEmail(msg('a@push.test', Buffer.from('hello')), env({ SPOOL: { put: async (k) => { spooled.push(k); } } }), undefined,
      { fetchImpl: async () => ({ status: 202 }), sleep: noSleep });
    expect(spooled).toHaveLength(1);
  });

  it('default export email() handler exists', () => { expect(typeof worker.email).toBe('function'); });
});

describe('worker → real Seamless endpoint', () => {
  beforeEach(async () => { await resetDb(); resetLimiters(); });

  it('a message signed by the worker is accepted by the server and lands in the Inbox', async () => {
    const app = await makeApp(); const cookie = await login(app);
    const created = (await app.inject({ method: 'POST', url: '/api/push-inboxes', headers: { cookie }, payload: { name: 'P', domains: ['push.test'] } })).json();
    const e = env({ ROUTES: JSON.stringify({ 'push.test': created.token }), SECRETS: JSON.stringify({ [created.token]: created.secret }) });
    const raw = rawEmail({ from: 'a@x.test', to: 'sales@push.test', subject: 'via worker' });
    const forwards: string[] = [];
    await handleEmail(msg('sales@push.test', raw, forwards), e, undefined, {
      sleep: noSleep,
      fetchImpl: async (url, init) => {
        const r = await app.inject({ method: 'POST', url: new URL(url).pathname, payload: Buffer.from(init.body), headers: init.headers });
        return { status: r.statusCode };
      },
    });
    expect(forwards).toEqual([]);
    const row = await one<any>('SELECT subject, delivered_to FROM messages');
    expect(row).toMatchObject({ subject: 'via worker', delivered_to: 'sales@push.test' });
    expect(await q('SELECT 1 FROM messages')).toHaveLength(1);
    // the worker's signature function matches the server's
    const { sign } = await import('../src/transport/inbound/push.ts');
    expect(await wSign('k', '123', new Uint8Array([1, 2, 3]))).toBe(sign('k', '123', Buffer.from([1, 2, 3])));
  });
});
