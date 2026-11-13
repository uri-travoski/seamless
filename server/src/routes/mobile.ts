/** Android app support (T9.1): device registration, app config, Firebase set-up. */
import type { FastifyInstance } from 'fastify';
import { q, one, run } from '../db.ts';
import { uid, isAdmin, pkgVersion } from './util.ts';
import { getSetting, setSetting } from '../db.ts';
import { categoryOverview } from '../mail/categories.ts';
import { currentMode, modeLocked } from '../mode.ts';
import { saveServiceAccount, clearServiceAccount, fcmStatus, pushConfigured } from '../push/fcm.ts';
import { pushTest } from '../push/mobile.ts';

export const MIN_VERSION_KEY = 'mobile_min_version';

export function register(app: FastifyInstance): void {
  app.get('/api/mobile/config', async (req) => ({
    pushEnabled: await pushConfigured(),
    appMinVersion: (await getSetting(MIN_VERSION_KEY)) ?? '0.1.0',
    mailboxSwitcher: await categoryOverview(uid(req)),
    serverVersion: pkgVersion,
    mode: currentMode(),
    modeLocked: modeLocked(),
  }));

  app.get('/api/mobile/device', async (req) => (await q<any>(
    'SELECT id, device_name, app_version, notify_mail, notify_alerts, hide_content, last_seen_at, created_at FROM mobile_devices WHERE user_id = ? ORDER BY id', [uid(req)]))
    .map((d) => ({ id: d.id, deviceName: d.device_name, appVersion: d.app_version, notifyMail: d.notify_mail, notifyAlerts: d.notify_alerts, hideContent: d.hide_content, lastSeenAt: Number(d.last_seen_at), createdAt: Number(d.created_at) })));

  // register / refresh this phone (upsert by FCM token)
  app.post('/api/mobile/device', async (req, reply) => {
    const b = (req.body ?? {}) as { fcmToken?: string; deviceName?: string; appVersion?: string; notifyMail?: boolean; notifyAlerts?: boolean; hideContent?: boolean };
    const token = String(b.fcmToken ?? '').trim();
    if (token.length < 20 || token.length > 4096) return reply.code(400).send({ error: 'fcmToken required' });
    const now = Date.now();
    const sessionId = (req as any).sessionUser.token as string;
    const row = await one<{ id: number }>(`
      INSERT INTO mobile_devices(user_id, session_id, fcm_token, platform, device_name, app_version, notify_mail, notify_alerts, hide_content, last_seen_at, created_at)
      VALUES (?,?,?,'android',?,?,?,?,?,?,?)
      ON CONFLICT (fcm_token) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id, device_name = excluded.device_name,
        app_version = excluded.app_version, last_seen_at = excluded.last_seen_at,
        notify_mail = COALESCE(?, mobile_devices.notify_mail), notify_alerts = COALESCE(?, mobile_devices.notify_alerts), hide_content = COALESCE(?, mobile_devices.hide_content)
      RETURNING id`,
      [uid(req), sessionId, token, String(b.deviceName ?? '').slice(0, 80), String(b.appVersion ?? '').slice(0, 30),
        b.notifyMail ?? true, b.notifyAlerts ?? true, b.hideContent ?? false, now, now,
        b.notifyMail ?? null, b.notifyAlerts ?? null, b.hideContent ?? null]);
    return { ok: true, id: row!.id, pushEnabled: await pushConfigured() };
  });

  // unregister: by token (?fcmToken=) or, without one, every device of this session
  app.delete('/api/mobile/device', async (req) => {
    const token = String((req.query as any)?.fcmToken ?? (req.body as any)?.fcmToken ?? '');
    const n = token
      ? await run('DELETE FROM mobile_devices WHERE user_id = ? AND fcm_token = ?', [uid(req), token])
      : await run('DELETE FROM mobile_devices WHERE user_id = ? AND session_id = ?', [uid(req), (req as any).sessionUser.token]);
    return { ok: true, removed: n };
  });

  app.post('/api/mobile/test-push', async (req, reply) => {
    if (!(await pushConfigured())) return reply.code(400).send({ error: 'Mobile push is not set up yet. An administrator adds the Firebase key in Settings → Integrations.' });
    const r = await pushTest(uid(req));
    if (!r.devices) return reply.code(404).send({ error: 'No phone is registered. Open the Seamless app and sign in first.' });
    return r;
  });

  // ---- Firebase service account (admin) ----
  app.get('/api/mobile/fcm', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    return fcmStatus();
  });
  app.put('/api/mobile/fcm', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    try { await saveServiceAccount(String((req.body as any)?.serviceAccount ?? '')); }
    catch (e: any) { return reply.code(400).send({ error: e.message }); }
    return fcmStatus();
  });
  app.delete('/api/mobile/fcm', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    await clearServiceAccount();
    return fcmStatus();
  });
}
