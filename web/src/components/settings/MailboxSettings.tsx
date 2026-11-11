/**
 * Settings → Mailboxes (T1 F-09). Tab 1: a card per mailbox (status, categories, last sync)
 * and the add/edit wizard. Tab 2: the category manager (rename, recolour, reorder, drag
 * mailboxes between categories).
 */
import { useEffect, useMemo, useState } from 'react';
import type { TestStep, ApiCategory, ApiTransport } from '@seamless/shared';
import { api } from '../../api/client.ts';
import { toast } from '../../toast.ts';
import { useMail } from '../../state/mail.ts';
import { useCompose } from '../../state/compose.ts';
import PushInboxSetup, { PushPanel } from './PushInboxSetup.tsx';
import { SharePanel } from './SharePanel.tsx';
import { OauthSection, SafeDeletePanel, GmailLearnPanel } from './AccountSettings.tsx';
import { CategoryGlyph, CATEGORY_ICON_NAMES } from '../CategoryGlyph.tsx';
import { CheckIcon, CloseIcon, WarningIcon, PlusSimpleIcon, CaretUpIcon, CaretDownIcon, TrashIcon, PencilIcon, DragIcon } from '../../icons.tsx';

// ---- provider presets (step 2) ----

interface Preset { id: string; name: string; imap: [string, number, boolean]; smtp: [string, number, boolean]; oauth?: 'google' | 'microsoft'; note?: string }

const PRESETS: Preset[] = [
  { id: 'gmail', name: 'Gmail / Google Workspace', imap: ['imap.gmail.com', 993, true], smtp: ['smtp.gmail.com', 465, true], oauth: 'google', note: 'Use “Connect Gmail” (OAuth), or an app password with IMAP.' },
  { id: 'outlook', name: 'Outlook / Microsoft 365', imap: ['outlook.office365.com', 993, true], smtp: ['smtp.office365.com', 587, false], oauth: 'microsoft', note: 'Microsoft blocks passwords for most accounts: use “Connect Microsoft”.' },
  { id: 'icloud', name: 'iCloud Mail', imap: ['imap.mail.me.com', 993, true], smtp: ['smtp.mail.me.com', 587, false], note: 'Needs an app-specific password from appleid.apple.com.' },
  { id: 'fastmail', name: 'Fastmail', imap: ['imap.fastmail.com', 993, true], smtp: ['smtp.fastmail.com', 465, true], note: 'Use an app password from Fastmail settings.' },
  { id: 'zoho', name: 'Zoho Mail', imap: ['imap.zoho.com', 993, true], smtp: ['smtp.zoho.com', 465, true] },
  { id: 'yahoo', name: 'Yahoo Mail', imap: ['imap.mail.yahoo.com', 993, true], smtp: ['smtp.mail.yahoo.com', 465, true], note: 'Needs an app password.' },
];

function detectPreset(email: string): Preset | null {
  const d = email.split('@')[1]?.toLowerCase() ?? '';
  if (/^(gmail|googlemail)\.com$/.test(d)) return PRESETS[0];
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(d)) return PRESETS[1];
  if (/^(icloud|me|mac)\.com$/.test(d)) return PRESETS[2];
  if (/^fastmail\.(com|fm)$/.test(d)) return PRESETS[3];
  if (/^zoho(mail)?\.[a-z.]+$/.test(d)) return PRESETS[4];
  if (/^(yahoo|ymail)\.[a-z.]+$/.test(d)) return PRESETS[5];
  return null;
}

// ---- wizard ----

interface Form {
  id?: number; kind?: string; enabled: boolean; outboundTransportId?: number | null;
  inboundKind: 'imap' | 'pop3';
  pop3Host: string; pop3Port: number; pop3Secure: boolean; pop3User: string; pop3Pass: string;
  pop3IntervalMin: number; pop3LeaveOnServer: boolean; pop3DeleteAfterDays: number | '';
  name: string; email: string; color: string;
  imapHost: string; imapPort: number; imapSecure: boolean; imapUser: string; imapPass: string;
  smtpHost: string; smtpPort: number; smtpSecure: boolean; smtpUser: string; smtpPass: string; smtpSameLogin: boolean;
  categoryIds: number[]; signature: string; aliases: string; sentCopy: boolean; aiCategorize: boolean; healthIgnored: boolean;
}

const COLORS = ['#2f7ed8', '#7a5fd0', '#d05f8e', '#d0755f', '#c9a13a', '#4d9e53', '#3a9e9e', '#5b6570', '#a85d24', '#151f2e'];

const BLANK: Form = {
  enabled: true, name: '', email: '', color: COLORS[0], inboundKind: 'imap',
  pop3Host: '', pop3Port: 995, pop3Secure: true, pop3User: '', pop3Pass: '', pop3IntervalMin: 5, pop3LeaveOnServer: true, pop3DeleteAfterDays: '',
  imapHost: '', imapPort: 993, imapSecure: true, imapUser: '', imapPass: '',
  smtpHost: '', smtpPort: 465, smtpSecure: true, smtpUser: '', smtpPass: '', smtpSameLogin: true,
  categoryIds: [], signature: '', aliases: '', sentCopy: true, aiCategorize: false, healthIgnored: false,
};

const POP3_PRESETS = [
  { name: 'Gmail POP', host: 'pop.gmail.com', note: 'Gmail needs POP switched on in its settings and an app password.' },
  { name: 'Outlook POP', host: 'outlook.office365.com', note: 'Outlook.com POP needs an app password; Microsoft 365 often blocks it.' },
];

const STEPS = ['Address', 'Provider', 'Incoming', 'Outgoing', 'Test', 'Categories', 'Identity'];

const STEP_LABEL: Record<TestStep['step'], string> = { dns: 'DNS', tcp: 'Connect', tls: 'Security (TLS)', auth: 'Sign in', folders: 'List folders', send: 'Send test message' };

function TestResult({ steps, busy }: { steps: TestStep[] | null; busy: boolean }) {
  if (busy) return <div className="dim">Testing…</div>;
  if (!steps) return null;
  return (
    <ol className="test-steps">
      {steps.map((s) => (
        <li key={s.step} className={s.ok ? 'ok' : 'fail'}>
          <span className="test-mark">{s.ok ? <CheckIcon size={14} weight="bold" /> : <WarningIcon size={14} weight="fill" />}</span>
          <span className="test-name">{STEP_LABEL[s.step]}</span>
          <span className="test-detail">{s.detail}</span>
          <span className="test-ms">{s.ms} ms</span>
        </li>
      ))}
    </ol>
  );
}

function Wizard({ initial, categories, onDone }: { initial: Form; categories: ApiCategory[]; onDone: (saved: boolean) => void }) {
  const [f, setF] = useState<Form>(initial);
  const [step, setStep] = useState(initial.id ? 2 : 0);
  const [busy, setBusy] = useState(false);
  const [inTest, setInTest] = useState<{ steps: TestStep[] | null; busy: boolean }>({ steps: null, busy: false });
  const [outTest, setOutTest] = useState<{ steps: TestStep[] | null; busy: boolean }>({ steps: null, busy: false });
  const [sendTest, setSendTest] = useState(false);
  const preset = useMemo(() => detectPreset(f.email), [f.email]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const editing = !!f.id;
  const [transports, setTransports] = useState<ApiTransport[]>([]);
  useEffect(() => { if (initial.id) void api.get<ApiTransport[]>('/api/transports').then(setTransports).catch(() => {}); }, [initial.id]);
  const chooseTransport = async (v: string) => {
    const id = v ? Number(v) : null;
    try { await api.put(`/api/accounts/${f.id}/transport`, { transportId: id }); set('outboundTransportId', id); }
    catch { toast('Could not change that', 'error'); }
  };

  const applyPreset = (p: Preset | null) => {
    const local = f.email.trim();
    const domain = local.split('@')[1] ?? '';
    setF((x) => ({
      ...x,
      imapHost: p ? p.imap[0] : (x.imapHost || (domain ? `mail.${domain}` : '')), imapPort: p ? p.imap[1] : x.imapPort, imapSecure: p ? p.imap[2] : x.imapSecure,
      smtpHost: p ? p.smtp[0] : (x.smtpHost || (domain ? `mail.${domain}` : '')), smtpPort: p ? p.smtp[1] : x.smtpPort, smtpSecure: p ? p.smtp[2] : x.smtpSecure,
      imapUser: x.imapUser || local, smtpUser: x.smtpUser || local,
    }));
  };

  const body = () => ({
    ...f,
    smtpUser: f.smtpSameLogin ? (f.inboundKind === 'pop3' ? f.pop3User : f.imapUser) : f.smtpUser,
    smtpPass: f.smtpSameLogin ? (f.inboundKind === 'pop3' ? f.pop3Pass : f.imapPass) : f.smtpPass,
    pop3DeleteAfterDays: f.pop3LeaveOnServer && f.pop3DeleteAfterDays ? Number(f.pop3DeleteAfterDays) : null,
    aliases: f.aliases.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
    accountId: f.id,
  });

  const testIn = async () => {
    setInTest({ steps: null, busy: true });
    try { const r = await api.post<{ steps: TestStep[] }>(f.inboundKind === 'pop3' ? '/api/accounts/test/pop3' : '/api/accounts/test/incoming', body()); setInTest({ steps: r.steps, busy: false }); }
    catch (e: any) { setInTest({ steps: [{ step: 'tcp', ok: false, ms: 0, detail: e?.message ?? 'failed' }], busy: false }); }
  };
  const testOut = async () => {
    setOutTest({ steps: null, busy: true });
    try { const r = await api.post<{ steps: TestStep[] }>('/api/accounts/test/outgoing', { ...body(), sendTest }); setOutTest({ steps: r.steps, busy: false }); }
    catch (e: any) { setOutTest({ steps: [{ step: 'tcp', ok: false, ms: 0, detail: e?.message ?? 'failed' }], busy: false }); }
  };

  const save = async () => {
    if (!/^[^@\s]+@[^@\s]+$/.test(f.email)) { toast('Enter a valid email address', 'error'); setStep(0); return; }
    if ((f.inboundKind === 'pop3' ? !f.pop3Host : !f.imapHost) || !f.smtpHost) { toast('Fill in the incoming and outgoing servers', 'error'); setStep(2); return; }
    setBusy(true);
    try {
      if (f.id) await api.put(`/api/accounts/${f.id}`, body());
      else await api.post('/api/accounts', body());
      toast(f.id ? 'Mailbox saved' : 'Mailbox added — syncing now');
      onDone(true);
    } catch (e: any) { toast(e?.message ?? 'Save failed', 'error'); }
    finally { setBusy(false); }
  };

  const isOauth = f.kind === 'gmail' || f.kind === 'microsoft';

  return (
    <div className="wizard">
      <div className="wizard-head">
        <h2>{editing ? `Edit ${f.email}` : 'Add a mailbox'}</h2>
        <button className="icon-btn" onClick={() => onDone(false)} aria-label="Close"><CloseIcon /></button>
      </div>
      <ol className="stepper">
        {STEPS.map((s, i) => (
          <li key={s}><button className={`step ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`} onClick={() => setStep(i)}>
            <span className="step-num">{i < step ? <CheckIcon size={12} weight="bold" /> : i + 1}</span>{s}
          </button></li>
        ))}
      </ol>

      <div className="wizard-body">
        {step === 0 && (
          <>
            <div className="field"><label>Email address</label>
              <input className="text-input" autoFocus value={f.email} placeholder="you@business.com" onChange={(e) => set('email', e.target.value.trim())} /></div>
            <div className="field"><label>Display name (shown to recipients)</label>
              <input className="text-input" value={f.name} placeholder="Sam from Acme" onChange={(e) => set('name', e.target.value)} /></div>
            <div className="field"><label>Colour (marks this mailbox in lists)</label>
              <div className="swatches">
                {COLORS.map((c) => <button key={c} className={`swatch ${f.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set('color', c)} aria-label={c} />)}
                <input type="color" value={f.color} onChange={(e) => set('color', e.target.value)} aria-label="Custom colour" />
              </div>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <p className="settings-desc">{preset ? <>Detected <b>{preset.name}</b> from the address.</> : 'Pick your provider, or choose “Other” to enter the servers yourself.'}</p>
            <div className="provider-grid">
              {PRESETS.map((p) => (
                <button key={p.id} className={`provider-card ${preset?.id === p.id ? 'on' : ''}`} onClick={() => { applyPreset(p); setStep(2); }}>
                  <strong>{p.name}</strong>
                  <span className="dim">{p.imap[0]}</span>
                </button>
              ))}
              <button className="provider-card" onClick={() => { applyPreset(null); setStep(2); }}><strong>Other (IMAP/SMTP)</strong><span className="dim">enter servers manually</span></button>
            </div>
            {preset?.note && <p className="hint">{preset.note}</p>}
            {preset?.oauth && <OauthSection onConnected={() => onDone(true)} />}
          </>
        )}

        {step === 2 && (
          <>
            <div className="seg" role="group" aria-label="How mail arrives">
              <button className={`seg-btn ${f.inboundKind === 'imap' ? 'on' : ''}`} disabled={editing} onClick={() => set('inboundKind', 'imap')}>IMAP</button>
              <button className={`seg-btn ${f.inboundKind === 'pop3' ? 'on' : ''}`} disabled={editing || isOauth} onClick={() => setF((x) => ({ ...x, inboundKind: 'pop3', pop3User: x.pop3User || x.email.trim() }))}>POP3</button>
              <button className="seg-btn" disabled title="Delivered to Seamless (Cloudflare / own domain) arrives in tier 3">Pushed · coming in T3</button>
            </div>
            {f.inboundKind === 'pop3' ? (
              <>
                <p className="settings-desc">POP3 downloads new mail into Seamless; folders and read state stay in Seamless only. Presets:{' '}
                  {POP3_PRESETS.map((pr) => <button key={pr.name} className="btn ghost" onClick={() => setF((x) => ({ ...x, pop3Host: pr.host, pop3Port: 995, pop3Secure: true, pop3User: x.pop3User || x.email.trim() }))} title={pr.note}>{pr.name}</button>)}
                </p>
                <div className="field-row">
                  <div className="field" style={{ flex: 2 }}><label>POP3 server</label><input className="text-input" value={f.pop3Host} placeholder="pop.example.com" onChange={(e) => set('pop3Host', e.target.value.trim())} /></div>
                  <div className="field"><label>Port</label><input className="text-input" type="number" value={f.pop3Port} onChange={(e) => set('pop3Port', Number(e.target.value))} /></div>
                  <div className="field"><label>Security</label>
                    <select className="text-input" value={f.pop3Secure ? 'tls' : 'starttls'} onChange={(e) => { const tls = e.target.value === 'tls'; setF((x) => ({ ...x, pop3Secure: tls, pop3Port: tls ? 995 : 110 })); }}>
                      <option value="tls">SSL/TLS</option><option value="starttls">STARTTLS / none</option>
                    </select></div>
                </div>
                <div className="field-row">
                  <div className="field"><label>Username</label><input className="text-input" value={f.pop3User} onChange={(e) => set('pop3User', e.target.value)} /></div>
                  <div className="field"><label>Password {editing ? '(blank keeps the saved one)' : ''}</label><input className="text-input" type="password" value={f.pop3Pass} onChange={(e) => set('pop3Pass', e.target.value)} /></div>
                </div>
                <div className="field-row">
                  <div className="field"><label>Check every (minutes)</label><input className="text-input" type="number" min={1} value={f.pop3IntervalMin} onChange={(e) => set('pop3IntervalMin', Math.max(1, Number(e.target.value) || 1))} /></div>
                  <div className="field"><label>Delete from server after (days)</label><input className="text-input" type="number" min={1} value={f.pop3DeleteAfterDays} disabled={!f.pop3LeaveOnServer} placeholder="never" onChange={(e) => set('pop3DeleteAfterDays', e.target.value ? Number(e.target.value) : '')} /></div>
                </div>
                <label className="checkbox-line"><input type="checkbox" checked={f.pop3LeaveOnServer} onChange={(e) => set('pop3LeaveOnServer', e.target.checked)} /> Leave messages on the server (otherwise each one is deleted once Seamless has stored it)</label>
              </>
            ) : isOauth ? <p className="settings-desc">This mailbox signs in with {f.kind === 'gmail' ? 'Google' : 'Microsoft'} (OAuth); there's no password to enter.</p> : (
              <>
                <div className="field-row">
                  <div className="field" style={{ flex: 2 }}><label>IMAP server</label><input className="text-input" value={f.imapHost} placeholder="imap.example.com" onChange={(e) => set('imapHost', e.target.value.trim())} /></div>
                  <div className="field"><label>Port</label><input className="text-input" type="number" value={f.imapPort} onChange={(e) => set('imapPort', Number(e.target.value))} /></div>
                  <div className="field"><label>Security</label>
                    <select className="text-input" value={f.imapSecure ? 'tls' : 'starttls'} onChange={(e) => { const tls = e.target.value === 'tls'; setF((x) => ({ ...x, imapSecure: tls, imapPort: tls ? 993 : 143 })); }}>
                      <option value="tls">SSL/TLS</option><option value="starttls">STARTTLS / none</option>
                    </select></div>
                </div>
                <div className="field-row">
                  <div className="field"><label>Username</label><input className="text-input" value={f.imapUser} onChange={(e) => set('imapUser', e.target.value)} /></div>
                  <div className="field"><label>Password {editing ? '(blank keeps the saved one)' : ''}</label><input className="text-input" type="password" value={f.imapPass} onChange={(e) => set('imapPass', e.target.value)} /></div>
                </div>
              </>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <div className="seg" role="group" aria-label="How mail leaves">
              <button className="seg-btn on">SMTP server</button>
              <button className="seg-btn" disabled title="SendGrid, Brevo, SES, Mailgun, Postmark, Cloudflare arrive in tier 3">Sending service · coming in T3</button>
            </div>
            {!isOauth && (
              <>
                <div className="field-row">
                  <div className="field" style={{ flex: 2 }}><label>SMTP server</label><input className="text-input" value={f.smtpHost} placeholder="smtp.example.com" onChange={(e) => set('smtpHost', e.target.value.trim())} /></div>
                  <div className="field"><label>Port</label><input className="text-input" type="number" value={f.smtpPort} onChange={(e) => set('smtpPort', Number(e.target.value))} /></div>
                  <div className="field"><label>Security</label>
                    <select className="text-input" value={f.smtpSecure ? 'tls' : 'starttls'} onChange={(e) => { const tls = e.target.value === 'tls'; setF((x) => ({ ...x, smtpSecure: tls, smtpPort: tls ? 465 : 587 })); }}>
                      <option value="tls">SSL/TLS</option><option value="starttls">STARTTLS / none</option>
                    </select></div>
                </div>
                <label className="checkbox-line"><input type="checkbox" checked={f.smtpSameLogin} onChange={(e) => set('smtpSameLogin', e.target.checked)} /> Same username and password as incoming</label>
                {!f.smtpSameLogin && (
                  <div className="field-row">
                    <div className="field"><label>Username</label><input className="text-input" value={f.smtpUser} onChange={(e) => set('smtpUser', e.target.value)} /></div>
                    <div className="field"><label>Password {editing ? '(blank keeps the saved one)' : ''}</label><input className="text-input" type="password" value={f.smtpPass} onChange={(e) => set('smtpPass', e.target.value)} /></div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {step === 4 && (
          <div className="test-panels">
            <div className="test-panel">
              <div className="test-panel-head"><strong>Incoming</strong><span className="dim">{f.inboundKind === 'pop3' ? `${f.pop3Host}:${f.pop3Port}` : `${f.imapHost}:${f.imapPort}`}</span>
                <button className="btn" disabled={inTest.busy} onClick={() => void testIn()}>Test incoming</button></div>
              <TestResult {...inTest} />
            </div>
            <div className="test-panel">
              <div className="test-panel-head"><strong>Outgoing</strong><span className="dim">{f.smtpHost}:{f.smtpPort}</span>
                <button className="btn" disabled={outTest.busy} onClick={() => void testOut()}>Test outgoing</button></div>
              <label className="checkbox-line"><input type="checkbox" checked={sendTest} onChange={(e) => setSendTest(e.target.checked)} /> Also send a test message to {f.email || 'this address'}</label>
              <TestResult {...outTest} />
            </div>
          </div>
        )}

        {step === 5 && (
          <>
            <p className="settings-desc">Which categories should this mailbox appear in? Unified always shows everything.</p>
            <div className="cat-checks">
              {categories.map((c) => (
                <label key={c.id} className="cat-check">
                  <input type="checkbox" checked={f.categoryIds.includes(c.id)}
                    onChange={(e) => set('categoryIds', e.target.checked ? [...f.categoryIds, c.id] : f.categoryIds.filter((x) => x !== c.id))} />
                  <span style={{ color: c.color }}><CategoryGlyph icon={c.icon} size={18} /></span>{c.name}
                </label>
              ))}
            </div>
          </>
        )}

        {step === 6 && (
          <>
            <div className="field"><label>Signature</label>
              <textarea className="text-input" rows={4} value={f.signature} placeholder="Sam Smith · Acme Pty Ltd · 0400 000 000" onChange={(e) => set('signature', e.target.value)} /></div>
            <div className="field"><label>Aliases (other addresses that deliver here; replies go out from the one that received)</label>
              <input className="text-input" value={f.aliases} placeholder="info@acme.com, sales@acme.com" onChange={(e) => set('aliases', e.target.value)} /></div>
            {editing && (
              <div className="field"><label>Send through</label>
                <select className="text-input" value={f.outboundTransportId ?? ''} onChange={(e) => void chooseTransport(e.target.value)}>
                  <option value="">This mailbox’s own SMTP</option>
                  {transports.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                {transports.length === 0 && <p className="dim">Add providers under Settings → Sending.</p>}
              </div>
            )}
            <label className="checkbox-line"><input type="checkbox" checked={f.sentCopy} onChange={(e) => set('sentCopy', e.target.checked)} /> Save a copy in this mailbox's Sent folder (turn off for Gmail, which does it itself)</label>
            <label className="checkbox-line"><input type="checkbox" checked={f.aiCategorize} onChange={(e) => set('aiCategorize', e.target.checked)} /> AI-categorise incoming mail into labels (needs Settings → AI)</label>
            <label className="checkbox-line"><input type="checkbox" checked={f.healthIgnored} onChange={(e) => set('healthIgnored', e.target.checked)} /> Ignore this mailbox in health checks (the green status dot and “can’t connect” alerts skip it)</label>
            {editing && <label className="checkbox-line"><input type="checkbox" checked={!f.enabled} onChange={(e) => set('enabled', !e.target.checked)} /> Pause syncing this mailbox</label>}
          </>
        )}
      </div>

      <div className="wizard-foot">
        <button className="btn ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        <div style={{ flex: 1 }} />
        {step < STEPS.length - 1 && <button className="btn" onClick={() => { if (step === 0) applyPreset(preset); setStep(step + 1); }}>Next</button>}
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add mailbox'}</button>
      </div>
    </div>
  );
}

// ---- list ----

const STATUS: Record<string, [string, string]> = {
  ok: ['OK', 'ok'], connecting: ['Syncing', 'busy'], error: ['Error', 'error'], paused: ['Paused', 'muted'],
};

function ago(ms: number | null): string {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  return new Date(ms).toLocaleString();
}

function providerName(a: any): string {
  if (a.kind === 'gmail') return 'Gmail (OAuth)';
  if (a.kind === 'microsoft') return 'Microsoft (OAuth)';
  if (a.inboundKind === 'push') return `Push · ${(a.email ?? '').split('@')[1] ?? 'own domain'}`;
  if (a.inboundKind === 'pop3') return `POP3 · ${a.pop3Host}`;
  return detectPreset(a.email)?.name ?? `IMAP · ${a.imapHost}`;
}

function CategoryManager({ categories, mailboxes, reload }: { categories: ApiCategory[]; mailboxes: any[]; reload: () => void }) {
  const [editing, setEditing] = useState<{ id?: number; name: string; color: string; icon: string } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const saveCat = async () => {
    if (!editing?.name.trim()) return;
    try {
      if (editing.id) await api.put(`/api/categories/${editing.id}`, editing);
      else await api.post('/api/categories', editing);
      setEditing(null); reload();
    } catch (e: any) { toast(e?.message ?? 'Could not save', 'error'); }
  };
  const move = async (i: number, dir: -1 | 1) => {
    const ids = categories.map((c) => c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api.put('/api/categories/order', { ids });
    reload();
  };
  const setMembers = async (c: ApiCategory, accountIds: number[]) => {
    await api.put(`/api/categories/${c.id}/members`, { accountIds });
    reload();
  };
  const remove = async (c: ApiCategory) => {
    if (!window.confirm(`Delete the “${c.name}” category? Its mailboxes stay; they just leave this group.`)) return;
    await api.del(`/api/categories/${c.id}`);
    reload();
  };

  return (
    <div>
      <p className="settings-desc">Drag a mailbox onto a category to add it; a mailbox can sit in several. Unified always shows every mailbox. Order here is the order in the top-right switcher.</p>
      <div className="mbx-pool">
        <span className="dim">Mailboxes:</span>
        {mailboxes.map((m) => (
          <span key={m.id} className="mbx-chip" draggable onDragStart={(e) => e.dataTransfer.setData('text/x-account', String(m.id))}>
            <DragIcon size={12} /><span className="acct-dot" style={{ background: m.color }} />{m.name || m.email}
          </span>
        ))}
      </div>
      <div className="cat-cards">
        {categories.map((c, i) => (
          <div key={c.id} className={`cat-card ${dragOver === c.id ? 'drop' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(c.id); }} onDragLeave={() => setDragOver(null)}
            onDrop={(e) => {
              e.preventDefault(); setDragOver(null);
              const id = Number(e.dataTransfer.getData('text/x-account'));
              if (id && !c.accountIds.includes(id)) void setMembers(c, [...c.accountIds, id]);
            }}>
            <div className="cat-card-head">
              <span style={{ color: c.color }}><CategoryGlyph icon={c.icon} size={20} /></span>
              <strong>{c.name}</strong>{c.builtin && <span className="tag muted">built-in</span>}
              <div style={{ flex: 1 }} />
              <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => void move(i, -1)}><CaretUpIcon size={15} /></button>
              <button className="icon-btn" title="Move down" disabled={i === categories.length - 1} onClick={() => void move(i, 1)}><CaretDownIcon size={15} /></button>
              <button className="icon-btn" title="Edit" onClick={() => setEditing({ id: c.id, name: c.name, color: c.color, icon: c.icon })}><PencilIcon size={15} /></button>
              {!c.builtin && <button className="icon-btn" title="Delete" onClick={() => void remove(c)}><TrashIcon size={15} /></button>}
            </div>
            <div className="cat-members">
              {c.accountIds.length === 0 && <span className="dim">Drop mailboxes here</span>}
              {c.accountIds.map((id) => {
                const m = mailboxes.find((x) => x.id === id);
                return m ? (
                  <span key={id} className="mbx-chip">
                    <span className="acct-dot" style={{ background: m.color }} />{m.name || m.email}
                    <button className="chip-x" aria-label="Remove" onClick={() => void setMembers(c, c.accountIds.filter((x) => x !== id))}>×</button>
                  </span>
                ) : null;
              })}
            </div>
          </div>
        ))}
      </div>
      {editing ? (
        <div className="cat-edit">
          <div className="field-row">
            <div className="field"><label>Name</label><input className="text-input" autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></div>
            <div className="field" style={{ maxWidth: 110 }}><label>Colour</label><input type="color" className="text-input" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} /></div>
          </div>
          <div className="field"><label>Icon</label>
            <div className="icon-pick">
              {CATEGORY_ICON_NAMES.map((n) => (
                <button key={n} className={`icon-btn ${editing.icon === n ? 'active' : ''}`} onClick={() => setEditing({ ...editing, icon: n })} aria-label={n}><CategoryGlyph icon={n} size={18} /></button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => void saveCat()}>Save category</button>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn" onClick={() => setEditing({ name: '', color: '#6b7280', icon: 'folder' })}><PlusSimpleIcon size={15} /> New category</button>
      )}
    </div>
  );
}

export default function MailboxSettings() {
  const overview = useMail((s) => s.overview);
  const [tab, setTab] = useState<'mailboxes' | 'categories'>('mailboxes');
  const [accounts, setAccounts] = useState<any[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [panel, setPanel] = useState<{ kind: 'safe' | 'learn' | 'push' | 'share'; id: number } | null>(null);
  const [pushSetup, setPushSetup] = useState(false);

  const load = () => {
    void api.get<any[]>('/api/accounts').then(setAccounts).catch(() => {});
    void useMail.getState().refreshCategories();
  };
  useEffect(load, []);
  // status pills follow the live sync state
  useEffect(() => { const t = setInterval(() => void api.get<any[]>('/api/accounts').then(setAccounts).catch(() => {}), 10_000); return () => clearInterval(t); }, []);

  const categories = overview?.categories ?? [];

  const edit = (a?: any) => {
    if (!a) { setForm({ ...BLANK }); return; }
    setForm({
      ...BLANK, id: a.id, kind: a.kind, enabled: a.enabled, name: a.name, email: a.email, color: a.color,
      imapHost: a.imapHost, imapPort: a.imapPort, imapSecure: a.imapSecure, imapUser: a.imapUser,
      smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpSecure: a.smtpSecure, smtpUser: a.smtpUser,
      smtpSameLogin: a.inboundKind === 'pop3' ? a.smtpUser === a.pop3User : a.smtpUser === a.imapUser, categoryIds: a.categoryIds ?? [], signature: a.signature ?? '',
      aliases: (a.aliases ?? []).join(', '), sentCopy: a.sentCopy, aiCategorize: a.aiCategorize, healthIgnored: !!a.healthIgnored,
      outboundTransportId: a.outboundTransportId ?? null,
      inboundKind: a.inboundKind === 'pop3' ? 'pop3' : 'imap',
      ...(a.inboundKind === 'pop3' ? {
        pop3Host: a.pop3Host, pop3Port: a.pop3Port, pop3Secure: a.pop3Secure, pop3User: a.pop3User,
        pop3IntervalMin: a.pop3IntervalMin, pop3LeaveOnServer: a.pop3LeaveOnServer, pop3DeleteAfterDays: a.pop3DeleteAfterDays ?? '',
      } : {}),
    });
  };

  const remove = async (a: any) => {
    if (!window.confirm(`Remove ${a.email}? Its local copy in Seamless is deleted; the mailbox at the provider is untouched.`)) return;
    await api.del(`/api/accounts/${a.id}`);
    load();
    void useMail.getState().boot();
  };

  if (pushSetup) {
    return <PushInboxSetup onDone={(saved) => { setPushSetup(false); if (saved) { load(); setTimeout(() => { void useMail.getState().boot(); void useCompose.getState().loadIdentities(); }, 1200); } }} />;
  }

  if (form) {
    return <Wizard initial={form} categories={categories} onDone={(saved) => {
      setForm(null);
      if (saved) { load(); setTimeout(() => { void useMail.getState().boot(); void useCompose.getState().loadIdentities(); }, 1200); }
    }} />;
  }

  return (
    <div>
      <h2>Mailboxes</h2>
      <div className="tabs" role="tablist">
        <button role="tab" className={`tab ${tab === 'mailboxes' ? 'on' : ''}`} onClick={() => setTab('mailboxes')}>Mailboxes</button>
        <button role="tab" className={`tab ${tab === 'categories' ? 'on' : ''}`} onClick={() => setTab('categories')}>Categories</button>
      </div>

      {tab === 'categories' ? <CategoryManager categories={categories} mailboxes={accounts} reload={load} /> : (
        <>
          <p className="settings-desc">Each connected email account is a mailbox. Group them into categories (Work, Personal, Disposable…) and switch between them from the top-right.</p>
          <div className="mbx-cards">
            {accounts.map((a) => {
              const [label, cls] = STATUS[a.status] ?? STATUS.paused;
              return (
                <div key={a.id} className="mbx-card" style={{ borderLeftColor: a.color }}>
                  <div className="mbx-main">
                    <div className="mbx-title"><strong>{a.name || a.email}</strong><span className={`pill ${cls}`} title={a.lastError || undefined}>{label}</span></div>
                    <div className="dim">{a.email} · {providerName(a)}</div>
                    <div className="mbx-cats">
                      {(a.categoryIds ?? []).map((id: number) => {
                        const c = categories.find((x) => x.id === id);
                        return c ? <span key={id} className="cat-chip" style={{ borderColor: c.color, color: c.color }}><CategoryGlyph icon={c.icon} size={12} /> {c.name}</span> : null;
                      })}
                      {!(a.categoryIds ?? []).length && <span className="dim">No category</span>}
                    </div>
                    {a.status === 'error' && a.lastError && <div className="mbx-error"><WarningIcon size={13} /> {a.lastError}</div>}
                    <div className="dim small">Last sync {ago(a.lastSyncAt)}</div>
                  </div>
                  <div className="mbx-actions">
                    <button className="btn" onClick={() => edit(a)}>Edit</button>
                    {a.inboundKind === 'push' && <button className="btn ghost" onClick={() => setPanel(panel?.kind === 'push' && panel.id === a.id ? null : { kind: 'push', id: a.id })}>Cloudflare setup</button>}
                    <button className="btn ghost" onClick={() => setPanel(panel?.kind === 'share' && panel.id === a.id ? null : { kind: 'share', id: a.id })}>Share with…</button>
                    <button className="btn ghost" onClick={() => setPanel(panel?.kind === 'safe' && panel.id === a.id ? null : { kind: 'safe', id: a.id })}>Safe delete</button>
                    {a.kind === 'gmail' && <button className="btn ghost" onClick={() => setPanel(panel?.kind === 'learn' && panel.id === a.id ? null : { kind: 'learn', id: a.id })}>Learn</button>}
                    <button className="btn ghost danger" onClick={() => void remove(a)}>Remove</button>
                  </div>
                  {panel?.id === a.id && panel?.kind === 'safe' && <SafeDeletePanel account={a} onClose={() => setPanel(null)} onSaved={load} />}
                  {panel?.id === a.id && panel?.kind === 'share' && <SharePanel account={a} onClose={() => setPanel(null)} />}
                  {panel?.id === a.id && panel?.kind === 'push' && <PushPanel accountId={a.id} onClose={() => setPanel(null)} />}
                  {panel?.id === a.id && panel?.kind === 'learn' && <GmailLearnPanel account={a} onClose={() => setPanel(null)} />}
                </div>
              );
            })}
            {accounts.length === 0 && <div className="empty-state"><p>No mailboxes yet.</p></div>}
          </div>
          <button className="btn primary" onClick={() => edit()}><PlusSimpleIcon size={15} /> Add mailbox</button>{' '}
          <button className="btn" onClick={() => setPushSetup(true)}>Own domain (Cloudflare Email Routing)</button>
        </>
      )}
    </div>
  );
}
