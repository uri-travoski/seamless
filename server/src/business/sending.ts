/** Resolve the identity a message is sent from (F-30): From name/address, reply-to, bcc-self, transport. */
import type { ComposePayload } from '@seamless/shared';
import { one } from '../db.ts';
import type { IdentityRow } from './identities.ts';

export interface SendIdentity {
  id: number; email: string; name: string; replyTo: string | null; bccSelf: boolean; transportId: number | null;
}

/** null when the payload has no identityId (old clients: keep using fromEmail + account name). Throws for a foreign/unknown id. */
export async function resolveSendIdentity(userId: number, payload: ComposePayload): Promise<SendIdentity | null> {
  if (payload.identityId == null) return null;
  const r = await one<IdentityRow>('SELECT * FROM identities WHERE id = ? AND user_id = ? AND account_id = ?',
    [Number(payload.identityId), userId, payload.accountId]);
  if (!r) throw new Error('Unknown identity');
  return { id: r.id, email: r.email, name: r.display_name, replyTo: r.reply_to, bccSelf: r.bcc_self, transportId: r.transport_id };
}

/** The payload as it is actually sent: From from the identity, own address Bcc'd when asked. */
export function effectivePayload(payload: ComposePayload, ident: SendIdentity | null): ComposePayload {
  if (!ident) return payload;
  const out: ComposePayload = { ...payload, fromEmail: ident.email };
  if (ident.bccSelf) {
    const have = new Set([...payload.to, ...payload.cc, ...payload.bcc].map((a) => a.email.trim().toLowerCase()));
    if (!have.has(ident.email.toLowerCase())) out.bcc = [...payload.bcc, { name: ident.name, email: ident.email }];
  }
  return out;
}
