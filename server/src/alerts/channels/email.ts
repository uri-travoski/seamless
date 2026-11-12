/** Email to an external address, sent through a mailbox that is NOT the failing one. Off in Viewing mode. */
import { q } from '../../db.ts';
import { isViewing } from '../../mode.ts';
import { syncManager } from '../../imap/sync.ts';
import type { AccountRow } from '../../imap/sync.ts';
import { ChannelError, str, type ChannelAdapter, type AlertMessage } from './types.ts';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A healthy, enabled mailbox of this user (or, failing that, anyone's) other than `exclude`. */
export async function pickSender(userId: number, exclude: number | null): Promise<AccountRow | null> {
  const rows = await q<AccountRow>(`SELECT * FROM accounts WHERE enabled = true AND archived = false AND smtp_host <> '' AND id <> ?
                                    ORDER BY (user_id = ?) DESC, id`, [exclude ?? 0, userId]);
  const healthy = rows.filter((a) => syncManager.status(a.id).state !== 'error');
  // never send an alert about a broken mailbox through some other broken one
  return healthy[0] ?? null;
}

async function defaultSend(userId: number, to: string[], msg: AlertMessage, exclude: number | null): Promise<void> {
  const acct = await pickSender(userId, exclude);
  if (!acct) throw new ChannelError('no healthy mailbox to send through (every mailbox is failing or none has outgoing mail set up)');
  const { smtpTransport } = await import('../../transport/outbound/smtp.ts');
  const t = await smtpTransport(acct);
  await t.sendMail({ from: acct.email, to: to.join(', '), subject: `[Seamless] ${msg.title}`, text: `${msg.body}\n\n-- Seamless critical alert` });
}

export const email: ChannelAdapter = {
  kind: 'email',
  label: 'Email (outside address)',
  secrets: [],
  validate(c) {
    const to = (Array.isArray(c.to) ? c.to : String(c.to ?? '').split(/[,;\s]+/)).map(str).filter(Boolean);
    if (!to.length) throw new ChannelError('Enter the email address to send alerts to');
    for (const a of to) if (!EMAIL.test(a)) throw new ChannelError(`"${a}" is not an email address`);
    return { to };
  },
  describe: (c) => (c.to as string[]).join(', '),
  async send(c, msg, deps) {
    if (isViewing()) throw new ChannelError('Email alerts are turned off in Viewing mode (this copy sends no mail)');
    try { await (deps.sendMail ?? defaultSend)(deps.userId, c.to, msg, msg.excludeAccountId ?? null); }
    catch (e: any) { throw e instanceof ChannelError ? e : new ChannelError(`could not send: ${e?.message ?? e}`); }
  },
};
