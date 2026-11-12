/** Settings → Alerts (T8.9): where a "mailbox stopped working" message goes — email, Twilio SMS, your own phone, Telegram. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { useSession } from '../../state/session.ts';
import { useAlerts, type AppAlert } from '../../state/alerts.ts';
import { relTime } from '../../state/notifications.ts';
import { TrashIcon, WarningIcon } from '../../icons.tsx';

type Kind = 'email' | 'twilio' | 'sms_gateway' | 'telegram';
interface Channel {
  id: number; kind: Kind; name: string; scope: 'user' | 'team'; mine: boolean; enabled: boolean; verifiedAt: number | null;
  lastOkAt: number | null; lastError: string | null; summary: string; config: Record<string, any>; secretsSet: string[];
}
interface Preset { name: string; method: string; contentType: 'json' | 'form'; bodyTemplate: string; urlHint: string; auth: string; note: string }
interface ChannelsResp { items: Channel[]; kinds: { kind: Kind; label: string; secrets: string[] }[]; presets: Record<string, Preset>; hasVerified: boolean }
interface Settings { syncFailures: number; syncStaleMinutes: number; sendFailures: number; quotaPercent: number; pushSilentHours: number; reminderHours: number }

const KIND_LABEL: Record<Kind, string> = { email: 'Email', twilio: 'SMS via Twilio', sms_gateway: 'SMS via my phone', telegram: 'Telegram' };
const KIND_HELP: Record<Kind, string> = {
  email: 'An email to an address outside this server (not the mailbox that is down).',
  twilio: 'A text message through your Twilio account.',
  sms_gateway: 'Your own Android phone sends the text. The phone and this server must reach each other (same network, VPN or tunnel).',
  telegram: 'A message from your own Telegram bot. Free and fast.',
};
const MANUAL = '/manual#31-alerts';

type Form = Record<string, string>;
const blank = (kind: Kind, presets: Record<string, Preset>): Form => {
  if (kind === 'sms_gateway') { const p = presets['android-sms-gateway']; return { preset: 'android-sms-gateway', url: '', method: p?.method ?? 'POST', contentType: p?.contentType ?? 'json', bodyTemplate: p?.bodyTemplate ?? '', to: '', username: '', password: '', token: '' }; }
  return {};
};
const fromChannel = (c: Channel): Form => {
  const f: Form = {};
  for (const [k, v] of Object.entries(c.config)) f[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  return f;
};

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <div className="field"><label>{label}</label>{children}{hint && <div className="hint">{hint}</div>}</div>;
}

/** The form for one channel. `onSaved` gets the channel after it was saved and a test was sent. */
export function ChannelEditor({ kind, presets, editing, onDone, onCancel, isAdmin }: {
  kind: Kind; presets: Record<string, Preset>; editing: Channel | null; onDone: (c: Channel) => void; onCancel?: () => void; isAdmin: boolean;
}) {
  const [f, setF] = useState<Form>(editing ? fromChannel(editing) : blank(kind, presets));
  const [name, setName] = useState(editing?.name ?? '');
  const [team, setTeam] = useState(editing?.scope === 'team');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ssrfHost, setSsrfHost] = useState('');
  const [chats, setChats] = useState<{ id: string; name: string; type: string }[] | null>(null);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const secretSet = (k: string) => !!editing?.secretsSet.includes(k);
  const secretPh = (k: string) => (secretSet(k) ? '(saved — leave blank to keep)' : '');

  const choosePreset = (id: string) => {
    const p = presets[id]; if (!p) return;
    setF((x) => ({ ...x, preset: id, method: p.method, contentType: p.contentType, bodyTemplate: p.bodyTemplate }));
  };

  const body = () => {
    const config: Record<string, any> = { ...f };
    if (kind === 'twilio' || kind === 'sms_gateway') config.to = (f.to ?? '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    if (kind === 'email') config.to = (f.to ?? '').split(/[,;\s]+/).filter(Boolean);
    return { kind, name: name.trim(), scope: team ? 'team' : 'user', config };
  };

  const save = async () => {
    setBusy(true); setErr(''); setSsrfHost('');
    try {
      const saved = editing
        ? await api.put<Channel>(`/api/alert-channels/${editing.id}`, { name: name.trim(), config: body().config })
        : await api.post<Channel>('/api/alert-channels', body());
      const t = await api.post<{ ok: boolean; error?: string; ssrfHost?: string | null; channel: Channel }>(`/api/alert-channels/${saved.id}/test`);
      if (t.ok) { toast('Test message sent — check your phone or inbox'); onDone(t.channel); }
      else { setErr(`Saved, but the test message failed: ${t.error}`); if (t.ssrfHost) setSsrfHost(t.ssrfHost); onDone(t.channel); }
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const allowHost = async () => {
    try { await api.post('/api/webhook-allowlist', { value: ssrfHost }); toast(`${ssrfHost} allowed`); setSsrfHost(''); setErr(''); }
    catch { toast('Only an administrator can allow a private address — ask one to add it in Settings → Integrations', 'error'); }
  };

  const findChat = async () => {
    setErr('');
    try { setChats((await api.post<{ chats: { id: string; name: string; type: string }[] }>('/api/alert-channels/telegram/find-chat', { botToken: f.botToken, channelId: editing?.id })).chats); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="settings-section alert-editor">
      <h3>{editing ? 'Edit' : 'Add'} — {KIND_LABEL[kind]}</h3>
      <p className="hint">{KIND_HELP[kind]} <a href={MANUAL} target="_blank" rel="noreferrer">Step-by-step guide</a></p>
      <Field label="Name (for you)"><input className="text-input" value={name} placeholder={KIND_LABEL[kind]} onChange={(e) => setName(e.target.value)} /></Field>

      {kind === 'email' && <Field label="Send alerts to" hint="An address on another provider, one you read on your phone. Several can be separated by commas.">
        <input className="text-input" type="text" inputMode="email" value={f.to ?? ''} onChange={(e) => set('to', e.target.value)} placeholder="you@example.com" /></Field>}

      {kind === 'twilio' && <>
        <Field label="Account SID" hint="Starts with AC — on the Twilio console home page."><input className="text-input" value={f.accountSid ?? ''} onChange={(e) => set('accountSid', e.target.value)} autoComplete="off" /></Field>
        <Field label="Auth token"><input className="text-input" type="password" value={f.authToken ?? ''} placeholder={secretPh('authToken')} onChange={(e) => set('authToken', e.target.value)} autoComplete="new-password" /></Field>
        <div className="field-row">
          <Field label="From (your Twilio number)"><input className="text-input" value={f.from ?? ''} placeholder="+15551234567" onChange={(e) => set('from', e.target.value)} /></Field>
          <Field label="…or Messaging Service SID (optional)"><input className="text-input" value={f.messagingServiceSid ?? ''} onChange={(e) => set('messagingServiceSid', e.target.value)} /></Field>
        </div>
        <Field label="Send to" hint="Your mobile, international format. Several separated by commas. A Twilio trial account can only text numbers you have verified in Twilio."><input className="text-input" value={f.to ?? ''} placeholder="+61400000000" onChange={(e) => set('to', e.target.value)} /></Field>
      </>}

      {kind === 'sms_gateway' && <>
        <Field label="Phone app"><select className="text-input" value={f.preset ?? 'custom'} onChange={(e) => choosePreset(e.target.value)}>
          {Object.entries(presets).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}</select>
          {presets[f.preset ?? '']?.note && <div className="hint">{presets[f.preset!].note}</div>}</Field>
        <Field label="Address of the phone's server" hint="The phone and this server must reach each other (same Wi-Fi/LAN, a VPN such as Tailscale, or a tunnel).">
          <input className="text-input" value={f.url ?? ''} placeholder={presets[f.preset ?? '']?.urlHint ?? 'http://192.168.1.50:8080/message'} onChange={(e) => set('url', e.target.value)} /></Field>
        <div className="field-row">
          <Field label="Method"><select className="text-input" value={f.method ?? 'POST'} onChange={(e) => set('method', e.target.value)}><option>POST</option><option>PUT</option><option>GET</option></select></Field>
          <Field label="Body type"><select className="text-input" value={f.contentType ?? 'json'} onChange={(e) => set('contentType', e.target.value)}><option value="json">JSON</option><option value="form">Form</option></select></Field>
        </div>
        <Field label="Body template" hint="{{to}} is replaced by the phone number and {{message}} by the alert text."><textarea className="text-input" rows={3} value={f.bodyTemplate ?? ''} onChange={(e) => set('bodyTemplate', e.target.value)} /></Field>
        <div className="field-row">
          <Field label="Username (if the app asks)"><input className="text-input" value={f.username ?? ''} onChange={(e) => set('username', e.target.value)} autoComplete="off" /></Field>
          <Field label="Password"><input className="text-input" type="password" value={f.password ?? ''} placeholder={secretPh('password')} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" /></Field>
          <Field label="…or bearer token"><input className="text-input" type="password" value={f.token ?? ''} placeholder={secretPh('token')} onChange={(e) => set('token', e.target.value)} autoComplete="new-password" /></Field>
        </div>
        <Field label="Send to" hint="Your mobile, international format. Several separated by commas."><input className="text-input" value={f.to ?? ''} placeholder="+61400000000" onChange={(e) => set('to', e.target.value)} /></Field>
      </>}

      {kind === 'telegram' && <>
        <Field label="Bot token" hint="Create a bot by chatting with @BotFather in Telegram (/newbot); it gives you the token."><input className="text-input" type="password" value={f.botToken ?? ''} placeholder={secretPh('botToken')} onChange={(e) => set('botToken', e.target.value)} autoComplete="new-password" /></Field>
        <Field label="Chat id" hint="Send any message to your bot first, then press Find my chat.">
          <div className="field-row">
            <input className="text-input" value={f.chatId ?? ''} onChange={(e) => set('chatId', e.target.value)} placeholder="123456789" />
            <button className="btn" type="button" onClick={() => void findChat()} disabled={!f.botToken && !secretSet('botToken')}>Find my chat</button>
          </div>
          {chats && (chats.length === 0 ? <div className="hint">No chats yet — message your bot in Telegram, then try again.</div>
            : <div className="field-row">{chats.map((c) => <button key={c.id} className="btn small" type="button" onClick={() => set('chatId', c.id)}>{c.name} ({c.id})</button>)}</div>)}
        </Field>
      </>}

      {isAdmin && !editing && <label className="check-row"><input type="checkbox" checked={team} onChange={(e) => setTeam(e.target.checked)} /> Also use for the whole team (alerts about shared mailboxes and server problems)</label>}
      {err && <div className="alert-error" role="alert"><WarningIcon size={14} /> {err}</div>}
      {ssrfHost && <div className="hint">This is a private address. <button className="btn small" type="button" onClick={() => void allowHost()}>Allow {ssrfHost}</button> (administrators only), then save again.</div>}
      <div className="field-row">
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Sending test…' : 'Save and send test'}</button>
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}

/** Picker + editor, used on the settings tab and in the first-run wizard. */
export function AddChannel({ data, onDone, onCancel, isAdmin }: { data: ChannelsResp; onDone: (c: Channel) => void; onCancel?: () => void; isAdmin: boolean }) {
  const [kind, setKind] = useState<Kind | null>(null);
  if (!kind) {
    return (
      <div className="alert-kinds">
        {data.kinds.map((k) => (
          <button key={k.kind} className="alert-kind" onClick={() => setKind(k.kind)}>
            <strong>{KIND_LABEL[k.kind]}</strong><span>{KIND_HELP[k.kind]}</span>
          </button>
        ))}
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    );
  }
  return <ChannelEditor kind={kind} presets={data.presets} editing={null} isAdmin={isAdmin} onDone={onDone} onCancel={() => { if (onCancel) onCancel(); setKind(null); }} />;
}

export function useChannels() {
  const [data, setData] = useState<ChannelsResp | null>(null);
  const load = useCallback(async () => {
    setData(await api.get<ChannelsResp>('/api/alert-channels'));
    void useAlerts.getState().refresh();
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { data, load };
}

/** Shown to a brand-new administrator right after setup, until one channel has passed its test. */
export function AlertsSetup() {
  const { data, load } = useChannels();
  const refresh = useSession((s) => s.init);
  const [adding, setAdding] = useState(true);
  const logout = useSession((s) => s.logout);
  if (!data) return null;
  const done = data.hasVerified;
  return (
    <div className="login-wrap">
      <div className="login-card alert-setup" style={{ maxWidth: 640 }}>
        <h1>Step 2 of 2 — Alerts</h1>
        <p>Seamless runs your mail. If a mailbox stops working you need to hear about it <strong>fast</strong>, and not only by email (the email may be exactly what is broken).</p>
        <p><strong>Set up at least one way to be told</strong> — a text message, a Telegram message, or an email to another address — and send a test. This step cannot be skipped until a test has worked. You can add more later in Settings → Alerts.</p>
        {data.items.filter((c) => c.mine).map((c) => <div key={c.id} className={`alert-chan ${c.verifiedAt ? 'ok' : ''}`}><strong>{c.name}</strong> — {c.verifiedAt ? 'test passed ✓' : <span>not tested yet{c.lastError ? `: ${c.lastError}` : ''}</span>}</div>)}
        {adding && !done && <AddChannel data={data} isAdmin onDone={() => { void load(); setAdding(true); }} />}
        {!done && !adding && <button className="btn" onClick={() => setAdding(true)}>Add a channel</button>}
        {done && (
          <div className="field-row">
            <button className="btn primary" onClick={() => void refresh()}>Finish — take me to my mail</button>
            <span className="hint">More channels can be added later in Settings → Alerts.</span>
          </div>
        )}
        <button className="link-btn" onClick={() => void logout()}>Sign out</button>
      </div>
    </div>
  );
}

export default function AlertsSettings() {
  const { data, load } = useChannels();
  const isAdmin = useSession((s) => s.user?.role === 'admin');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [log, setLog] = useState<AppAlert[]>([]);
  const [busy, setBusy] = useState<string>('');

  const loadAll = useCallback(async () => {
    await load();
    setSettings((await api.get<{ settings: Settings }>('/api/alerts/settings')).settings);
    setLog((await api.get<{ items: AppAlert[] }>('/api/alerts?all=1')).items);
  }, [load]);
  useEffect(() => { void loadAll(); }, [loadAll]);

  if (!data) return <div>Loading…</div>;

  const test = async (c: Channel) => {
    setBusy(`t${c.id}`);
    try {
      const r = await api.post<{ ok: boolean; error?: string }>(`/api/alert-channels/${c.id}/test`);
      toast(r.ok ? 'Test message sent' : `Test failed: ${r.error}`, r.ok ? 'info' : 'error');
    } finally { setBusy(''); void loadAll(); }
  };
  const toggle = async (c: Channel) => { await api.put(`/api/alert-channels/${c.id}`, { enabled: !c.enabled }); void loadAll(); };
  const remove = async (c: Channel) => { if (confirm(`Delete the channel "${c.name}"?`)) { await api.del(`/api/alert-channels/${c.id}`); void loadAll(); } };
  const saveSettings = async (patch: Partial<Settings>) => { setSettings((await api.put<{ settings: Settings }>('/api/alerts/settings', patch)).settings); };
  const sendTest = async () => {
    setBusy('alert');
    try { await api.post('/api/alerts/test'); toast('Test alert raised — it should reach every channel and appear in the bell'); }
    catch (e: any) { toast(e.message, 'error'); } finally { setBusy(''); void loadAll(); }
  };
  const num = (k: keyof Settings, label: string, hint: string, unit: string) => settings && (
    <div className="field"><label>{label}</label>
      <div className="field-row"><input className="text-input" style={{ maxWidth: 110 }} type="number" min={0} value={settings[k]} disabled={!isAdmin}
        onChange={(e) => setSettings({ ...settings, [k]: Number(e.target.value) })} onBlur={() => void saveSettings({ [k]: settings[k] })} /> <span>{unit}</span></div>
      <div className="hint">{hint}</div></div>
  );

  return (
    <>
      <h2>Alerts</h2>
      <p>When a mailbox stops working, Seamless sends a <strong>critical alert</strong> to the channels below, and shows it in red at the top of your notifications until it is fixed or you mark it read. <a href={MANUAL} target="_blank" rel="noreferrer">Read the guide</a>.</p>
      {!data.hasVerified && <div className="alert-banner" role="alert"><WarningIcon size={16} /> No alert channel has passed its test — you will not be told if a mailbox stops working.</div>}

      <div className="settings-section">
        <h3>Channels</h3>
        {data.items.length === 0 && <p className="hint">None yet.</p>}
        {data.items.map((c) => (
          <div key={c.id} className={`alert-chan ${c.verifiedAt ? 'ok' : 'bad'}`}>
            <div className="alert-chan-main">
              <strong>{c.name}</strong> <span className="chip">{KIND_LABEL[c.kind]}</span>{c.scope === 'team' && <span className="chip">Whole team</span>}{!c.mine && <span className="chip">Set by an admin</span>}
              <div className="hint">{c.summary}</div>
              <div className="hint">{c.verifiedAt ? `Test passed ${relTime(c.verifiedAt)} ago` : 'Not set up yet — send a test'}{!c.enabled && ' · switched off'}</div>
              {c.lastError && <div className="alert-error"><WarningIcon size={14} /> Last problem: {c.lastError}</div>}
            </div>
            {c.mine && (
              <div className="alert-chan-actions">
                <button className="btn" disabled={busy === `t${c.id}`} onClick={() => void test(c)}>Send test</button>
                <button className="btn" onClick={() => { setEditing(c); setAdding(false); }}>Edit</button>
                <button className="btn" onClick={() => void toggle(c)}>{c.enabled ? 'Turn off' : 'Turn on'}</button>
                <button className="icon-btn" title="Delete" aria-label="Delete channel" onClick={() => void remove(c)}><TrashIcon size={16} /></button>
              </div>
            )}
          </div>
        ))}
        {editing && <ChannelEditor kind={editing.kind} presets={data.presets} editing={editing} isAdmin={!!isAdmin} onDone={() => { setEditing(null); void loadAll(); }} onCancel={() => setEditing(null)} />}
        {adding ? <AddChannel data={data} isAdmin={!!isAdmin} onDone={() => { setAdding(false); void loadAll(); }} onCancel={() => setAdding(false)} />
          : !editing && <button className="btn primary" onClick={() => setAdding(true)}>Add a channel</button>}
      </div>

      <div className="settings-section">
        <h3>Try it</h3>
        <p className="hint">Raises a pretend alert that goes through every channel and shows in the bell, then counts as fixed.</p>
        <button className="btn" disabled={busy === 'alert'} onClick={() => void sendTest()}>Send test alert</button>
      </div>

      {settings && (
        <div className="settings-section">
          <h3>When to alert{!isAdmin && <span className="hint"> (set by an administrator)</span>}</h3>
          {num('syncFailures', 'A mailbox fails to sync', 'In a row, before it counts as stopped.', 'times')}
          {num('syncStaleMinutes', '…or has not synced successfully for', 'While it is failing.', 'minutes')}
          {num('sendFailures', 'Sending fails', 'Messages that failed to send within one hour.', 'messages')}
          {num('quotaPercent', 'Storage almost full', 'Percent of the storage limit.', '%')}
          {num('pushSilentHours', 'A Cloudflare inbox goes silent', 'Hours without any mail, for an inbox that normally receives mail. 0 = do not check.', 'hours')}
          {num('reminderHours', 'Remind me again every', 'While the problem is still there and the alert unread. 0 = never. Quiet hours do not apply to critical alerts.', 'hours')}
        </div>
      )}

      <div className="settings-section">
        <h3>Recent alerts</h3>
        {log.length === 0 && <p className="hint">Nothing has gone wrong. 🎉</p>}
        {log.slice(0, 20).map((a) => (
          <div key={a.id} className="alert-log">
            <strong>{a.title}</strong> <span className={`chip ${a.state === 'open' ? 'bad' : ''}`}>{a.state === 'open' ? 'Open' : 'Fixed'}</span>
            <div className="hint">{new Date(a.openedAt).toLocaleString()} · sent {a.sendCount}×{a.deliveries.length ? ' · ' + a.deliveries.map((d) => `${d.name}: ${d.ok ? 'ok' : `failed (${d.error})`}`).join('; ') : ' · no channel was set up'}</div>
          </div>
        ))}
      </div>
    </>
  );
}
