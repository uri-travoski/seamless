import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { migrate, currentState, one } from './db.ts';
import { ensureBucket } from './s3.ts';
import { registerRoutes, sessionUser } from './routes/index.ts';
import { syncManager, type NewMailEvent } from './imap/sync.ts';
import { addClient, broadcast } from './ws.ts';
import { initPush } from './push.ts';
import { categorizeEmail } from './ai/tasks.ts';
import { startScheduler, onScheduledSend } from './mail/scheduler.ts';
import { startJobRunner } from './jobs/runner.ts';
import { startHealthAlerts, shouldAlert } from './health/alerts.ts';
import { wakeOnReply } from './mail/snooze.ts';
import { settleOnReply } from './mail/followups.ts';
import { setScheduleCanceller } from './mail/store.ts';
import { cancelScheduleByMessageId } from './mail/send.ts';
import { startClassifier, kickClassifier, onClassified } from './classify/engine.ts';
import { startRetention, onRetention } from './classify/retention.ts';
import { startSafeDelete } from './classify/safedelete.ts';
import { startForwarding } from './classify/forward.ts';
import { startImapFacade } from './facade/imap.ts';
import { startSmtpFacade } from './facade/smtp.ts';
import { registerCardDav } from './facade/carddav.ts';
import { startContactHarvest } from './contacts.ts';
import { startBackupScheduler } from './backup/schedule.ts';
import { initMailStore } from './backup/mailref.ts';
import { emitEvent, startEventPrune } from './events/emit.ts';
import { pruneExpiredSessions, sessionToken } from './auth/sessions.ts';
import { registerSecurityHeaders } from './security/headers.ts';

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

await migrate();

const app = Fastify({ logger: false, bodyLimit: 60 * 1024 * 1024, trustProxy: true });

await app.register(cookie);
await registerSecurityHeaders(app);
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
await app.register(websocket);

registerRoutes(app);
registerCardDav(app);

app.register(async (instance) => {
  instance.get('/api/ws', { websocket: true }, async (socket, req) => {
    const su = await sessionUser(sessionToken(req as any));
    if (!su) { (socket as any).close(); return; }
    addClient(socket as any, su.userId);
  });
});

// serve built web app in production
const webDist = path.resolve(fileURLToPath(import.meta.url), '../../../web/dist');
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api') || req.url.startsWith('/jmap') || req.url.startsWith('/t/');
    const looksLikeFile = /\.[a-z0-9]+(\?|$)/i.test(req.url);
    if (req.method === 'GET' && !isApi && !looksLikeFile) {
      return reply.type('text/html').send(fs.readFileSync(path.join(webDist, 'index.html')));
    }
    reply.code(404).send({ error: 'not found' });
  });
}

// ---- wire sync events to push channels ----
const changeTimers = new Map<number, NodeJS.Timeout>();
syncManager.on('changed', (userId: number) => {
  if (changeTimers.has(userId)) return;
  changeTimers.set(userId, setTimeout(async () => {
    changeTimers.delete(userId);
    broadcast({ type: 'stateChange', state: await currentState() }, userId);
  }, 300));
});

syncManager.on('newMail', (ev: NewMailEvent) => {
  void settleOnReply(ev.userId, ev.rowId).catch((err) => console.error('[followups] settle failed:', err?.message ?? err));
  void wakeOnReply(ev.userId, ev.rowId).catch((err) => console.error('[snooze] wake on reply failed:', err?.message ?? err));
  broadcast({ type: 'newMail', accountId: ev.accountId, from: ev.from, subject: ev.subject, mailboxRole: 'inbox' }, ev.userId);
  kickClassifier();
  // in-app notification + push (per the user's notification prefs) via the event bus
  void one<{ did: number | null; address: string | null; label: string | null; notify: boolean | null }>(
    'SELECT m.disposable_id AS did, d.address, d.label, d.notify FROM messages m LEFT JOIN disposable_addresses d ON d.id = m.disposable_id WHERE m.id = ?', [ev.rowId])
    .then(async (d) => {
      if (!d?.did) return false;
      if (d.notify) await emitEvent(ev.userId, 'disposable.received', { type: 'message', id: ev.rowId },
        { messageId: ev.rowId, accountId: ev.accountId, from: ev.from, subject: ev.subject, address: d.address, label: d.label });
      return true;
    }).catch(() => false)
    .then(async (handled) => { if (handled) return; const risk = await one<{ level: string }>('SELECT level FROM message_risk WHERE message_id = ?', [ev.rowId]).catch(() => undefined); return emitEvent(ev.userId, 'mail.received', { type: 'message', id: ev.rowId },
      { messageId: ev.rowId, accountId: ev.accountId, from: ev.from, subject: ev.subject, ...(risk?.level === 'high' ? { risk: 'high' } : {}) }); })
    .catch((err) => console.error('[events] mail.received failed:', err?.message ?? err));
  if (ev.aiCategorize) {
    categorizeEmail(ev.userId, ev.rowId)
      .then(async (label) => { if (label) broadcast({ type: 'stateChange', state: await currentState() }, ev.userId); })
      .catch((err) => console.error('[ai] categorize failed:', err?.message ?? err));
  }
});

syncManager.on('syncFailed', (ev: { accountId: number; userId: number; email: string; error: string }) => {
  // a mailbox that stays broken would otherwise re-alert on every reconnect cycle: once per 6 hours
  void one<{ health_ignored: boolean }>('SELECT health_ignored FROM accounts WHERE id = ?', [ev.accountId])
    .then((a) => (a?.health_ignored ? false : shouldAlert('sync.failed', ev.accountId, Date.now())))
    .then(async (ok) => { if (ok) await emitEvent(ev.userId, 'sync.failed', { type: 'account', id: ev.accountId }, ev); })
    .catch(() => {});
});

// where the mail blobs live: a bucket named in the environment wins, otherwise use the one
// the database remembers (that is how a restored server finds its mail with no S3_* set)
const mailSrc = await initMailStore().catch((err) => {
  console.error('mail store init failed:', err?.message ?? err);
  return { source: 'default' as const, bucket: config.s3.bucket };
});
console.log(`Mail blobs: bucket "${mailSrc.bucket}" (${mailSrc.source === 'restored' ? 'from restored backup' : mailSrc.source})`);

await ensureBucket().catch((err) => {
  console.error('S3 bucket check failed (blob storage unavailable):', err?.message ?? err);
});
await initPush();

// scheduled send: cancel on delete, refresh clients when one fires
setScheduleCanceller((messageId) => cancelScheduleByMessageId(messageId));
onScheduledSend(async () => broadcast({ type: 'stateChange', state: await currentState() }));
startScheduler();
startJobRunner();
startHealthAlerts();

// classification + retention workers
onClassified(async (userId) => broadcast({ type: 'stateChange', state: await currentState() }, userId));
onRetention(async (userId) => broadcast({ type: 'stateChange', state: await currentState() }, userId));
startClassifier();
startRetention();
startSafeDelete();
startContactHarvest();
startForwarding();
startBackupScheduler(pkg.version);
startEventPrune();
setInterval(() => { void pruneExpiredSessions().catch(() => {}); }, 6 * 3_600_000);
startImapFacade();
startSmtpFacade();

await syncManager.startAll();

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Seamless server on ${config.publicUrl} (port ${config.port})`);
