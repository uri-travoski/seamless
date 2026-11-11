/** App passwords for the IMAP/SMTP/CardDAV facades. */
import type { FastifyInstance } from 'fastify';
import { q, run } from '../db.ts';
import { createAppPassword } from '../facade/auth.ts';
import { config } from '../config.ts';
import { uid } from './util.ts';

export function register(app: FastifyInstance): void {
  // ---- devices (app passwords for the IMAP/SMTP/CardDAV facades) ----
  app.get('/api/devices', async (req) =>
    (await q<any>('SELECT id, label, scopes, created_at, last_used_at FROM app_passwords WHERE user_id = ? ORDER BY id DESC', [uid(req)])).map((d) => ({
      id: d.id, label: d.label, scopes: d.scopes.split(','),
      createdAt: new Date(d.created_at).toISOString(),
      lastUsedAt: d.last_used_at ? new Date(d.last_used_at).toISOString() : null,
    })));

  app.post('/api/devices', async (req) => {
    const b = req.body as { label: string; scopes?: string[] };
    const scopes = (b.scopes?.length ? b.scopes : ['imap', 'smtp', 'carddav']).filter((s) => ['imap', 'smtp', 'carddav'].includes(s));
    return createAppPassword(uid(req), b.label || 'Device', scopes);
  });

  app.delete('/api/devices/:id', async (req) => {
    await run('DELETE FROM app_passwords WHERE id = ? AND user_id = ?', [Number((req.params as any).id), uid(req)]);
    return { ok: true };
  });

  app.get('/api/devices/server-info', async () => {
    const host = new URL(config.publicUrl).hostname;
    return {
      imap: { host, port: config.facade.imapPort, tls: !!(config.facade.tlsKeyFile && config.facade.tlsCertFile) },
      smtp: { host, port: config.facade.smtpPort, tls: false },
      carddav: `${config.publicUrl}/dav/`,
    };
  });
}
