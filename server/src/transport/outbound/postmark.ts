import type { OutboundTransport } from '../types.ts';
import { toNeutral, call, simpleTest, need, type FetchImpl } from './common.ts';

export function postmarkFromConfig(cfg: Record<string, any>, fetchImpl: FetchImpl = fetch): OutboundTransport {
  need(cfg, 'serverToken');
  const base = (cfg.baseUrl || 'https://api.postmarkapp.com').replace(/\/$/, '');
  const auth = { 'X-Postmark-Server-Token': String(cfg.serverToken), Accept: 'application/json' };
  const line = (l: { email: string; name?: string }[]) => l.map((a) => (a.name ? `"${a.name.replace(/"/g, '')}" <${a.email}>` : a.email)).join(', ');
  return {
    kind: 'postmark',
    async send(raw, env) {
      const m = await toNeutral(raw, env);
      const body: any = {
        From: line([m.from]), To: line(m.to), Subject: m.subject,
        Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })),
        MessageStream: cfg.messageStream || 'outbound',
      };
      if (m.cc.length) body.Cc = line(m.cc);
      if (m.bcc.length) body.Bcc = line(m.bcc);
      if (m.html) body.HtmlBody = m.html;
      if (m.text || !m.html) body.TextBody = m.text ?? ' ';
      if (m.replyTo) body.ReplyTo = line([m.replyTo]);
      if (m.attachments.length) body.Attachments = m.attachments.map((a) => ({
        Name: a.filename, Content: a.base64, ContentType: a.contentType, ...(a.cid ? { ContentID: `cid:${a.cid}` } : {}),
      }));
      const res = await call('Postmark', fetchImpl, `${base}/email`, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j: any = await res.json().catch(() => ({}));
      return { providerMessageId: j?.MessageID };
    },
    test: () => simpleTest('Server token accepted', () => call('Postmark', fetchImpl, `${base}/server`, { headers: auth })),
  };
}
