import type { OutboundTransport } from '../types.ts';
import { call, simpleTest, need, type FetchImpl } from './common.ts';

export function mailgunFromConfig(cfg: Record<string, any>, fetchImpl: FetchImpl = fetch): OutboundTransport {
  need(cfg, 'apiKey', 'domain');
  const base = (cfg.baseUrl || (cfg.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net')).replace(/\/$/, '');
  const domain = encodeURIComponent(String(cfg.domain));
  const auth = { Authorization: 'Basic ' + Buffer.from(`api:${cfg.apiKey}`).toString('base64') };
  return {
    kind: 'mailgun',
    async send(raw, env) {
      const form = new FormData();
      for (const to of env.to) form.append('to', to);
      form.append('message', new Blob([new Uint8Array(raw)], { type: 'message/rfc822' }), 'message.mime');
      const res = await call('Mailgun', fetchImpl, `${base}/v3/${domain}/messages.mime`, { method: 'POST', headers: auth, body: form });
      const j: any = await res.json().catch(() => ({}));
      return { providerMessageId: j?.id };
    },
    test: () => simpleTest('API key and domain accepted', () => call('Mailgun', fetchImpl, `${base}/v3/domains/${domain}`, { headers: auth })),
  };
}
