/** Own phone as the SMS server: a generic HTTP gateway. URL, optional basic auth or bearer token, method, and a body
 *  template with {{to}} and {{message}} (JSON or form). Presets fill the template for common Android apps.
 *  Presets: not checked against the apps' live docs. */
import { ChannelError, str, phone, phoneList, wrapNet, type ChannelAdapter } from './types.ts';

export const GATEWAY_PRESETS: Record<string, { name: string; method: string; contentType: 'json' | 'form'; bodyTemplate: string; urlHint: string; auth: 'basic' | 'bearer' | 'none'; note: string }> = {
  'android-sms-gateway': {
    name: 'SMS Gateway for Android (local server)', method: 'POST', contentType: 'json', auth: 'basic',
    bodyTemplate: '{"message":"{{message}}","phoneNumbers":["{{to}}"]}',
    urlHint: 'http://192.168.1.50:8080/message',
    note: 'Turn on "Local server" in the app; it shows the address and the username/password.',
  },
  'smsgate-bearer': {
    name: 'POST /message with a bearer token', method: 'POST', contentType: 'json', auth: 'bearer',
    bodyTemplate: '{"to":"{{to}}","message":"{{message}}"}',
    urlHint: 'http://192.168.1.50:9090/message',
    note: 'For gateways that take {"to","message"} JSON and an API token.',
  },
  'form': {
    name: 'Simple form POST', method: 'POST', contentType: 'form', auth: 'none',
    bodyTemplate: 'to={{to}}&message={{message}}',
    urlHint: 'http://192.168.1.50:8080/send',
    note: 'For gateways that take to=… and message=… form fields.',
  },
  custom: { name: 'Custom', method: 'POST', contentType: 'json', auth: 'none', bodyTemplate: '{"to":"{{to}}","message":"{{message}}"}', urlHint: 'http://phone.lan:8080/send', note: 'Write your own body template.' },
};

/** Fill {{to}} / {{message}}; values are escaped for the body type so a quote in the alert can't break the JSON. */
export function renderTemplate(tpl: string, contentType: 'json' | 'form', vars: { to: string; message: string }): string {
  const esc = (v: string) => (contentType === 'json' ? JSON.stringify(v).slice(1, -1) : encodeURIComponent(v));
  return tpl.replace(/\{\{\s*(to|message)\s*\}\}/g, (_m, k: 'to' | 'message') => esc(vars[k]));
}

export const smsGateway: ChannelAdapter = {
  kind: 'sms_gateway',
  label: 'SMS via my phone (gateway)',
  secrets: ['password', 'token'],
  validate(c) {
    let url: URL;
    try { url = new URL(str(c.url)); } catch { throw new ChannelError('Enter the gateway address, like http://192.168.1.50:8080/message'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ChannelError('The gateway address must start with http:// or https://');
    const method = (str(c.method) || 'POST').toUpperCase();
    if (!['POST', 'PUT', 'GET'].includes(method)) throw new ChannelError('Method must be POST, PUT or GET');
    const contentType = c.contentType === 'form' ? 'form' : 'json';
    const bodyTemplate = typeof c.bodyTemplate === 'string' ? c.bodyTemplate : '';
    if (method !== 'GET' && !bodyTemplate.includes('{{message}}')) throw new ChannelError('The body template must contain {{message}}');
    if (method === 'GET' && !(str(c.url).includes('{{message}}'))) throw new ChannelError('For GET, put {{message}} in the address');
    const to = phoneList(c.to);
    if (!to.length) throw new ChannelError('Enter at least one number to send the SMS to');
    const out: Record<string, any> = { url: str(c.url), method, contentType, bodyTemplate, to, preset: str(c.preset), username: str(c.username), password: str(c.password), token: str(c.token) };
    return out;
  },
  describe: (c) => `${new URL(c.url).host} → ${(c.to as string[]).join(', ')}`,
  async send(c, msg, deps) {
    const errors: string[] = [];
    for (const to of c.to as string[]) {
      const vars = { to, message: msg.text };
      const headers: Record<string, string> = {};
      if (c.token) headers.Authorization = `Bearer ${c.token}`;
      else if (c.username) headers.Authorization = `Basic ${Buffer.from(`${c.username}:${c.password ?? ''}`).toString('base64')}`;
      let url = c.url as string;
      let body: string | undefined;
      if (c.method === 'GET') url = renderTemplate(url, 'form', vars);
      else { body = renderTemplate(c.bodyTemplate, c.contentType, vars); headers['Content-Type'] = c.contentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json'; }
      try {
        const r = await deps.http(url, { method: c.method, headers, body });
        if (r.status < 200 || r.status >= 300) errors.push(`${to}: the phone answered HTTP ${r.status} ${r.text.slice(0, 120)}`);
      } catch (e) {
        try { wrapNet(e, url); } catch (ce) {
          const err = ce as import('./types.ts').ChannelError;
          if (err.ssrfHost) throw err;       // the same for every number: tell the user once, with the host to allow
          errors.push(`${to}: ${err.message}`);
        }
      }
    }
    if (errors.length) throw new ChannelError(errors.join('; '));
  },
};
export { phone };
