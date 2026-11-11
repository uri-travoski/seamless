/**
 * Step-by-step mailbox connection tests (T1 F-09): DNS → TCP → TLS → auth → folders
 * (incoming) or → send-to-self (outgoing). Each step reports {step, ok, ms, detail} and
 * the run stops at the first failure, so a wrong password fails clearly at `auth`.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { TestStep } from '@seamless/shared';

const TIMEOUT = 10_000;

export interface ServerSpec {
  host: string;
  port: number;
  secure: boolean;           // implicit TLS (993/465); otherwise plain/STARTTLS
  user: string;
  pass?: string;
  accessToken?: string;      // XOAUTH2 (Gmail / Microsoft mailboxes)
}

async function timed(step: TestStep['step'], fn: () => Promise<string>): Promise<TestStep> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { step, ok: true, ms: Date.now() - t0, detail };
  } catch (err: any) {
    return { step, ok: false, ms: Date.now() - t0, detail: friendly(step, err) };
  }
}

function friendly(step: TestStep['step'], err: any): string {
  const msg = String(err?.responseText ?? err?.response ?? err?.message ?? err);
  if (step === 'dns') return `Can't find that server name (${err?.code ?? msg})`;
  if (step === 'tcp') {
    if (err?.code === 'ECONNREFUSED') return 'Connection refused: wrong port, or the server is down';
    if (err?.code === 'ETIMEDOUT' || /timeout/i.test(msg)) return 'No answer: a firewall may be blocking this port';
    return msg;
  }
  if (step === 'tls') return `Secure connection failed: ${msg}. Try the other security setting for this port.`;
  if (step === 'auth') {
    if (err?.authenticationFailed || /auth|credential|password|login|535|invalid/i.test(msg)) {
      return `Sign-in rejected: check the username and password (or app password). Server said: ${msg}`;
    }
    return msg;
  }
  return msg;
}

function tcpConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, timeout: TIMEOUT });
    sock.once('connect', () => { sock.destroy(); resolve(`${host}:${port} reachable`); });
    sock.once('timeout', () => { sock.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    sock.once('error', (e) => { sock.destroy(); reject(e); });
  });
}

function tlsHandshake(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host, timeout: TIMEOUT, rejectUnauthorized: false });
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      const trusted = sock.authorized ? 'trusted certificate' : `untrusted certificate (${sock.authorizationError})`;
      const cn = (cert?.subject as any)?.CN ?? '';
      sock.destroy();
      resolve(`${sock.getProtocol() ?? 'TLS'}, ${trusted}${cn ? `, CN=${cn}` : ''}`);
    });
    sock.once('timeout', () => { sock.destroy(); reject(new Error('TLS handshake timed out')); });
    sock.once('error', (e) => { sock.destroy(); reject(e); });
  });
}

async function network(spec: ServerSpec, steps: TestStep[]): Promise<boolean> {
  steps.push(await timed('dns', async () => {
    if (net.isIP(spec.host)) return `${spec.host} (IP address)`;
    const r = await dns.lookup(spec.host, { all: true });
    return r.map((a) => a.address).slice(0, 3).join(', ');
  }));
  if (!steps.at(-1)!.ok) return false;
  steps.push(await timed('tcp', () => tcpConnect(spec.host, spec.port)));
  if (!steps.at(-1)!.ok) return false;
  steps.push(await timed('tls', async () => (spec.secure ? tlsHandshake(spec.host, spec.port) : 'Not implicit TLS: STARTTLS is used if the server offers it')));
  return steps.at(-1)!.ok;
}

export async function testIncoming(spec: ServerSpec): Promise<{ ok: boolean; steps: TestStep[] }> {
  const steps: TestStep[] = [];
  if (!(await network(spec, steps))) return { ok: false, steps };
  const client = new ImapFlow({
    host: spec.host, port: spec.port, secure: spec.secure, logger: false,
    auth: spec.accessToken ? { user: spec.user, accessToken: spec.accessToken } : { user: spec.user, pass: spec.pass ?? '' },
    tls: { rejectUnauthorized: false }, connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT,
  } as any);
  steps.push(await timed('auth', async () => { await client.connect(); return `Signed in as ${spec.user}`; }));
  if (steps.at(-1)!.ok) {
    steps.push(await timed('folders', async () => {
      const list = await client.list();
      return `${list.length} folder${list.length === 1 ? '' : 's'}: ${list.slice(0, 6).map((l) => l.path).join(', ')}${list.length > 6 ? ', …' : ''}`;
    }));
  }
  await client.logout().catch(() => {});
  return { ok: steps.every((s) => s.ok), steps };
}

export async function testOutgoing(spec: ServerSpec, opts: { sendTo?: string; from?: string } = {}): Promise<{ ok: boolean; steps: TestStep[] }> {
  const steps: TestStep[] = [];
  if (!(await network(spec, steps))) return { ok: false, steps };
  const transport = nodemailer.createTransport({
    host: spec.host, port: spec.port, secure: spec.secure,
    auth: spec.accessToken ? { type: 'OAuth2', user: spec.user, accessToken: spec.accessToken } as any : { user: spec.user, pass: spec.pass ?? '' },
    tls: { rejectUnauthorized: false }, connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT,
  });
  steps.push(await timed('auth', async () => { await transport.verify(); return `Signed in as ${spec.user}`; }));
  if (steps.at(-1)!.ok && opts.sendTo) {
    steps.push(await timed('send', async () => {
      const info = await transport.sendMail({
        from: opts.from ?? opts.sendTo, to: opts.sendTo,
        subject: 'Seamless test message',
        text: 'This is a test message sent from Settings → Mailboxes. If you can read it, sending works.',
      });
      return `Sent to ${opts.sendTo}${info.messageId ? ` (${info.messageId})` : ''}`;
    }));
  }
  transport.close();
  return { ok: steps.every((s) => s.ok), steps };
}
