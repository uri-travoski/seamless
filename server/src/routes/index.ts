/** registerRoutes(app): auth gate + every route module. */
import type { FastifyInstance } from 'fastify';
import { sessionUser } from './util.ts';
import { register as auth } from './auth.ts';
import { register as users } from './users.ts';
import { register as accounts } from './accounts.ts';
import { register as labels } from './labels.ts';
import { register as filters } from './filters.ts';
import { register as messages } from './messages.ts';
import { register as compose } from './compose.ts';
import { register as ai } from './ai.ts';
import { register as rules } from './rules.ts';
import { register as preferences } from './preferences.ts';
import { register as classify } from './classify.ts';
import { register as aiMemory } from './aimemory.ts';
import { register as oauth } from './oauth.ts';
import { register as gmailLearn } from './gmailLearn.ts';
import { register as devices } from './devices.ts';
import { register as contacts } from './contacts.ts';
import { register as logs } from './logs.ts';
import { register as backup } from './backup.ts';
import { register as help } from './help.ts';
import { register as tracking } from './tracking.ts';
import { register as push } from './push.ts';
import { register as jmap } from './jmap.ts';
import { register as notifications } from './notifications.ts';
import { register as categories } from './categories.ts';
import { register as templates } from './templates.ts';
import { register as bulk } from './bulk.ts';
import { register as prefs } from './prefs.ts';
import { register as snooze } from './snooze.ts';
import { register as pgp } from './pgp.ts';
import { register as smime } from './smime.ts';
import { register as newsletters } from './newsletters.ts';
import { register as followups } from './followups.ts';
import { register as risk } from './risk.ts';
import { register as health } from './health.ts';
import { register as transports } from './transports.ts';
import { register as ingest } from './ingest.ts';
import { register as pushInboxes } from './pushInboxes.ts';
import { register as disposable } from './disposable.ts';
import { register as storage } from './storage.ts';
import { register as exportRoutes } from './export.ts';
import { register as businesses } from './businesses.ts';
import { register as shares } from './shares.ts';
import { register as team } from './team.ts';
import { register as assignments } from './assignments.ts';
import { register as invites } from './invites.ts';
import { register as views } from './views.ts';
import { register as vips } from './vips.ts';
import { register as webhooks } from './webhooks.ts';
import { register as apiv1 } from './apiv1.ts';
import { register as leads } from './leads.ts';
import { register as auditRoutes } from './audit.ts';
import { register as archives } from './archives.ts';
import { register as modeRoutes } from './mode.ts';
import { register as alertRoutes } from './alerts.ts';
import { ViewingModeError, viewingBody, isViewing } from '../mode.ts';
import { audit } from '../audit/log.ts';
import { AUDITED_ROUTES } from '../audit/routeMap.ts';
import { sessionToken } from '../auth/sessions.ts';
import { authenticate, ApiError, onApiCall } from '../api/tokens.ts';

export { sessionUser, type SessionUser } from './util.ts';

// /api/setup/{backups,restore} are public on purpose: after a total loss the database
// is empty, so there is no account to authenticate with. Both refuse once a user exists.
const PUBLIC_PATHS = [/^\/t\//, /^\/api\/(login|login\/mfa|setup|me)$/, /^\/api\/import(\?.*)?$/, /^\/api\/setup\/(backups|restore|storage-test)$/, /^\/api\/ingest\/[A-Za-z0-9_-]+(\/disposed)?(\?.*)?$/, /^\/api\/hooks\/blob\/[A-Za-z0-9_.-]+(\?.*)?$/, /^\/(?!api|jmap)/];

/** Routes that send or fetch mail, refused with 409 in Viewing mode. */
const VIEWING_BLOCKED: Record<string, string> = {
  'POST /api/send': 'sending mail',
  'POST /api/schedule': 'sending mail',
  'POST /api/v1/send': 'sending mail',
  'POST /api/invites/:id/rsvp': 'sending mail',
  'POST /api/ingest/:token': 'receiving mail',
  'POST /api/accounts/test': 'connection tests',
  'POST /api/accounts/test/incoming': 'connection tests',
  'POST /api/accounts/test/pop3': 'connection tests',
  'POST /api/accounts/test/outgoing': 'connection tests',
  'POST /api/accounts/:id/pop3/poll': 'receiving mail',
  'POST /api/transports/:id/test': 'connection tests',
  'POST /api/push-inboxes/:token/test': 'receiving mail',
};

export function registerRoutes(app: FastifyInstance): void {
  // REST v1: bearer tokens only. Cookies are ignored here on purpose (no CSRF surface); the OpenAPI document is public.
  app.addHook('preHandler', async (req, reply) => {
    if (!/^\/api\/v1(\/|$)/.test(req.url)) return;
    (req as any).sessionUser = null;
    if (/^\/api\/v1\/openapi\.json(\?.*)?$/.test(req.url)) return;
    try {
      const a = await authenticate(req.headers.authorization);
      (req as any).apiAuth = a;
      (req as any).sessionUser = { userId: a.userId, role: a.role, token: '' };
    } catch (e) {
      if (e instanceof ApiError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });
  // Audit in onSend (not onResponse): the row is committed before the client gets its answer, so "the action
  // happened" and "the audit row exists" can't be observed out of order. Creates answer with the new row's id,
  // which is read from the JSON body so the row can name its target.
  // Callback style on purpose: requests that need no audit row must go through synchronously. An async hook defers
  // the send by a tick, and routes that call `reply.send()` and then `return;` (the admin guards) would double-send.
  app.addHook('onSend', (req, reply, payload, done) => {
    const pattern = req.routeOptions?.url ?? req.url;
    const a = (req as any).apiAuth;
    if (a) {
      onApiCall(a.tokenId, `${req.method} ${pattern}`, reply.statusCode);
      // one audit row per v1 call: route + status (never the body or the query string)
      void audit(req, 'api.call', { type: 'route', id: `${req.method} ${pattern}` }, { status: reply.statusCode }).then(() => done(null, payload));
      return;
    }
    const hit = AUDITED_ROUTES[`${req.method} ${pattern}`];   // sensitive session-authenticated actions (audit/routeMap.ts)
    if (!hit || reply.statusCode >= 400) { done(null, payload); return; }
    let newId: unknown = null;
    if (typeof payload === 'string' && payload.length < 4096 && payload.startsWith('{')) {
      try { const j = JSON.parse(payload); if (typeof j?.id === 'number' || typeof j?.id === 'string') newId = j.id; } catch { /* not json */ }
    }
    const params = (req.params ?? {}) as Record<string, string>;
    void audit(req, hit.action, { type: hit.type, id: params[hit.idParam ?? 'id'] ?? (newId as any) }, { params, status: reply.statusCode })
      .then(() => done(null, payload));
  });

  app.addHook('preHandler', async (req, reply) => {
    if (/^\/api\/v1(\/|$)/.test(req.url)) return;
    const su = await sessionUser(sessionToken(req));
    (req as any).sessionUser = su;
    if (PUBLIC_PATHS.some((re) => re.test(req.url))) return;
    if (!su) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    // an admin set a temporary password: nothing works until the user chooses their own
    if (su.mustChangePassword && !/^\/api\/(logout|users\/password|ws)(\?.*)?$/.test(req.url)) {
      return reply.code(403).send({ error: 'You must choose a new password before continuing.', mustChangePassword: true });
    }
  });

  // Viewing mode (T8.7): the server refuses every way of sending or fetching mail. The functions that actually talk to a
  // mail server check again (assertLive), so a worker or a route missing from this list is still stopped.
  app.addHook('preHandler', async (req, reply) => {
    if (!isViewing()) return;
    const pattern = `${req.method} ${req.routeOptions?.url ?? req.url}`;
    const what = VIEWING_BLOCKED[pattern];
    if (what) return reply.code(409).send({ error: 'viewing_mode', message: `Viewing mode: ${what} is turned off` });
    if (pattern === 'POST /api/sync') return reply.send({ ok: true, accounts: 0, viewing: true, message: 'Viewing mode — nothing to fetch' });
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ViewingModeError) return reply.code(409).send(viewingBody(err));
    // everything else: Fastify's own default answer
    const status = Number((err as any).statusCode) >= 400 ? Number((err as any).statusCode) : 500;
    return reply.code(status).send({ statusCode: status, error: (err as any).code ?? err.name, message: err.message });
  });

  auth(app);
  users(app);
  accounts(app);
  labels(app);
  filters(app);
  messages(app);
  compose(app);
  ai(app);
  rules(app);
  preferences(app);
  classify(app);
  aiMemory(app);
  oauth(app);
  gmailLearn(app);
  devices(app);
  contacts(app);
  logs(app);
  backup(app);
  help(app);
  tracking(app);
  push(app);
  jmap(app);
  notifications(app);
  categories(app);
  templates(app);
  bulk(app);
  prefs(app);
  snooze(app);
  pgp(app);
  smime(app);
  newsletters(app);
  followups(app);
  risk(app);
  health(app);
  transports(app);
  ingest(app);
  pushInboxes(app);
  disposable(app);
  storage(app);
  exportRoutes(app);
  businesses(app);
  shares(app);
  team(app);
  assignments(app);
  invites(app);
  views(app);
  vips(app);
  webhooks(app);
  apiv1(app);
  leads(app);
  auditRoutes(app);
  archives(app);
  modeRoutes(app);
  alertRoutes(app);
}
