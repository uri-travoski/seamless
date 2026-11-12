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

      <ModeSection />

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

interface ModeInfo { mode: 'live' | 'viewing'; locked: boolean; stale: { scheduledSends: number; ops: number; undoSends: number } }

/** Settings → General → Mode (administrators). Live fetches and sends mail; Viewing only is a reference copy. */
function ModeSection() {
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const setMode = useSession((s) => s.setMode);
  const [info, setInfo] = useState<ModeInfo | null>(null);
  const [typed, setTyped] = useState('');
  const [discard, setDiscard] = useState(true);
  const [confirming, setConfirming] = useState<null | 'live' | 'viewing'>(null);
  useEffect(() => { api.get<ModeInfo>('/api/mode').then(setInfo).catch(() => {}); }, []);
  if (!info) return null;
  const queued = info.stale.scheduledSends + info.stale.ops + info.stale.undoSends;
  const apply = async (to: 'live' | 'viewing') => {
    try {
      const r = await api.put<ModeInfo>('/api/mode', { mode: to, confirm: to === 'live' ? typed : undefined, stale: discard ? 'discard' : 'keep' });
      setInfo(r); setMode(r.mode, r.locked); setConfirming(null); setTyped('');
      toast(to === 'live' ? 'Live mode: mail is fetched and sent again' : 'Viewing mode: mail is neither sent nor received');
    } catch (e: any) { toast(e?.message ?? 'Could not switch', 'error'); }
  };
  return (
    <>
      <h3>Mode</h3>
      <p className="settings-desc">
        <b>Live</b> is the normal app: it fetches new mail and sends yours. <b>Viewing only</b> is a reference copy: nothing is fetched or sent,
        but you can read, search, label, filter and export everything. Use it for an instance that holds old mail.
      </p>
      {info.locked && <p className="settings-desc"><b>Set by the server configuration</b> (SEAMLESS_MODE). It cannot be changed here.</p>}
      <div className="field-row">
        <label className="checkbox-line"><input type="radio" name="app-mode" checked={info.mode === 'live'} disabled={!isAdmin || info.locked || info.mode === 'live'} onChange={() => setConfirming('live')} /> Live</label>
        <label className="checkbox-line"><input type="radio" name="app-mode" checked={info.mode === 'viewing'} disabled={!isAdmin || info.locked || info.mode === 'viewing'} onChange={() => setConfirming('viewing')} /> Viewing only</label>
      </div>
      {!isAdmin && <p className="settings-desc">Only an administrator can change the mode.</p>}
      {confirming === 'viewing' && (
        <div className="settings-card">
          <p>Switch to Viewing only? Mail will stop being fetched and sent on this instance.</p>
          <button className="btn primary" onClick={() => apply('viewing')}>Switch to Viewing only</button>{' '}
          <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
        </div>
      )}
      {confirming === 'live' && (
        <div className="settings-card">
          <p><b>This instance will start fetching and sending mail for its connected mailboxes.</b></p>
          {queued > 0 && (
            <label className="checkbox-line">
              <input type="checkbox" checked={discard} onChange={(e) => setDiscard(e.target.checked)} />
              Discard mail queued earlier ({info.stale.scheduledSends} scheduled, {info.stale.undoSends} waiting to send, {info.stale.ops} pending server changes) so it is never sent by surprise
            </label>
          )}
          <div className="field"><input className="text-input" placeholder="Type LIVE to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type LIVE to confirm" /></div>
          <button className="btn primary" disabled={typed !== 'LIVE'} onClick={() => apply('live')}>Switch to Live</button>{' '}
          <button className="btn" onClick={() => { setConfirming(null); setTyped(''); }}>Cancel</button>
        </div>
      )}
    </>
  );
}
