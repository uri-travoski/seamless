import webpush from 'web-push';
import { q, run, getSetting, setSetting } from './db.ts';
import { config } from './config.ts';

let keys: { publicKey: string; privateKey: string } | null = null;

export async function initPush(): Promise<void> {
  const stored = await getSetting('vapid');
  if (stored) {
    keys = JSON.parse(stored);
  } else {
    keys = webpush.generateVAPIDKeys();
    await setSetting('vapid', JSON.stringify(keys));
  }
  webpush.setVapidDetails(`mailto:admin@${new URL(config.publicUrl).hostname}`, keys!.publicKey, keys!.privateKey);
}

export function vapidPublicKey(): string {
  return keys?.publicKey ?? '';
}

export async function saveSubscription(userId: number, sub: { endpoint: string; keys: unknown }): Promise<void> {
  await run(
    'INSERT INTO push_subscriptions(user_id, endpoint, keys_json, created_at) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET keys_json = excluded.keys_json, user_id = excluded.user_id',
    [userId, sub.endpoint, JSON.stringify(sub.keys), Date.now()],
  );
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

export async function notifyUser(userId: number, title: string, body: string, tag: string): Promise<void> {
  const subs = await q<{ endpoint: string; keys_json: string }>(
    'SELECT endpoint, keys_json FROM push_subscriptions WHERE user_id = ?', [userId]);
  await Promise.allSettled(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: JSON.parse(s.keys_json) },
        JSON.stringify({ title, body, tag }),
      );
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) await removeSubscription(s.endpoint);
    }
  }));
}
