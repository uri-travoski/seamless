/** Android app support (T9.1): device registration, app config, Firebase set-up. */
import type { FastifyInstance } from 'fastify';
import { q, one, run } from '../db.ts';
import { uid, isAdmin, pkgVersion } from './util.ts';
import { getSetting, setSetting } from '../db.ts';
import { categoryOverview } from '../mail/categories.ts';
import { currentMode, modeLocked } from '../mode.ts';
import { saveServiceAccount, clearServiceAccount, fcmStatus, pushConfigured } from '../push/fcm.ts';
import { pushTest } from '../push/mobile.ts';
import fs from 'node:fs';

export const MIN_VERSION_KEY = 'mobile_min_version';
export const PRIVACY_CONTACT_KEY = 'privacy_contact';

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Public privacy policy for the Android app (Play Console asks for a URL). Static text + the owner's contact line. */
export function privacyPage(contact: string): string {
  const who = contact.trim() ? esc(contact.trim()) : 'the administrator of this server';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seamless — privacy policy</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#202124}h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:1.6rem}@media(prefers-color-scheme:dark){body{background:#202124;color:#e8eaed}}</style></head><body>
<h1>Seamless — privacy policy</h1>
<p>Seamless is self-hosted webmail. The Seamless Android app is only a window onto a Seamless server that you or your organisation run. This page describes what the app does with your data.</p>
<h2>What the app handles</h2>
<p>Your email address, your messages, contacts and attachments are processed on the Seamless server you sign in to. The app shows them and sends your actions (reading, replying, filing) to that server. The app does not send this data to the app's developer or to any third party.</p>
<h2>What is stored on your phone</h2>
<p>A sign-in session cookie and your app settings, kept in encrypted storage. Attachments you open are cached temporarily. Signing out, or uninstalling the app, removes them.</p>
<h2>Push notifications</h2>
<p>If the server administrator has set up Firebase Cloud Messaging, the app registers a device token with Google and with your server so that new-mail notifications can be delivered. The notification text is sent through Google's service; you can choose "hide message content" so it carries only "New mail". Without Firebase the app checks for new mail periodically instead.</p>
<h2>What we do not do</h2>
<p>No advertising, no analytics, no tracking, no sale or sharing of data. Traffic to https servers is encrypted in transit; plain http is allowed only for addresses on your own private network.</p>
<h2>Deleting your data</h2>
<p>Sign out in the app to remove the session and the push registration from the phone and the server. To delete your mail and account, ask ${who}.</p>
<h2>Contact</h2>
<p>Questions about this policy or about the data on this server: ${who}.</p>
</body></html>`;
}

export function register(app: FastifyInstance): void {
  // Public APK download so a phone on the LAN can fetch the app: set SEAMLESS_APK_PATH to the file. Read per request.
  app.get('/downloads/seamless.apk', async (_req, reply) => {
    const file = process.env.SEAMLESS_APK_PATH;
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return reply.code(404).type('text/plain').send('No app file is configured on this server.');
    return reply.type('application/vnd.android.package-archive').header('content-disposition', 'attachment; filename="seamless.apk"').send(fs.createReadStream(file));
  });
  app.get('/privacy', async (_req, reply) => reply.type('text/html; charset=utf-8').send(privacyPage((await getSetting(PRIVACY_CONTACT_KEY)) ?? '')));
  app.put('/api/mobile/privacy-contact', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admins only' });
    const v = String((req.body as any)?.contact ?? '').trim().slice(0, 300);
    await setSetting(PRIVACY_CONTACT_KEY, v);
    return { contact: v };
  });
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
