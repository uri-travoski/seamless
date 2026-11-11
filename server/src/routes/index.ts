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
import { sessionToken } from '../auth/sessions.ts';

export { sessionUser, type SessionUser } from './util.ts';

// /api/setup/{backups,restore} are public on purpose: after a total loss the database
// is empty, so there is no account to authenticate with. Both refuse once a user exists.
const PUBLIC_PATHS = [/^\/t\//, /^\/api\/(login|login\/mfa|setup|me)$/, /^\/api\/import(\?.*)?$/, /^\/api\/setup\/(backups|restore|storage-test)$/, /^\/api\/ingest\/[A-Za-z0-9_-]+(\/disposed)?(\?.*)?$/, /^\/(?!api|jmap)/];

export function registerRoutes(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    const su = await sessionUser(sessionToken(req));
    (req as any).sessionUser = su;
    if (PUBLIC_PATHS.some((re) => re.test(req.url))) return;
    if (!su) {
      reply.code(401).send({ error: 'unauthorized' });
    }
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
}
