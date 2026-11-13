/** Phone push (T9.1): fan a notification out to the user's registered Android devices. Data-only, minimal payloads. */
import { q, one, run } from '../db.ts';
import { sendFcm, loadServiceAccount, type ServiceAccount } from './fcm.ts';
import { isViewing } from '../mode.ts';

export interface DeviceRow {
  id: number; user_id: number; session_id: string | null; fcm_token: string; device_name: string; app_version: string;
  notify_mail: boolean; notify_alerts: boolean; hide_content: boolean;
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Send one data message to each device, deleting tokens Google says are gone. Returns how many were delivered. */
async function fanOut(devices: DeviceRow[], build: (d: DeviceRow) => Record<string, string>, collapseKey: string): Promise<number> {
  const sa: ServiceAccount | null = await loadServiceAccount();
  if (!sa || !devices.length) return 0;
  let sent = 0;
  await Promise.allSettled(devices.map(async (d) => {
    try {
      const r = await sendFcm(d.fcm_token, build(d), { collapseKey, sa });
      if (r === 'unregistered') await run('DELETE FROM mobile_devices WHERE id = ?', [d.id]);
      else sent++;
    } catch (e: any) { console.error('[fcm] send failed:', e?.message ?? e); }
  }));
  return sent;
}

/** New mail in an inbox the user can see. The caller has already applied the notify / VIP / quiet-hours / mute rules. */
export async function pushNewMail(userId: number, p: { messageId: number; accountId: number | null; from: string; subject: string }): Promise<number> {
  if (isViewing()) return 0;                       // Viewing mode: no mail is received, so nothing is announced
  const devices = await q<DeviceRow>('SELECT * FROM mobile_devices WHERE user_id = ? AND notify_mail = true', [userId]);
  if (!devices.length) return 0;
  const msg = await one<{ thread_id: string; snippet: string }>('SELECT thread_id, snippet FROM messages WHERE id = ? AND user_id = ?', [p.messageId, userId]);
  if (!msg) return 0;
  return fanOut(devices, (d): Record<string, string> => d.hide_content
    ? { type: 'mail', messageId: String(p.messageId), accountId: String(p.accountId ?? ''), hidden: '1', subject: 'New mail' }
    : { type: 'mail', messageId: String(p.messageId), accountId: String(p.accountId ?? ''), sender: clip(p.from, 120), subject: clip(p.subject, 160), snippet: clip(msg.snippet, 100) },
  `thread-${msg.thread_id}`.slice(0, 200));
}

/** A critical alert (T8.9, "a mailbox stopped working"). Always sent, whatever the mail settings say. */
export async function pushAlert(userId: number, a: { id: number; title: string; body: string; accountId: number | null }): Promise<number> {
  const devices = await q<DeviceRow>('SELECT * FROM mobile_devices WHERE user_id = ? AND notify_alerts = true', [userId]);
  return fanOut(devices, (d): Record<string, string> => d.hide_content
    ? { type: 'alert', alertId: String(a.id), accountId: String(a.accountId ?? ''), hidden: '1', subject: 'Seamless needs attention' }
    : { type: 'alert', alertId: String(a.id), accountId: String(a.accountId ?? ''), subject: clip(a.title, 160), snippet: clip(a.body, 100) },
  `alert-${a.id}`);
}

/** "Send test push to my phone". Returns how many devices accepted it. */
export async function pushTest(userId: number): Promise<{ devices: number; sent: number }> {
  const devices = await q<DeviceRow>('SELECT * FROM mobile_devices WHERE user_id = ?', [userId]);
  const sent = await fanOut(devices, () => ({ type: 'test', subject: 'Test push from Seamless', snippet: 'If you can read this, push works.' }), 'test');
  return { devices: devices.length, sent };
}

/** A message was read somewhere else: tell the phones so they can clear its notification (data-only, no content). */
const readBudget = new Map<number, { at: number; n: number }>();
export async function pushRead(userId: number, messageId: number): Promise<number> {
  // "mark all as read" must not turn into hundreds of FCM calls: at most 30 a minute per user
  const now = Date.now(), b = readBudget.get(userId);
  if (!b || now - b.at > 60_000) readBudget.set(userId, { at: now, n: 1 });
  else if (++b.n > 30) return 0;
  const devices = await q<DeviceRow>('SELECT * FROM mobile_devices WHERE user_id = ?', [userId]);
  if (!devices.length) return 0;
  return fanOut(devices, () => ({ type: 'read', messageId: String(messageId) }), `read-${messageId}`);
}
