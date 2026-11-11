/**
 * Template placeholders (T1 F-12), shared by the server (tests) and the compose window.
 *
 *   {{recipient.first_name}} {{recipient.name}} {{recipient.email}}
 *   {{sender.name}} {{sender.business}} {{sender.email}}
 *   {{date}} {{date+7d}} {{date-1w}} {{date+1m}}   (long date in the user's zone)
 *   {{subject}}
 *   {{?Question}}   asks the user when the template is inserted
 */
export interface TemplateContext {
  recipient?: { name?: string; email?: string } | null;
  sender?: { name?: string; email?: string; business?: string } | null;
  subject?: string;
  now?: Date;
  timeZone?: string;                 // default Australia/Perth
  answers?: Record<string, string>;  // {{?Question}} -> answer
  /** T4 F-31: the message being replied to */
  original?: { subject?: string; date?: number | Date } | null;
  business?: { name?: string; shortName?: string; phone?: string; website?: string; abn?: string; address?: string } | null;
  identity?: { name?: string; email?: string } | null;
  /** html that replaces {{unsubscribe}} (marketing templates) */
  unsubscribe?: string;
}

/** `{{ai: "write two friendly sentences"}}` placeholders, in order of appearance (T4 F-31). */
export const AI_TOKEN = /\{\{\s*ai\s*:\s*(?:"([^"]*)"|'([^']*)'|([^{}]*?))\s*\}\}/gi;
export function aiPlaceholders(text: string): { token: string; instruction: string }[] {
  return [...text.matchAll(AI_TOKEN)].map((m) => ({ token: m[0], instruction: (m[1] ?? m[2] ?? m[3] ?? '').trim() }));
}
export const hasAiPlaceholders = (...texts: string[]) => texts.some((t) => aiPlaceholders(t).length > 0);

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** The {{?Question}} prompts a template needs answered, in order, de-duplicated. */
export function templateQuestions(...texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(TOKEN)) {
      const k = m[1];
      if (k.startsWith('?')) {
        const q = k.slice(1).trim();
        if (q && !out.includes(q)) out.push(q);
      }
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function shiftDate(base: Date, spec: string): Date {
  const m = spec.match(/^([+-])(\d+)([dwmy])$/i);
  if (!m) return base;
  const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  const d = new Date(base.getTime());
  switch (m[3].toLowerCase()) {
    case 'd': d.setUTCDate(d.getUTCDate() + n); break;
    case 'w': d.setUTCDate(d.getUTCDate() + 7 * n); break;
    case 'm': d.setUTCMonth(d.getUTCMonth() + n); break;
    case 'y': d.setUTCFullYear(d.getUTCFullYear() + n); break;
  }
  return d;
}

function firstName(name: string | undefined, email: string | undefined): string {
  const n = (name ?? '').trim();
  if (n) return n.split(/\s+/)[0];
  const local = (email ?? '').split('@')[0] ?? '';
  const w = local.split(/[._-]/)[0] ?? '';
  return w ? w[0].toUpperCase() + w.slice(1) : '';
}

/** Fill the placeholders. `html` escapes the inserted values (template body is HTML). */
export function renderTemplate(text: string, ctx: TemplateContext, opts: { html?: boolean; keepRecipientTokens?: boolean; highlightUnknown?: boolean } = {}): string {
  const now = ctx.now ?? new Date();
  const tz = ctx.timeZone || 'Australia/Perth';
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-AU', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const esc = (s: string) => (opts.html ? escapeHtml(s) : s);
  return text.replace(TOKEN, (whole, rawKey: string) => {
    const key = rawKey.trim();
    if (key.startsWith('?')) return esc(ctx.answers?.[key.slice(1).trim()] ?? '');
    const lk = key.toLowerCase();
    if (/^ai\s*:/.test(lk)) return whole;   // filled by the server (POST /api/templates/:id/render)
    if (lk === 'unsubscribe') return ctx.unsubscribe ?? whole;
    // compose inserts a template before the To field is filled: recipient tokens wait for send
    if (opts.keepRecipientTokens && lk.startsWith('recipient.') && !ctx.recipient?.email) return whole;
    const dm = lk.match(/^date\s*([+-]\s*\d+\s*[dwmy])?$/);
    if (dm) return esc(fmt(dm[1] ? shiftDate(now, dm[1].replace(/\s+/g, '')) : now));
    switch (lk) {
      case 'recipient.first_name': return esc(firstName(ctx.recipient?.name, ctx.recipient?.email));
      case 'recipient.name': return esc((ctx.recipient?.name || ctx.recipient?.email || '').trim());
      case 'recipient.email': return esc(ctx.recipient?.email ?? '');
      case 'sender.first_name': return esc(firstName(ctx.sender?.name, ctx.sender?.email));
      case 'original.subject': return esc(ctx.original?.subject ?? '');
      case 'original.date': return ctx.original?.date != null ? esc(fmt(new Date(ctx.original.date))) : '';
      case 'today': return esc(fmt(now));
      case 'business.name': return esc(ctx.business?.name ?? '');
      case 'business.short_name': return esc(ctx.business?.shortName || ctx.business?.name || '');
      case 'business.phone': return esc(ctx.business?.phone ?? '');
      case 'business.website': return esc(ctx.business?.website ?? '');
      case 'business.abn': return esc(ctx.business?.abn ?? '');
      case 'business.address': return esc(ctx.business?.address ?? '');
      case 'identity.name': return esc(ctx.identity?.name ?? '');
      case 'identity.email': return esc(ctx.identity?.email ?? '');
      case 'sender.name': return esc(ctx.sender?.name ?? '');
      case 'sender.email': return esc(ctx.sender?.email ?? '');
      case 'sender.business': return esc(ctx.sender?.business || ctx.sender?.name || '');
      case 'subject': return esc(ctx.subject ?? '');
      default: return opts.html && opts.highlightUnknown ? `<mark data-unknown-var>${escapeHtml(whole)}</mark>` : whole;  // unknown: leave visible so the user notices
    }
  });
}

export const TEMPLATE_PLACEHOLDERS: { token: string; help: string }[] = [
  { token: '{{recipient.first_name}}', help: 'First name of the first recipient' },
  { token: '{{recipient.name}}', help: 'Full name (or address) of the first recipient' },
  { token: '{{recipient.email}}', help: 'Address of the first recipient' },
  { token: '{{sender.name}}', help: 'Your name on the From identity' },
  { token: '{{sender.business}}', help: 'Business name (falls back to your name)' },
  { token: '{{date}}', help: 'Today, e.g. 11 November 2026' },
  { token: '{{date+7d}}', help: 'A date relative to today (d, w, m, y)' },
  { token: '{{original.subject}}', help: 'Subject of the message you are replying to' },
  { token: '{{original.date}}', help: 'Date of the message you are replying to' },
  { token: '{{today}}', help: 'Today (Perth date)' },
  { token: '{{business.name}}', help: 'Business of the From identity (also .phone .website .abn .address)' },
  { token: '{{identity.name}}', help: 'Display name of the From identity (also .email)' },
  { token: '{{ai: "instruction"}}', help: 'AI writes this part when you reply — you review it; never sent directly' },
  { token: '{{unsubscribe}}', help: 'Marketing: unsubscribe link (mailto to the sending identity)' },
  { token: '{{subject}}', help: 'The message subject' },
  { token: '{{?Question}}', help: 'Ask when inserting, e.g. {{?Quote amount}}' },
];

/** True while recipient placeholders are still waiting to be filled (checked at send). */
export function hasRecipientTokens(text: string): boolean {
  return /\{\{\s*recipient\./i.test(text);
}
