import { one } from '../db.ts';
import { assertLive } from '../mode.ts';
import { decrypt } from '../crypto.ts';
import { emitEvent } from '../events/emit.ts';
import type { AccountRow } from '../imap/sync.ts';
import { TransportError, type OutboundTransport } from './types.ts';
import { smtpFromAccount, smtpFromConfig } from './outbound/smtp.ts';
import { sendgridFromConfig } from './outbound/sendgrid.ts';
import { brevoFromConfig } from './outbound/brevo.ts';
import { sesFromConfig } from './outbound/ses.ts';
import { mailgunFromConfig } from './outbound/mailgun.ts';
import { postmarkFromConfig } from './outbound/postmark.ts';

type Factory = (config: Record<string, any>) => OutboundTransport;
const factories = new Map<string, Factory>([
  ['smtp', (c) => smtpFromConfig(c)],
  ['sendgrid', (c) => sendgridFromConfig(c)],
  ['brevo', (c) => brevoFromConfig(c)],
  ['ses', (c) => sesFromConfig(c)],
  ['mailgun', (c) => mailgunFromConfig(c)],
  ['postmark', (c) => postmarkFromConfig(c)],
]);

/** Adapters register themselves here (tests use it for fakes). */
export function registerAdapter(kind: string, f: Factory): void { factories.set(kind, f); }
export function knownKinds(): string[] { return [...factories.keys()]; }

export function buildTransport(kind: string, config: Record<string, any>): OutboundTransport {
  const f = factories.get(kind);
  if (!f) throw new Error(`Unknown transport kind: ${kind}`);
  return f(config);
}

export interface ResolvedTransport { transport: OutboundTransport; transportId: number | null; fallbackId: number | null }

interface TransportRow { id: number; kind: string; config_enc: string; fallback_id: number | null }

export async function loadTransport(userId: number, id: number): Promise<{ transport: OutboundTransport; row: TransportRow } | null> {
  const row = await one<TransportRow>('SELECT id, kind, config_enc, fallback_id FROM transports WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) return null;
  return { transport: buildTransport(row.kind, JSON.parse(decrypt(row.config_enc))), row };
}

/** The identity's transport override, else the account's chosen transport, else its own SMTP settings. */
export async function transportForAccount(userId: number, acct: AccountRow, identityTransportId?: number | null): Promise<ResolvedTransport> {
  if (identityTransportId) {
    const loaded = await loadTransport(userId, identityTransportId);
    if (loaded) return { transport: loaded.transport, transportId: loaded.row.id, fallbackId: loaded.row.fallback_id };
  }
  if (acct.outbound_transport_id) {
    const loaded = await loadTransport(userId, acct.outbound_transport_id);
    if (loaded) return { transport: loaded.transport, transportId: loaded.row.id, fallbackId: loaded.row.fallback_id };
  }
  return { transport: smtpFromAccount(acct), transportId: null, fallbackId: null };
}

/** Send; if the transport fails in a retryable way, try its fallback once and raise send.failed. */
export async function sendWithFallback(
  userId: number, t: ResolvedTransport, raw: Buffer, env: { from: string; to: string[] },
  ctx: { subject: string; accountId: number | null } = { subject: '', accountId: null },
): Promise<{ providerMessageId?: string; fallbackUsed: boolean }> {
  assertLive('sending mail');
  try {
    return { ...(await t.transport.send(raw, env)), fallbackUsed: false };
  } catch (err: any) {
    const retryable = err instanceof TransportError ? err.retryable : false;
    const fb = retryable && t.fallbackId ? await loadTransport(userId, t.fallbackId) : null;
    if (!fb) throw err;
    await emitEvent(userId, 'send.failed', null,
      { subject: ctx.subject, accountId: ctx.accountId, error: err?.message ?? 'send failed', fallbackUsed: true }).catch(() => {});
    return { ...(await fb.transport.send(raw, env)), fallbackUsed: true };
  }
}
