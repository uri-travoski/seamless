import { create } from 'zustand';
import type { ApiTemplateRender, ApiBusiness, ComposePayload, ApiAddress, ApiEmail, ApiEmailBody, ApiIdentity, ApiTemplate } from '@seamless/shared';
import { fillTemplate } from './templates.ts';
import { api, sendMail, undoSendApi, matchIdentity, fetchIdentities, fetchIdentitySignature, fetchBody } from '../api/client.ts';
import { useSession } from './session.ts';
import { toast, countdownToast } from '../toast.ts';

export interface Draft {
  key: string;
  identity: ApiIdentity | null;
  to: ApiAddress[];
  cc: ApiAddress[];
  bcc: ApiAddress[];
  subject: string;
  initialHtml: string;
  inReplyTo?: string;
  replyToEmailId?: string;
  draftId?: string;
  attachments: { id: string; filename: string; size: number }[];
  track: boolean;
  perRecipientTracking: boolean;
  replyNotice?: string;        // T10.2: the mail came to a disposable address; the reply comes from the real identity
  followupDays?: number;       // T2 F-19: remind me if no reply in N days
  pgpSign?: boolean;           // T6.4 F-39
  pgpEncrypt?: boolean;
  smimeSign?: boolean;         // T6.5 F-39 (exclusive with the OpenPGP toggles)
  smimeEncrypt?: boolean;
  minimized: boolean;
  maximized: boolean;
}

interface ComposeState {
  windows: Draft[];
  identities: ApiIdentity[];
  businesses: ApiBusiness[];
  loadIdentities: () => Promise<void>;
  openBlank: () => Promise<void>;
  openTemplate: (t: ApiTemplate) => Promise<void>;
  openReply: (email: ApiEmail, mode: 'reply' | 'replyAll' | 'forward', template?: ApiTemplate) => Promise<void>;
  openFromPayload: (p: ComposePayload) => void;
  /** T5.4: quick reply to a lead — addressed to the lead's own email, sent as the business's identity. */
  openLead: (o: { to: ApiAddress[]; subject: string; identityId: number | null; accountId: number | null }) => Promise<void>;
  openDraft: (email: ApiEmail, body: ApiEmailBody) => Promise<void>;
  update: (key: string, patch: Partial<Draft>) => void;
  close: (key: string) => void;
}

let counter = 0;

/** The identity's signature as a replaceable block ('' when it has none or is a disposable address). */
async function signatureHtml(identity: ApiIdentity | null): Promise<string> {
  if (!identity?.id) return '';
  try { return (await fetchIdentitySignature(identity.id)).html; } catch { return ''; }
}

/** Put the signature after the first (empty) paragraph so quoted text stays below it. */
function withSignature(html: string, sig: string): string {
  if (!sig) return html;
  const m = /^<p><\/p>/.exec(html);
  return m ? `<p></p>${sig}${html.slice(m[0].length)}` : `${html}${sig}`;
}

function quoteHeader(email: ApiEmail): string {
  const from = email.from[0];
  const when = new Date(email.receivedAt).toLocaleString();
  return `On ${when}, ${esc(from?.name || from?.email || '')} &lt;${esc(from?.email ?? '')}&gt; wrote:`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function quotedBody(email: ApiEmail): Promise<string> {
  try {
    const body = await fetchBody(email.id, useSession.getState().settings.allowRemoteImages);
    const inner = body.html ?? `<p>${esc(body.text ?? '').replace(/\n/g, '<br>')}</p>`;
    return `<p></p><p>${quoteHeader(email)}</p><blockquote>${inner}</blockquote>`;
  } catch {
    return '<p></p>';
  }
}

export const useCompose = create<ComposeState>((set, get) => ({
  windows: [],
  identities: [],
  businesses: [],

  loadIdentities: async () => {
    try { set({ identities: await fetchIdentities() }); } catch { /* offline */ }
    try { set({ businesses: await api.get<ApiBusiness[]>('/api/businesses') }); } catch { /* offline */ }
  },

  openBlank: async () => {
    const identities = get().identities;
    const sig = await signatureHtml(identities[0] ?? null);
    set({
      windows: [...get().windows, {
        key: `c${++counter}`,
        identity: identities[0] ?? null,
        to: [], cc: [], bcc: [], subject: '', initialHtml: withSignature('<p></p>', sig),
        attachments: [], track: useSession.getState().settings.trackByDefault,
        perRecipientTracking: useSession.getState().settings.perRecipientTracking,
        minimized: false, maximized: false,
      }],
    });
  },

  /** Templates view → new message from a template (default From = the template's mailbox). */
  openTemplate: async (t) => {
    const identities = get().identities;
    const identity = (t.accountId ? identities.find((i) => i.accountId === t.accountId && !i.isAlias) : null) ?? identities[0] ?? null;
    const filled = await fillTemplate(t, { identity, to: [], subject: '' });
    if (!filled) return;
    set({
      windows: [...get().windows, {
        key: `c${++counter}`,
        identity,
        to: [], cc: [], bcc: [], subject: filled.subject, initialHtml: filled.html,
        attachments: [], track: useSession.getState().settings.trackByDefault,
        perRecipientTracking: useSession.getState().settings.perRecipientTracking,
        minimized: false, maximized: false,
      }],
    });
  },

  /** Undo send: put a held message back into a compose window exactly as it was. */
  openFromPayload: (p) => {
    const identities = get().identities;
    const identity = identities.find((i) => i.accountId === p.accountId && i.email.toLowerCase() === p.fromEmail.toLowerCase())
      ?? identities.find((i) => i.accountId === p.accountId) ?? identities[0] ?? null;
    set({
      windows: [...get().windows, {
        key: `c${++counter}`, identity,
        to: p.to, cc: p.cc, bcc: p.bcc, subject: p.subject, initialHtml: p.html,
        inReplyTo: p.inReplyTo, replyToEmailId: p.replyToEmailId, draftId: p.draftId,
        attachments: p.attachments ?? [], track: p.track, perRecipientTracking: !!p.perRecipientTracking, followupDays: p.followupDays,
        minimized: false, maximized: false,
      }],
    });
  },

  openLead: async (o) => {
    const identities = get().identities;
    const identity = (o.identityId ? identities.find((i) => i.id === o.identityId) : null)
      ?? (o.accountId ? identities.find((i) => i.accountId === o.accountId && !i.isAlias) : null) ?? identities[0] ?? null;
    const sig = await signatureHtml(identity);
    set({
      windows: [...get().windows, {
        key: `c${++counter}`, identity, to: o.to, cc: [], bcc: [], subject: o.subject, initialHtml: withSignature('<p></p>', sig),
        attachments: [], track: useSession.getState().settings.trackByDefault,
        perRecipientTracking: useSession.getState().settings.perRecipientTracking,
        minimized: false, maximized: false,
      }],
    });
  },

  openReply: async (email, mode, template) => {
    let identity: ApiIdentity | null = null;
    let viaDisposable: string | undefined;
    try { const m = await matchIdentity(email.id); identity = m; viaDisposable = m.viaDisposable; } catch { identity = get().identities[0] ?? null; }
    const own = new Set<string>();
    for (const i of get().identities) own.add(i.email.toLowerCase());

    let to: ApiAddress[] = [];
    let cc: ApiAddress[] = [];
    let subject = email.subject;
    if (mode === 'forward') {
      subject = /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
    } else {
      subject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
      const replyTarget = email.replyTo.length > 0 ? email.replyTo : email.from;
      to = replyTarget.filter((a) => !own.has(a.email.toLowerCase()));
      if (to.length === 0) to = email.to; // replying to yourself
      if (mode === 'replyAll') {
        const seen = new Set(to.map((a) => a.email.toLowerCase()));
        cc = [...email.to, ...email.cc].filter((a) => {
          const lc = a.email.toLowerCase();
          if (own.has(lc) || seen.has(lc)) return false;
          seen.add(lc);
          return true;
        });
      }
    }

    let html = withSignature(await quotedBody(email), await signatureHtml(identity));
    if (template && mode !== 'forward') {
      try {
        const r = await api.post<ApiTemplateRender>(`/api/templates/${template.id}/render`, { emailId: email.id, identityId: identity?.id });
        html = `${r.html}${html}`;
        if (r.note) toast(r.note);
        // confirm-free send: safe template, fully rendered, goes through the normal undo-send path
        if (template.sendDirect && r.canSendDirect && identity && to.length > 0) {
          const res = await sendMail({
            accountId: identity.accountId, fromEmail: identity.email, identityId: identity.id, to, cc, bcc: [], subject,
            html, inReplyTo: email.messageId ?? undefined, replyToEmailId: email.id, attachmentIds: [], track: false, quickReplyId: template.id,
          });
          if (res.queued && res.jobId && res.releaseAt) {
            const jobId = res.jobId;
            const stop = countdownToast((n) => `Sending “${template.name}” in ${n}s…`, res.releaseAt, async () => {
              try {
                const back = await undoSendApi(jobId);
                stop();
                get().openFromPayload(back.payload);
                toast('Send cancelled — your message is back in the editor');
              } catch { stop(); toast('Too late — it has already been sent', 'error'); }
            });
          } else toast('Message sent');
          return;
        }
      } catch (e: any) { toast(e?.message ?? 'Could not fill the template', 'error'); }
    }
    set({
      windows: [...get().windows, {
        key: `c${++counter}`,
        identity,
        to, cc, bcc: [], subject,
        initialHtml: html,
        inReplyTo: mode === 'forward' ? undefined : email.messageId ?? undefined,
        replyToEmailId: mode === 'forward' ? undefined : email.id,
        replyNotice: viaDisposable && identity ? `This reply will come from ${identity.email}, not the disposable one (${viaDisposable}). Pick another identity above if you prefer.` : undefined,
        attachments: [],
        track: useSession.getState().settings.trackByDefault,
        perRecipientTracking: useSession.getState().settings.perRecipientTracking,
        minimized: false, maximized: false,
      }],
    });
  },

  openDraft: async (email, body) => {
    let identity: ApiIdentity | null = null;
    const fromAddr = email.from[0]?.email?.toLowerCase();
    identity = get().identities.find((i) => i.email.toLowerCase() === fromAddr) ?? get().identities[0] ?? null;
    set({
      windows: [...get().windows, {
        key: `c${++counter}`,
        identity,
        to: email.to, cc: email.cc, bcc: [],
        subject: email.subject,
        initialHtml: body.html ?? `<p>${esc(body.text ?? '').replace(/\n/g, '<br>')}</p>`,
        draftId: email.id,
        attachments: [],
        // the draft remembers its tracking toggle (X-Seamless-Track)
        track: body.headers.seamlessTrack ?? useSession.getState().settings.trackByDefault,
        perRecipientTracking: useSession.getState().settings.perRecipientTracking,
        minimized: false, maximized: false,
      }],
    });
  },

  update: (key, patch) => {
    set({ windows: get().windows.map((w) => (w.key === key ? { ...w, ...patch } : w)) });
  },

  close: (key) => {
    set({ windows: get().windows.filter((w) => w.key !== key) });
  },
}));
