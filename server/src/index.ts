import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { migrate, currentState } from './db.ts';
import { ensureBucket } from './s3.ts';
import { registerRoutes, sessionUser } from './routes.ts';
import { syncManager, type NewMailEvent } from './imap/sync.ts';
import { addClient, broadcast } from './ws.ts';
import { initPush, notifyUser } from './push.ts';
import { categorizeEmail } from './ai/tasks.ts';
import { startScheduler, onScheduledSend } from './mail/scheduler.ts';
import { setScheduleCanceller } from './mail/store.ts';
import { cancelScheduleByMessageId } from './mail/send.ts';
import { startClassifier, kickClassifier, onClassified } from './classify/engine.ts';
import { startRetention, onRetention } from './classify/retention.ts';
import { startSafeDelete } from './classify/safedelete.ts';

await migrate();

const app = Fastify({ logger: false, bodyLimit: 60 * 1024 * 1024, trustProxy: true });

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
await app.register(websocket);

registerRoutes(app);

app.register(async (instance) => {
  instance.get('/api/ws', { websocket: true }, async (socket, req) => {
    const su = await sessionUser((req as any).cookies?.smsession);
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
  broadcast({ type: 'newMail', accountId: ev.accountId, from: ev.from, subject: ev.subject, mailboxRole: 'inbox' }, ev.userId);
  kickClassifier();
  void notifyUser(ev.userId, ev.from || 'New mail', ev.subject || '(no subject)', `mail-${ev.rowId}`);
  if (ev.aiCategorize) {
    categorizeEmail(ev.userId, ev.rowId)
      .then(async (label) => { if (label) broadcast({ type: 'stateChange', state: await currentState() }, ev.userId); })
      .catch((err) => console.error('[ai] categorize failed:', err?.message ?? err));
  }
});

await ensureBucket().catch((err) => {
  console.error('S3 bucket check failed (blob storage unavailable):', err?.message ?? err);
});
await initPush();

// scheduled send: cancel on delete, refresh clients when one fires
setScheduleCanceller((messageId) => cancelScheduleByMessageId(messageId));
onScheduledSend(async () => broadcast({ type: 'stateChange', state: await currentState() }));
startScheduler();

// classification + retention workers
onClassified(async (userId) => broadcast({ type: 'stateChange', state: await currentState() }, userId));
onRetention(async (userId) => broadcast({ type: 'stateChange', state: await currentState() }, userId));
startClassifier();
startRetention();
startSafeDelete();

await syncManager.startAll();

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Seamless server on ${config.publicUrl} (port ${config.port})`);
