import type { OutboundTransport } from '../types.ts';
import { toNeutral, call, simpleTest, need, type FetchImpl } from './common.ts';

export function sendgridFromConfig(cfg: Record<string, any>, fetchImpl: FetchImpl = fetch): OutboundTransport {
  need(cfg, 'apiKey');
  const base = (cfg.baseUrl || 'https://api.sendgrid.com').replace(/\/$/, '');
  const auth = { Authorization: `Bearer ${cfg.apiKey}` };
  const pick = (a: { email: string; name?: string }) => (a.name ? { email: a.email, name: a.name } : { email: a.email });
  return {
    kind: 'sendgrid',
    async send(raw, env) {
      const m = await toNeutral(raw, env);
      const body: any = {
        personalizations: [{ to: m.to.map(pick), ...(m.cc.length ? { cc: m.cc.map(pick) } : {}), ...(m.bcc.length ? { bcc: m.bcc.map(pick) } : {}) }],
        from: pick(m.from), subject: m.subject || '(no subject)',
        content: [
          ...(m.text ? [{ type: 'text/plain', value: m.text }] : []),
          ...(m.html ? [{ type: 'text/html', value: m.html }] : []),
        ],
        headers: m.headers,
      };
      if (!body.content.length) body.content = [{ type: 'text/plain', value: ' ' }];
      if (m.replyTo) body.reply_to = pick(m.replyTo);
      if (m.attachments.length) body.attachments = m.attachments.map((a) => ({
        content: a.base64, filename: a.filename, type: a.contentType,
        disposition: a.inline ? 'inline' : 'attachment', ...(a.cid ? { content_id: a.cid } : {}),
      }));
      const res = await call('SendGrid', fetchImpl, `${base}/v3/mail/send`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { providerMessageId: res.headers.get('x-message-id') ?? undefined };
    },
    test: () => simpleTest('API key accepted', () => call('SendGrid', fetchImpl, `${base}/v3/scopes`, { headers: auth })),
  };
}
