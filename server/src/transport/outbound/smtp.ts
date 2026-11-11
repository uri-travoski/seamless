import nodemailer from 'nodemailer';
import { decrypt } from '../../crypto.ts';
import type { AccountRow } from '../../imap/sync.ts';
import { TransportError, type OutboundTransport } from '../types.ts';

export interface SmtpConfig { host: string; port: number; secure: boolean; user: string; pass: string }

/** Well-known SMTP providers: pick one and only user/password are left to fill in. */
export const SMTP_PRESETS: Record<string, { name: string; host: string; port: number; secure: boolean; user?: string }> = {
  gmail: { name: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { name: 'Outlook / Microsoft 365', host: 'smtp.office365.com', port: 587, secure: false },
  icloud: { name: 'iCloud', host: 'smtp.mail.me.com', port: 587, secure: false },
  zoho: { name: 'Zoho', host: 'smtp.zoho.com', port: 465, secure: true },
  fastmail: { name: 'Fastmail', host: 'smtp.fastmail.com', port: 465, secure: true },
  brevo: { name: 'Brevo SMTP', host: 'smtp-relay.brevo.com', port: 587, secure: false },
  sendgrid: { name: 'SendGrid SMTP', host: 'smtp.sendgrid.net', port: 587, secure: false, user: 'apikey' },
  ses: { name: 'Amazon SES SMTP', host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false },
  mailgun: { name: 'Mailgun SMTP', host: 'smtp.mailgun.org', port: 587, secure: false },
  custom: { name: 'Custom', host: '', port: 587, secure: false },
};

const isLocal = (h: string) => h === 'localhost' || h === '127.0.0.1';

function createTransporter(host: string, port: number, secure: boolean, auth: any) {
  return nodemailer.createTransport({ host, port, secure, auth, tls: { rejectUnauthorized: !isLocal(host) } });
}

/** The nodemailer transporter for a mailbox's own SMTP settings (OAuth aware). */
export async function smtpTransport(acct: AccountRow) {
  const isOauth = acct.kind === 'gmail' || acct.kind === 'microsoft';
  const { freshAccessToken } = await import('../../oauth.ts');
  return createTransporter(acct.smtp_host, acct.smtp_port, !!acct.smtp_secure,
    isOauth
      ? { type: 'OAuth2' as const, user: acct.smtp_user, accessToken: await freshAccessToken(acct.id) }
      : { user: acct.smtp_user, pass: decrypt(acct.smtp_pass_enc) });
}

/** SMTP 4xx and connection-level failures are worth retrying elsewhere; auth and 5xx are not. */
export function mapSmtpError(err: any): TransportError {
  if (err instanceof TransportError) return err;
  const code = String(err?.code ?? '');
  const rc = Number(err?.responseCode ?? 0);
  const network = ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET', 'EDNS', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
  const retryable = network || (rc >= 400 && rc < 500);
  return new TransportError(err?.message ?? 'SMTP send failed', { retryable, status: rc || undefined });
}

function wrap(getTransporter: () => Promise<{ sendMail: (m: any) => Promise<any>; verify?: () => Promise<any> }>): OutboundTransport {
  return {
    kind: 'smtp',
    async send(raw, env) {
      try {
        const info = await (await getTransporter()).sendMail({ envelope: { from: env.from, to: env.to }, raw });
        return { providerMessageId: info?.messageId };
      } catch (err) {
        throw mapSmtpError(err);
      }
    },
    async test() {
      const steps: { name: string; ok: boolean; detail?: string }[] = [];
      try {
        const t = await getTransporter();
        await t.verify?.();
        steps.push({ name: 'Connect and sign in', ok: true });
      } catch (err: any) {
        steps.push({ name: 'Connect and sign in', ok: false, detail: err?.message ?? String(err) });
      }
      return { ok: steps.every((s) => s.ok), steps };
    },
  };
}

export function smtpFromAccount(acct: AccountRow): OutboundTransport {
  return wrap(() => smtpTransport(acct));
}

/** Config as stored: { preset?, host, port, secure, user, pass }. Preset fills any blanks. */
export function smtpFromConfig(cfg: Partial<SmtpConfig> & { preset?: string }): OutboundTransport {
  const p = SMTP_PRESETS[cfg.preset ?? 'custom'] ?? SMTP_PRESETS.custom;
  const host = cfg.host || p.host;
  const port = Number(cfg.port || p.port);
  const secure = cfg.secure ?? p.secure;
  const user = cfg.user || p.user || '';
  if (!host) throw new Error('SMTP host is required');
  return wrap(async () => createTransporter(host, port, !!secure, { user, pass: cfg.pass ?? '' }));
}
