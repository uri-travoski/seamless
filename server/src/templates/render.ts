/** Quick replies (F-31): server-side template rendering with variables and AI fill. */
import { renderTemplate, aiPlaceholders, hasAiPlaceholders, type ApiTemplateRender, type ComposePayload } from '@seamless/shared';
import { one, run } from '../db.ts';
import { getMsgRow } from '../mail/store.ts';
import { getTaskProvider, chatComplete } from '../ai/client.ts';
import { threadText } from '../ai/tasks.ts';
import { getBusiness } from '../business/businesses.ts';
import type { IdentityRow } from '../business/identities.ts';

export const AI_TIMEOUT_MS = 20_000;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A direct-send template may not contain AI placeholders (they need review). */
export const templateIsDirectSafe = (t: { send_direct: boolean; subject: string; body_html: string }) =>
  t.send_direct && !hasAiPlaceholders(t.subject, t.body_html);

export async function renderServerTemplate(userId: number, templateId: number, emailId: string | undefined, identityId: number | undefined): Promise<ApiTemplateRender | null> {
  const t = await one<any>('SELECT * FROM templates WHERE id = ? AND user_id = ?', [templateId, userId]);
  if (!t) return null;
  const msg = emailId ? await getMsgRow(userId, emailId) : undefined;
  if (emailId && !msg) return null;
  const ident = identityId ? await one<IdentityRow>('SELECT * FROM identities WHERE id = ? AND user_id = ?', [identityId, userId]) : undefined;
  if (identityId && !ident) return null;
  const business = ident?.business_id ? await getBusiness(userId, ident.business_id) : (t.business_id ? await getBusiness(userId, t.business_id) : undefined);
  const identityOrAccount = ident ?? null;
  const replyTarget = msg ? { name: msg.from_name, email: msg.from_addr } : null;
  const ctx = {
    recipient: replyTarget,
    sender: identityOrAccount ? { name: identityOrAccount.display_name, email: identityOrAccount.email, business: business?.name } : null,
    identity: identityOrAccount ? { name: identityOrAccount.display_name, email: identityOrAccount.email } : null,
    business: business ? { name: business.name, shortName: business.short_name, phone: business.phone, website: business.website, abn: business.abn, address: business.address } : null,
    original: msg ? { subject: msg.subject, date: Number(msg.date) } : null,
    subject: msg ? (/^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`) : undefined,
    unsubscribe: identityOrAccount && t.kind === 'marketing'
      ? `<a href="mailto:${esc(identityOrAccount.email)}?subject=unsubscribe">Unsubscribe</a>` : undefined,
  };
  // Kept T1 semantics: sender.* = you (the From identity), recipient.* = the person being replied to.
  const specCtx = ctx;
  let subject = renderTemplate(t.subject, specCtx);
  let html = renderTemplate(t.body_html, specCtx, { html: true, highlightUnknown: true });
  if (t.kind === 'marketing' && !/mailto:[^"]*unsubscribe/i.test(html) && ctx.unsubscribe) html += `<p style="font-size:12px">${ctx.unsubscribe}</p>`;

  const ais = aiPlaceholders(html);
  let pending = 0;
  let note: string | undefined;
  if (ais.length > 0) {
    const provider = await getTaskProvider(userId, 'draft');
    if (!provider || !msg) {
      pending = ais.length;
      note = !provider ? 'No AI provider is set up for drafting (Settings → AI): fill the highlighted parts yourself.' : 'AI parts need a message to reply to.';
    } else {
      const thread = await threadText(userId, msg.thread_id);
      for (const ph of ais) {                              // one call per placeholder
        try {
          const out = (await chatComplete(provider, [
            { role: 'system', content: 'You write one short passage for an email reply, following the instruction. Output only the passage as plain text — no greeting, no sign-off, no commentary.' },
            { role: 'user', content: `Email thread (oldest first):\n${thread}\n\n---\nInstruction: ${ph.instruction}` },
          ], { maxTokens: 400, timeoutMs: AI_TIMEOUT_MS })).trim();
          if (!out) throw new Error('empty');
          html = html.split(ph.token).join(`<mark data-ai-fill>${esc(out).replace(/\r?\n/g, '<br>')}</mark>`);
        } catch {
          pending++;
          note = 'AI could not fill some parts: they are left highlighted for you.';
        }
      }
    }
    if (pending > 0) html = html.replace(/\{\{\s*ai\s*:[^{}]*\}\}/gi, (m) => `<mark data-ai-pending>${esc(m)}</mark>`);
  }
  const canSendDirect = templateIsDirectSafe(t) && ais.length === 0 && !/\{\{[^}]*\}\}|data-unknown-var/.test(html + subject) && !!msg;
  return { subject, html, aiFilled: pending === 0, aiPending: pending, ...(note ? { note } : {}), canSendDirect };
}

export async function markUsed(userId: number, id: number): Promise<void> {
  await run('UPDATE templates SET use_count = use_count + 1, last_used_at = ? WHERE id = ? AND user_id = ?', [Date.now(), id, userId]);
}

/** Server-side guard for confirm-free sends (payload.quickReplyId). Returns an error string or null. */
export async function checkQuickReplySend(userId: number, templateId: number, payload: ComposePayload): Promise<string | null> {
  const t = await one<any>('SELECT * FROM templates WHERE id = ? AND user_id = ?', [templateId, userId]);
  if (!t) return 'unknown quick reply';
  if (hasAiPlaceholders(t.subject, t.body_html)) return 'a template with AI placeholders can not be sent directly: review it first';
  if (!t.send_direct) return 'this template is not marked safe to send directly';
  if (/data-ai-fill|data-ai-pending|data-unknown-var|\{\{[^}]*\}\}/.test(`${payload.html ?? ''}${payload.subject ?? ''}`)) return 'the message still has unfilled or AI-written parts: review it first';
  return null;
}
