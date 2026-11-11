import type { OutboundTransport } from '../types.ts';
import { toNeutral, call, simpleTest, need, type FetchImpl } from './common.ts';

export function brevoFromConfig(cfg: Record<string, any>, fetchImpl: FetchImpl = fetch): OutboundTransport {
  need(cfg, 'apiKey');
  const base = (cfg.baseUrl || 'https://api.brevo.com').replace(/\/$/, '');
  const auth = { 'api-key': String(cfg.apiKey), accept: 'application/json' };
  const pick = (a: { email: string; name?: string }) => (a.name ? { email: a.email, name: a.name } : { email: a.email });
  return {
    kind: 'brevo',
    async send(raw, env) {
      const m = await toNeutral(raw, env);
      const body: any = {
        sender: pick(m.from), to: m.to.length ? m.to.map(pick) : m.bcc.slice(0, 1).map(pick),
        subject: m.subject || '(no subject)', headers: m.headers,
      };
      if (m.cc.length) body.cc = m.cc.map(pick);
      if (m.bcc.length && m.to.length) body.bcc = m.bcc.map(pick);
      if (m.html) body.htmlContent = m.html;
      if (m.text) body.textContent = m.text;
      if (!m.html && !m.text) body.textContent = ' ';
      if (m.replyTo) body.replyTo = pick(m.replyTo);
      if (m.attachments.length) body.attachment = m.attachments.map((a) => ({ name: a.filename, content: a.base64 }));
      const res = await call('Brevo', fetchImpl, `${base}/v3/smtp/email`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j: any = await res.json().catch(() => ({}));
      return { providerMessageId: j?.messageId };
    },
    test: () => simpleTest('API key accepted', () => call('Brevo', fetchImpl, `${base}/v3/account`, { headers: auth })),
  };
}
