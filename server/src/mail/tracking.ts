/**
 * Open tracking (T0 F-01 limits, T1 F-15 classification + report).
 *
 * - 30 recorded hits per minute per token (a forwarded newsletter can't flood the DB).
 * - The same IP hitting the same token within 60 s is stored (the log stays honest) but
 *   not re-broadcast or re-notified.
 * - Opens from mail privacy proxies and security scanners are flagged `proxied` and kept
 *   out of the "real opens" count.
 * - Per-recipient copies (tracked_sends.group_token) roll up to the Sent copy.
 */
import type { ApiOpen, ApiOpenReport } from '@seamless/shared';
import { q, one, run, bumpState } from '../db.ts';
import { broadcast } from '../ws.ts';
import { pixelLimiter, pixelDedupe } from '../security/ratelimit.ts';
import { emitEvent } from '../events/emit.ts';
import { getMsgRow } from './store.ts';

export interface OpenResult { recorded: boolean; announced: boolean; proxied?: boolean }

/** Name the client and decide whether this was a person or a machine fetching the pixel. */
export function classifyOpen(ua: string, opts: { sentAt?: number | null; now?: number } = {}): { client: string; proxied: boolean } {
  const u = ua.trim();
  const now = opts.now ?? Date.now();
  // opened within 2 s of sending: a link/attachment scanner, not a reader
  if (opts.sentAt && now - opts.sentAt >= 0 && now - opts.sentAt < 2000) return { client: 'Security scanner (opened instantly)', proxied: true };
  if (/GoogleImageProxy|ggpht\.com/i.test(u)) return { client: 'Gmail (Google image proxy)', proxied: true };
  if (/YahooMailProxy/i.test(u)) return { client: 'Yahoo Mail (proxy)', proxied: true };
  if (/OutlookProxy|BingPreview|Microsoft-Exchange|ms-office.*proxy/i.test(u)) return { client: 'Outlook (proxy)', proxied: true };
  // Apple Mail Privacy Protection fetches with a bare UA
  if (u === 'Mozilla/5.0' || u === '') return { client: 'Apple Mail (Privacy Protection)', proxied: true };
  if (/bot|crawler|spider|scanner|python-requests|curl\/|wget|Barracuda|Mimecast|Proofpoint|Symantec|Trend ?Micro/i.test(u)) return { client: 'Automated scanner', proxied: true };

  let client = 'Unknown client';
  if (/Thunderbird/i.test(u)) client = 'Thunderbird';
  else if (/Microsoft Outlook|MSOffice|Outlook-iOS|Outlook-Android|ms-office/i.test(u)) client = 'Outlook';
  else if (/iPhone|iPad/i.test(u)) client = /CriOS|FxiOS/.test(u) ? 'Mobile browser (iOS)' : 'Apple Mail (iOS)';
  else if (/Android/i.test(u)) client = /wv\)|Version\/\d/.test(u) ? 'Android mail app' : 'Chrome (Android)';
  else if (/Macintosh/i.test(u) && /AppleWebKit/i.test(u) && !/Chrome|Firefox|Safari\//i.test(u)) client = 'Apple Mail (Mac)';
  else {
    const browser = /Edg\//.test(u) ? 'Edge' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : '';
    const os = /Windows/.test(u) ? 'Windows' : /Mac OS X/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : '';
    if (browser) client = os ? `${browser} on ${os}` : browser;
  }
  return { client, proxied: false };
}

export async function recordOpen(token: string, ip: string, ua: string, now = Date.now()): Promise<OpenResult> {
  if (!pixelLimiter.hit(`tok:${token}`, now)) return { recorded: false, announced: false };
  const fresh = pixelDedupe.hit(`${token}|${ip}`, now);
  const sent = await one<{ group_token: string | null; recipient: string | null; sent_at: number }>(
    'SELECT group_token, recipient, sent_at FROM tracked_sends WHERE token = ?', [token]);
  const { client, proxied } = classifyOpen(ua, { sentAt: sent?.sent_at, now });
  await run('INSERT INTO tracking_opens(token, ts, ip, ua, client, proxied) VALUES (?,?,?,?,?,?)',
    [token, now, ip, ua.slice(0, 300), client, proxied]);
  if (!fresh) return { recorded: true, announced: false, proxied };

  // the sent copy carrying this token (or its group token for per-recipient copies)
  const msgToken = sent?.group_token ?? token;
  const msg = await one<{ id: number; user_id: number; account_id: number; subject: string; to_json: string; cc_json: string }>(`
    SELECT m.id, m.user_id, m.account_id, m.subject, m.to_json, m.cc_json
    FROM messages m JOIN mailboxes mb ON mb.id = m.mailbox_id
    WHERE m.tracking_token = ?
    ORDER BY CASE mb.role WHEN 'sent' THEN 0 ELSE 1 END, m.id LIMIT 1`, [msgToken]);

  await bumpState();
  if (msg) {
    let people: { name?: string; email?: string }[] = [];
    try { people = [...JSON.parse(msg.to_json), ...JSON.parse(msg.cc_json)]; } catch { /* empty */ }
    let recipient: string;
    if (sent?.recipient) {
      // per-recipient copy: show the person's name from the headers when we have it
      const p = people.find((x) => x.email?.toLowerCase() === sent.recipient!.toLowerCase());
      recipient = p?.name || sent.recipient;
    } else {
      recipient = people[0] ? (people[0].name || people[0].email || '') : '';
    }
    await emitEvent(msg.user_id, 'mail.opened', { type: 'message', id: msg.id }, {
      messageId: msg.id, accountId: msg.account_id, subject: msg.subject, recipient, token, ip, client, proxied,
      perRecipient: !!sent?.recipient,
    });
    broadcast({ type: 'stateChange' }, msg.user_id);
  } else {
    broadcast({ type: 'stateChange' });
  }
  return { recorded: true, announced: true, proxied };
}

/** Full open report for one tracked message (T1 F-15 /mail/msg/:id/opens). */
export async function openReport(userId: number, emailId: string): Promise<ApiOpenReport | null> {
  const row = await getMsgRow(userId, emailId);
  if (!row || !row.tracking_token) return null;
  const sends = await q<{ token: string; recipient: string | null; sent_at: number }>(
    'SELECT token, recipient, sent_at FROM tracked_sends WHERE (token = ? OR group_token = ?) AND user_id = ?',
    [row.tracking_token, row.tracking_token, userId]);
  const tokens = [row.tracking_token, ...sends.map((s) => s.token)];
  const recipientOf = new Map(sends.map((s) => [s.token, s.recipient]));
  const rows = await q<{ token: string; ts: number; ip: string; ua: string; client: string | null; country: string | null; proxied: boolean }>(
    'SELECT token, ts, ip, ua, client, country, proxied FROM tracking_opens WHERE token = ANY(?::text[]) ORDER BY ts DESC LIMIT 1000', [tokens]);
  // per-recipient copies record the address; show the name from the message headers
  const people = [...JSON.parse(row.to_json), ...JSON.parse(row.cc_json)] as { name?: string; email?: string }[];
  const nameOf = (addr: string | null | undefined) => {
    if (!addr) return null;
    const p = people.find((x) => x.email?.toLowerCase() === addr.toLowerCase());
    return p?.name ? `${p.name} <${addr}>` : addr;
  };
  const opens: ApiOpen[] = rows.map((r) => ({
    ts: Number(r.ts), recipient: nameOf(recipientOf.get(r.token)),
    client: r.client || classifyOpen(r.ua).client, ip: r.ip, country: r.country, proxied: r.proxied,
  }));
  const real = opens.filter((o) => !o.proxied);
  const sentAt = sends.find((s) => s.token === row.tracking_token)?.sent_at ?? null;
  return {
    emailId: `m${row.id}`, subject: row.subject, sentAt: sentAt ?? row.date, to: JSON.parse(row.to_json),
    perRecipient: sends.some((s) => !!s.recipient),
    summary: {
      total: opens.length, real: real.length,
      firstAt: real.length ? Math.min(...real.map((o) => o.ts)) : null,
      lastAt: real.length ? Math.max(...real.map((o) => o.ts)) : null,
      uniqueDevices: new Set(real.map((o) => `${o.ip}|${o.client}`)).size,
    },
    opens,
  };
}
