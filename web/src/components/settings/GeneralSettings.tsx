import { useState } from 'react';
import { useSession } from '../../state/session.ts';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';

const POPULAR_FONTS = [
  'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito', 'Nunito Sans',
  'Work Sans', 'Source Sans 3', 'IBM Plex Sans', 'DM Sans', 'Manrope', 'Plus Jakarta Sans', 'Rubik', 'Karla',
  'Merriweather', 'Lora', 'Playfair Display', 'PT Serif', 'Roboto Slab',
  'JetBrains Mono', 'Roboto Mono', 'IBM Plex Mono', 'Space Grotesk', 'Figtree',
];

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

  const enablePush = async () => {
    setPushState('busy');
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push not supported in this browser');
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

      <h3>Layout</h3>
      <p className="settings-desc">Split shows the message list beside a reading pane. Table is a Gmail-style full-width list; clicking a row opens the message.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className={`btn ${settings.layout === 'split' ? 'primary' : ''}`} onClick={() => save({ layout: 'split' })}>Split view</button>
        <button className={`btn ${settings.layout === 'table' ? 'primary' : ''}`} onClick={() => save({ layout: 'table' })}>Table view</button>
      </div>

      <h3>Font</h3>
      <p className="settings-desc">Pick any Google font by name — it's loaded and applied across the whole app (sidebar, lists, emails, compose).</p>
      <div className="field-row" style={{ alignItems: 'flex-end' }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Google font</label>
          <input className="text-input" list="google-fonts" value={settings.fontFamily}
            placeholder="System default (e.g. Inter, Roboto, Lato…)"
            onChange={(e) => save({ fontFamily: e.target.value })} />
          <datalist id="google-fonts">
            {POPULAR_FONTS.map((f) => <option key={f} value={f} />)}
          </datalist>
        </div>
        {settings.fontFamily && (
          <button className="btn" onClick={() => save({ fontFamily: '' })}>Reset to system</button>
        )}
      </div>

      <h3>Font size</h3>
      <p className="settings-desc">Scales all text — sidebar, message list, reading pane and compose.</p>
      <div className="range-line">
        <input
          type="range" min={12} max={20} step={1} value={settings.fontSize}
          onChange={(e) => save({ fontSize: Number(e.target.value) })}
        />
        <output>{settings.fontSize}px</output>
      </div>
      <div className="font-preview" style={{ fontFamily: settings.fontFamily ? `'${settings.fontFamily}', var(--md-font)` : 'var(--md-font)' }}>
        The quick brown fox jumps over the lazy dog — text renders in {settings.fontFamily || 'the system font'} at this size.
      </div>

      <h3>Privacy</h3>
      <label className="checkbox-line">
        <input type="checkbox" checked={settings.allowRemoteImages}
          onChange={(e) => save({ allowRemoteImages: e.target.checked })} />
        Always load remote images (otherwise blocked until you click "Load images")
      </label>
      <label className="checkbox-line">
        <input type="checkbox" checked={settings.trackByDefault}
          onChange={(e) => save({ trackByDefault: e.target.checked })} />
        Enable open-tracking pixel by default when composing
      </label>

      <h3>Notifications</h3>
      <p className="settings-desc">Native push notifications for new inbox mail (works when the PWA is installed too).</p>
      <button className="btn" disabled={pushState !== 'idle'} onClick={enablePush}>
        {pushState === 'on' ? '✓ Push enabled' : pushState === 'busy' ? 'Enabling…' : 'Enable push notifications'}
      </button>
    </div>
  );
}
