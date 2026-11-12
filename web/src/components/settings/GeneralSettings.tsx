import { useEffect, useState } from 'react';
import { useSession } from '../../state/session.ts';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export default function GeneralSettings() {
  const settings = useSession((s) => s.settings);
  const save = useSession((s) => s.saveSettings);
  const [pushState, setPushState] = useState<'idle' | 'busy' | 'on'>('idle');
  const [appName, setAppName] = useState(settings.appName);
  const [domains, setDomains] = useState(settings.noTrackDomains.join(', '));

  const [srv, setSrv] = useState<{ undoSendSeconds: number; snoozeWakeOnReply: boolean } | null>(null);
  useEffect(() => { api.get<{ undoSendSeconds: number; snoozeWakeOnReply: boolean }>('/api/settings/server').then(setSrv).catch(() => {}); }, []);
  const saveSrv = async (patch: Partial<{ undoSendSeconds: number; snoozeWakeOnReply: boolean }>) => {
    if (!srv) return;
    const prev = srv;
    setSrv({ ...srv, ...patch });
    try { await api.put('/api/settings/server', patch); } catch { setSrv(prev); toast('Could not save', 'error'); }
  };

  const enablePush = async () => {
    setPushState('busy');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push needs HTTPS and a supporting browser');
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Notification permission denied');
      const { key } = await api.get<{ key: string }>('/api/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      await api.post('/api/push/subscribe', sub.toJSON());
      setPushState('on');
      toast('Push notifications enabled');
    } catch (e: any) {
      setPushState('idle');
      toast(e?.message ?? 'Could not enable push', 'error');
    }
  };

  return (
    <div>
      <h2>General</h2>

      <h3>App name</h3>
      <p className="settings-desc">Shown at the top of the sidebar, on the sign-in screen and in the browser tab.</p>
      <div className="field-row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <input className="text-input" value={appName} maxLength={40} onChange={(e) => setAppName(e.target.value)}
            onBlur={() => save({ appName: appName.trim() || 'Seamless' })} onKeyDown={(e) => e.key === 'Enter' && save({ appName: appName.trim() || 'Seamless' })} aria-label="App name" />
        </div>
        {settings.appName !== 'Seamless' && <button className="btn" onClick={() => { setAppName('Seamless'); save({ appName: 'Seamless' }); }}>Reset</button>}
      </div>

      <h3>Privacy</h3>
      <label className="checkbox-line">
        <input type="checkbox" checked={settings.allowRemoteImages} onChange={(e) => save({ allowRemoteImages: e.target.checked })} />
        Always load remote images (otherwise blocked until you click "Load images")
      </label>

      <h3>Open tracking</h3>
      <p className="settings-desc">
        A tiny image in the message tells you when it's opened. Each message has its own on/off eye on the compose toolbar; this sets the default.
        Australian privacy and spam law apply when you track customers — check before relying on it.
      </p>
      <label className="checkbox-line">
        <input type="checkbox" checked={settings.trackByDefault} onChange={(e) => save({ trackByDefault: e.target.checked })} />
        Track opens by default when composing
      </label>
      <label className="checkbox-line">
        <input type="checkbox" checked={settings.perRecipientTracking} onChange={(e) => save({ perRecipientTracking: e.target.checked })} />
        Track each recipient separately by default (sends one copy per recipient, so the report shows who opened)
      </label>
      <div className="field">
        <label>Never track mail to these domains</label>
        <input className="text-input" value={domains} placeholder="government.gov.au, bigclient.com"
          onChange={(e) => setDomains(e.target.value)}
          onBlur={() => save({ noTrackDomains: domains.split(/[\s,;]+/).map((d) => d.trim().replace(/^@/, '').toLowerCase()).filter(Boolean) })} />
        <span className="hint">Mail to your own mailboxes is never tracked.</span>
      </div>

      <h3>Sending and snoozing</h3>
      <div className="field">
        <label>Undo send</label>
        <select className="text-input compact" style={{ maxWidth: 220 }} disabled={!srv} value={srv?.undoSendSeconds ?? 10}
          onChange={(e) => void saveSrv({ undoSendSeconds: Number(e.target.value) })}>
          <option value={0}>Off — send immediately</option>
          {[5, 10, 20, 30, 45, 60].map((n) => <option key={n} value={n}>Hold for {n} seconds</option>)}
        </select>
        <span className="hint">After you press Send the message waits this long so you can take it back. Scheduled sends are not delayed.</span>
      </div>
      <label className="checkbox-line">
        <input type="checkbox" disabled={!srv} checked={srv?.snoozeWakeOnReply ?? true} onChange={(e) => void saveSrv({ snoozeWakeOnReply: e.target.checked })} />
        Snooze: bring a conversation back early when someone replies
      </label>

      <h3>Keyboard shortcuts</h3>
      <label className="checkbox-line">
        <input type="checkbox" checked={settings.shortcuts} onChange={(e) => save({ shortcuts: e.target.checked })} />
        Gmail-style shortcuts (press <kbd>?</kbd> for the list)
      </label>

      <h3>Push notifications</h3>
      <p className="settings-desc">Native notifications on this device. Choose which kinds push in Settings → Notifications.</p>
      <button className="btn" disabled={pushState !== 'idle'} onClick={enablePush}>
        {pushState === 'on' ? '✓ Push enabled' : pushState === 'busy' ? 'Enabling…' : 'Enable push on this device'}
      </button>
    </div>
  );
}
