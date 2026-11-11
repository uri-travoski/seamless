import { create } from 'zustand';
import type { ApiAddress, ApiEmail, ApiEmailBody, ApiIdentity, ApiTemplate } from '@seamless/shared';
import { fillTemplate } from './templates.ts';
import { matchIdentity, fetchIdentities, fetchBody } from '../api/client.ts';
import { useSession } from './session.ts';

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
  minimized: boolean;
  maximized: boolean;
}

interface ComposeState {
  windows: Draft[];
  identities: ApiIdentity[];
  loadIdentities: () => Promise<void>;
  openBlank: () => void;
  openTemplate: (t: ApiTemplate) => Promise<void>;
  openReply: (email: ApiEmail, mode: 'reply' | 'replyAll' | 'forward') => Promise<void>;
  openDraft: (email: ApiEmail, body: ApiEmailBody) => Promise<void>;
  update: (key: string, patch: Partial<Draft>) => void;
  close: (key: string) => void;
}

let counter = 0;

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

  loadIdentities: async () => {
    try { set({ identities: await fetchIdentities() }); } catch { /* offline */ }
  },

  openBlank: () => {
    const identities = get().identities;
    set({
      windows: [...get().windows, {
        key: `c${++counter}`,
        identity: identities[0] ?? null,
        to: [], cc: [], bcc: [], subject: '', initialHtml: '<p></p>',
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

  openReply: async (email, mode) => {
    let identity: ApiIdentity | null = null;
    try { identity = await matchIdentity(email.id); } catch { identity = get().identities[0] ?? null; }
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

    const html = await quotedBody(email);
    set({
      windows: [...get().windows, {
        key: `c${++counter}`,
        identity,
        to, cc, bcc: [], subject,
        initialHtml: html,
        inReplyTo: mode === 'forward' ? undefined : email.messageId ?? undefined,
        replyToEmailId: mode === 'forward' ? undefined : email.id,
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
