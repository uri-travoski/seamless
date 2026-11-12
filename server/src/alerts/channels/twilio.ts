/** SMS through Twilio: POST https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json, Basic auth sid:token,
 *  form body To / From (or MessagingServiceSid) / Body. One request per number. */
import { ChannelError, str, phone, phoneList, apiBase, wrapNet, type ChannelAdapter } from './types.ts';

export const twilio: ChannelAdapter = {
  kind: 'twilio',
  label: 'SMS via Twilio',
  secrets: ['authToken'],
  validate(c) {
    const accountSid = str(c.accountSid);
    if (!/^AC[0-9a-zA-Z]{20,}$/.test(accountSid)) throw new ChannelError('Account SID should start with "AC" (find it on the Twilio console home page)');
    const authToken = str(c.authToken);
    if (!authToken) throw new ChannelError('Enter the Auth Token');
    const messagingServiceSid = str(c.messagingServiceSid);
    const from = str(c.from) ? phone(c.from) : null;
    if (!messagingServiceSid && !from) throw new ChannelError('Enter the Twilio "from" number (like +15551234567) or a Messaging Service SID');
    const to = phoneList(c.to);
    if (!to.length) throw new ChannelError('Enter at least one number to send the SMS to');
    return { accountSid, authToken, from: from ?? '', messagingServiceSid, to, apiBase: str(c.apiBase) };
  },
  describe: (c) => `${(c.to as string[]).join(', ')} from ${c.messagingServiceSid || c.from}`,
  async send(c, msg, deps) {
    const base = apiBase(c.apiBase, 'https://api.twilio.com');
    const url = `${base}/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`;
    const auth = `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`;
    const errors: string[] = [];
    for (const to of c.to as string[]) {
      const form = new URLSearchParams({ To: to, Body: msg.text });
      if (c.messagingServiceSid) form.set('MessagingServiceSid', c.messagingServiceSid); else form.set('From', c.from);
      try {
        const r = await deps.http(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() });
        if (r.status < 200 || r.status >= 300) {
          let detail = r.text.slice(0, 200);
          try { const j = JSON.parse(r.text); detail = `${j.message ?? detail}${j.code ? ` (Twilio code ${j.code})` : ''}`; } catch { /* keep raw */ }
          errors.push(`${to}: HTTP ${r.status} ${detail}`);
        }
      } catch (e) {
        try { wrapNet(e, url); } catch (ce) { errors.push(`${to}: ${(ce as Error).message}`); }
      }
    }
    if (errors.length) throw new ChannelError(errors.join('; '));
  },
};
