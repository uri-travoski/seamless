import { describe, it, expect } from 'vitest';
import { sendgridFromConfig } from '../src/transport/outbound/sendgrid.ts';
import { brevoFromConfig } from '../src/transport/outbound/brevo.ts';
import { postmarkFromConfig } from '../src/transport/outbound/postmark.ts';
import { mailgunFromConfig } from '../src/transport/outbound/mailgun.ts';
import { sesFromConfig } from '../src/transport/outbound/ses.ts';
import { TransportError } from '../src/transport/types.ts';
import { buildTransport, knownKinds } from '../src/transport/registry.ts';

const RAW = Buffer.from([
  'From: Alice <alice@demo.test>', 'To: Bob <bob@x.test>', 'Cc: carol@x.test', 'Subject: Hello there',
  'Message-ID: <abc123@demo.test>', 'In-Reply-To: <prev@x.test>', 'References: <root@x.test> <prev@x.test>',
  'X-Seamless-Track: tok42', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '',
  '--B', 'Content-Type: text/html; charset=utf-8', '', '<p>Hi</p>',
  '--B', 'Content-Type: text/plain; name="a.txt"', 'Content-Disposition: attachment; filename="a.txt"',
  'Content-Transfer-Encoding: base64', '', Buffer.from('file-bytes').toString('base64'), '--B--', '',
].join('\r\n'));
const ENV = { from: 'alice@demo.test', to: ['bob@x.test', 'carol@x.test', 'secret@x.test'] };

function fake(status = 200, body: any = {}, headers: Record<string, string> = {}) {
  const calls: { url: string; init: any }[] = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { calls, impl };
}

describe('F-22 API adapters', () => {
  it('registers all providers', () => {
    for (const k of ['sendgrid', 'brevo', 'ses', 'mailgun', 'postmark']) expect(knownKinds()).toContain(k);
    expect(buildTransport('brevo', { apiKey: 'k' }).kind).toBe('brevo');
  });

  it('SendGrid: URL, bearer, converted JSON keeps threading headers, base64 attachment, bcc', async () => {
    const f = fake(202, '', { 'x-message-id': 'sg1' });
    const r = await sendgridFromConfig({ apiKey: 'SG.key' }, f.impl).send(RAW, ENV);
    expect(r.providerMessageId).toBe('sg1');
    const { url, init } = f.calls[0];
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer SG.key');
    const b = JSON.parse(init.body);
    expect(b.from).toEqual({ email: 'alice@demo.test', name: 'Alice' });
    expect(b.personalizations[0].to[0].email).toBe('bob@x.test');
    expect(b.personalizations[0].bcc).toEqual([{ email: 'secret@x.test' }]);
    expect(b.headers['Message-ID']).toBe('<abc123@demo.test>');
    expect(b.headers['In-Reply-To']).toBe('<prev@x.test>');
    expect(b.headers['References']).toBe('<root@x.test> <prev@x.test>');
    expect(b.headers['X-Seamless-Track']).toBe('tok42');
    expect(b.attachments[0].content).toBe(Buffer.from('file-bytes').toString('base64'));
    expect(b.content.find((c: any) => c.type === 'text/html').value).toContain('<p>Hi</p>');
  });

  it('Brevo: api-key header, conversion, headers and attachments', async () => {
    const f = fake(201, { messageId: '<br1>' });
    const r = await brevoFromConfig({ apiKey: 'xkey' }, f.impl).send(RAW, ENV);
    expect(r.providerMessageId).toBe('<br1>');
    const { url, init } = f.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.headers['api-key']).toBe('xkey');
    const b = JSON.parse(init.body);
    expect(b.sender.email).toBe('alice@demo.test');
    expect(b.to[0].email).toBe('bob@x.test');
    expect(b.cc[0].email).toBe('carol@x.test');
    expect(b.bcc[0].email).toBe('secret@x.test');
    expect(b.htmlContent).toContain('Hi');
    expect(b.headers['Message-ID']).toBe('<abc123@demo.test>');
    expect(b.headers['In-Reply-To']).toBe('<prev@x.test>');
    expect(b.headers['References']).toContain('<root@x.test>');
    expect(b.attachment[0]).toEqual({ name: 'a.txt', content: Buffer.from('file-bytes').toString('base64') });
  });

  it('Postmark: token header, JSON conversion, message stream', async () => {
    const f = fake(200, { MessageID: 'pm1' });
    const r = await postmarkFromConfig({ serverToken: 'tok', messageStream: 'broadcast' }, f.impl).send(RAW, ENV);
    expect(r.providerMessageId).toBe('pm1');
    const { url, init } = f.calls[0];
    expect(url).toBe('https://api.postmarkapp.com/email');
    expect(init.headers['X-Postmark-Server-Token']).toBe('tok');
    const b = JSON.parse(init.body);
    expect(b.MessageStream).toBe('broadcast');
    expect(b.Bcc).toBe('secret@x.test');
    const h = Object.fromEntries(b.Headers.map((x: any) => [x.Name, x.Value]));
    expect(h['Message-ID']).toBe('<abc123@demo.test>');
    expect(h['In-Reply-To']).toBe('<prev@x.test>');
    expect(h['References']).toContain('<prev@x.test>');
    expect(b.Attachments[0].Content).toBe(Buffer.from('file-bytes').toString('base64'));
  });

  it('Mailgun: basic auth, EU base, sends the exact bytes as multipart', async () => {
    const f = fake(200, { id: '<mg1>' });
    const r = await mailgunFromConfig({ apiKey: 'mk', domain: 'mg.demo.test', region: 'eu' }, f.impl).send(RAW, ENV);
    expect(r.providerMessageId).toBe('<mg1>');
    const { url, init } = f.calls[0];
    expect(url).toBe('https://api.eu.mailgun.net/v3/mg.demo.test/messages.mime');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('api:mk').toString('base64'));
    const form = init.body as FormData;
    expect(form.getAll('to')).toEqual(ENV.to);
    const msg = form.get('message') as Blob;
    expect(Buffer.from(await msg.arrayBuffer()).equals(RAW)).toBe(true);
    const us = fake(200, {});
    await mailgunFromConfig({ apiKey: 'mk', domain: 'd.test' }, us.impl).send(RAW, ENV);
    expect(us.calls[0].url).toBe('https://api.mailgun.net/v3/d.test/messages.mime');
  });

  it('SES: raw bytes, destination, configuration set; test uses GetAccount', async () => {
    const sent: any[] = [];
    const client = { send: async (cmd: any) => { sent.push(cmd); return { MessageId: 'ses1' }; } };
    const t = sesFromConfig({ region: 'ap-southeast-2', configurationSet: 'cs1' }, client);
    const r = await t.send(RAW, ENV);
    expect(r.providerMessageId).toBe('ses1');
    const input = sent[0].input;
    expect(Buffer.from(input.Content.Raw.Data).equals(RAW)).toBe(true);
    expect(input.Destination.ToAddresses).toEqual(ENV.to);
    expect(input.ConfigurationSetName).toBe('cs1');
    expect(input.FromEmailAddress).toBe('alice@demo.test');
    const res = await t.test();
    expect(res.ok).toBe(true);
    expect(sent[1].constructor.name).toBe('GetAccountCommand');
  });

  it('429 and 5xx and network errors are retryable; 400 is not', async () => {
    const makers: [string, (impl: typeof fetch) => any][] = [
      ['sendgrid', (i) => sendgridFromConfig({ apiKey: 'k' }, i)],
      ['brevo', (i) => brevoFromConfig({ apiKey: 'k' }, i)],
      ['postmark', (i) => postmarkFromConfig({ serverToken: 'k' }, i)],
      ['mailgun', (i) => mailgunFromConfig({ apiKey: 'k', domain: 'd.test' }, i)],
    ];
    for (const [, make] of makers) {
      for (const status of [429, 503]) {
        const e = await make(fake(status, { message: 'slow down' }).impl).send(RAW, ENV).catch((x: any) => x);
        expect(e).toBeInstanceOf(TransportError);
        expect(e.retryable).toBe(true);
      }
      const bad = await make(fake(400, { errors: [{ message: 'bad from address' }] }).impl).send(RAW, ENV).catch((x: any) => x);
      expect(bad.retryable).toBe(false);
      expect(bad.status).toBe(400);
      const down = await make((async () => { throw new Error('ECONNRESET'); }) as any).send(RAW, ENV).catch((x: any) => x);
      expect(down.retryable).toBe(true);
    }
    const msg = await sendgridFromConfig({ apiKey: 'k' }, fake(400, { errors: [{ message: 'bad from address' }] }).impl).send(RAW, ENV).catch((x) => x);
    expect(msg.message).toContain('bad from address');
  });

  it('SES errors map: throttling retryable, validation not', async () => {
    const mk = (name: string, status: number) => sesFromConfig({ region: 'r' }, { send: async () => { throw Object.assign(new Error('x'), { name, $metadata: { httpStatusCode: status } }); } });
    expect((await mk('ThrottlingException', 400).send(RAW, ENV).catch((e) => e)).retryable).toBe(true);
    expect((await mk('InternalFailure', 500).send(RAW, ENV).catch((e) => e)).retryable).toBe(true);
    expect((await mk('MessageRejected', 400).send(RAW, ENV).catch((e) => e)).retryable).toBe(false);
  });

  it('test() calls the authenticated no-send endpoint', async () => {
    const urls: string[] = [];
    const impl = (async (u: any) => { urls.push(String(u)); return new Response('{}', { status: 200 }); }) as typeof fetch;
    expect((await sendgridFromConfig({ apiKey: 'k' }, impl).test()).ok).toBe(true);
    expect((await brevoFromConfig({ apiKey: 'k' }, impl).test()).ok).toBe(true);
    expect((await mailgunFromConfig({ apiKey: 'k', domain: 'd.test' }, impl).test()).ok).toBe(true);
    expect((await postmarkFromConfig({ serverToken: 'k' }, impl).test()).ok).toBe(true);
    expect(urls).toEqual([
      'https://api.sendgrid.com/v3/scopes', 'https://api.brevo.com/v3/account',
      'https://api.mailgun.net/v3/domains/d.test', 'https://api.postmarkapp.com/server',
    ]);
    const bad = await sendgridFromConfig({ apiKey: 'k' }, fake(401, { errors: [{ message: 'invalid key' }] }).impl).test();
    expect(bad.ok).toBe(false);
    expect(bad.steps[0].detail).toContain('invalid key');
  });

  it('required fields are validated', () => {
    expect(() => sendgridFromConfig({})).toThrow();
    expect(() => mailgunFromConfig({ apiKey: 'k' })).toThrow();
    expect(() => postmarkFromConfig({})).toThrow();
    expect(() => sesFromConfig({ region: 'r' })).toThrow();
  });
});
