import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { q, one, run } from '../db.ts';
import { config } from '../config.ts';
import { sha256 } from '../crypto.ts';
import { putBlob } from '../s3.ts';
import { facadeLogin } from './auth.ts';
import { smtpTransport } from '../mail/send.ts';
import { enqueueOp, syncManager, type AccountRow } from '../imap/sync.ts';
import { plog } from '../classify/settings.ts';

/**
 * SMTP submission facade: standard clients send through Seamless, which relays via the
 * owning account's real outbound server — SPF/DKIM stay with the provider. The account
 * is picked by the From address (primary or alias); auth = app passwords.
 */

async function pickAccount(userId: number, from: string): Promise<AccountRow | null> {
  const accounts = await q<AccountRow>('SELECT * FROM accounts WHERE user_id = ? AND enabled = true ORDER BY id', [userId]);
  const lc = from.toLowerCase();
  for (const a of accounts) {
    if (a.email.toLowerCase() === lc) return a;
    if ((JSON.parse(a.aliases) as string[]).some((al) => al.toLowerCase() === lc)) return a;
  }
  return accounts[0] ?? null;
}

export function startSmtpFacade(port = config.facade.smtpPort): SMTPServer | null {
  if (!config.facade.enabled) return null;
  const server = new SMTPServer({
    banner: 'Seamless submission',
    authOptional: false,
    disabledCommands: ['STARTTLS'], // plain on LAN/dev; front with a TLS proxy for WAN use
    size: 50 * 1024 * 1024,
    onAuth(auth, _session, cb) {
      facadeLogin(auth.username ?? '', auth.password ?? '', 'smtp')
        .then((u) => u ? cb(null, { user: { userId: u.userId } as any }) : cb(new Error('invalid credentials (use an app password)')))
        .catch((err) => cb(err));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        void (async () => {
          const userId = (session.user as any).userId as number;
          const raw = Buffer.concat(chunks);
          const parsed = await simpleParser(raw);
          const from = (parsed.from?.value?.[0]?.address ?? (session.envelope.mailFrom && (session.envelope.mailFrom as any).address)) || '';
          const acct = await pickAccount(userId, String(from));
          if (!acct) throw new Error('no matching account for sender address');

          const envelopeTo = session.envelope.rcptTo.map((r) => r.address);
          const transport = await smtpTransport(acct);
          await transport.sendMail({ envelope: { from: String(from) || acct.email, to: envelopeTo }, raw });

          if (acct.sent_copy) {
            const key = `outbound/${acct.id}/${sha256(raw)}.eml`;
            await putBlob(key, raw);
            await enqueueOp(acct.id, 'append', { s3Key: key, targetRole: 'sent', flags: ['\\Seen'] });
          }
          // mark the replied-to message answered when the client set In-Reply-To
          if (parsed.inReplyTo) {
            await run(`
              UPDATE messages SET answered = true
              WHERE user_id = ? AND message_id = ?
            `, [userId, parsed.inReplyTo]);
          }
          syncManager.kick(acct.id);
          await plog(userId, 'send', `relayed "${parsed.subject ?? '(no subject)'}" via ${acct.email} (submission facade)`);
        })().then(() => cb()).catch((err) => cb(err));
      });
    },
  });
  server.listen(port, '0.0.0.0', () =>
    console.log(`SMTP submission facade on :${port}`));
  server.on('error', (e) => console.error('[smtpd]', e.message));
  return server;
}
