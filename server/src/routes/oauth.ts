/** Google / Microsoft OAuth. */
import type { FastifyInstance } from 'fastify';
import { randomToken } from '../crypto.ts';
import { q, bumpState } from '../db.ts';
import { syncManager } from '../imap/sync.ts';
import { broadcast } from '../ws.ts';
import { saveOauthApp, startAuthUrl, handleCallback, redirectUri } from '../oauth.ts';
import { uid, isAdmin } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- OAuth (Google / Microsoft) ----
  app.get('/api/oauth/apps', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const rows = await q<any>('SELECT provider, client_id FROM oauth_apps');
    return rows.map((r) => ({ provider: r.provider, clientId: r.client_id }));
  });

  app.put('/api/oauth/apps/:provider', async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const provider = String((req.params as any).provider);
    if (provider !== 'google' && provider !== 'microsoft') return reply.code(400).send({ error: 'unknown provider' });
    const b = req.body as { clientId: string; clientSecret: string };
    if (!b.clientId || !b.clientSecret) return reply.code(400).send({ error: 'clientId and clientSecret required' });
    await saveOauthApp(provider, b.clientId.trim(), b.clientSecret.trim());
    return { ok: true, redirectUri: redirectUri(provider) };
  });

  app.get('/api/oauth/:provider/start', async (req, reply) => {
    const provider = String((req.params as any).provider) as 'google' | 'microsoft';
    if (provider !== 'google' && provider !== 'microsoft') return reply.code(400).send({ error: 'unknown provider' });
    const url = await startAuthUrl(uid(req), provider);
    if (!url) return reply.code(400).send({ error: `${provider} OAuth app not configured (Settings > Accounts)` });
    return { url };
  });

  app.get('/api/oauth/:provider/callback', async (req, reply) => {
    const provider = String((req.params as any).provider) as 'google' | 'microsoft';
    const { code, state, error } = req.query as any;
    // `error` comes straight from the query string: escape it for HTML, and keep the JSON
    // from closing the script tag. A per-response nonce lets this one inline script past the CSP.
    const back = (msg: string) => {
      const nonce = randomToken(16);
      const json = JSON.stringify({ seamlessOauth: msg }).replace(/</g, '\\u003c');
      const html = msg.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
      reply.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`);
      return reply.type('text/html').send(
        `<script nonce="${nonce}">window.opener?.postMessage(${json}, '*'); window.close();</script>` +
        `<p>${html} — you can close this window.</p>`);
    };
    if (error) return back(`Connection cancelled: ${error}`);
    try {
      const result = await handleCallback(provider, String(code), String(state));
      await syncManager.restartAccount(result.accountId);
      await bumpState();
      broadcast({ type: 'stateChange' }, uid(req));
      return back(`Connected ${result.email}`);
    } catch (err: any) {
      return back(`Connection failed: ${err?.message ?? err}`);
    }
  });
}
