/**
 * Which successful (status < 400) session-authenticated requests are audited, and under which action name.
 * Keyed by `METHOD <fastify route pattern>`. Request bodies are never stored (they carry passwords and keys);
 * only the target id from the URL and a few non-secret facts. Login and bulk-delete are audited in their routes
 * because the status code alone does not tell the story there.
 */
export interface RouteAudit { action: string; type?: string; idParam?: string }

const r = (action: string, type?: string, idParam = 'id'): RouteAudit => ({ action, type, idParam });

export const AUDITED_ROUTES: Record<string, RouteAudit> = {
  // 2FA, sessions, users
  'POST /api/security/totp/confirm': r('2fa.enable', 'user'),
  'POST /api/security/totp/disable': r('2fa.disable', 'user'),
  'POST /api/security/recovery/regenerate': r('2fa.recovery_regenerate', 'user'),
  'PUT /api/security/policy': r('2fa.policy', 'instance'),
  'DELETE /api/sessions/:id': r('session.revoke', 'session'),
  'POST /api/sessions/revoke-others': r('session.revoke_others', 'user'),
  'POST /api/users': r('user.create', 'user'),
  'DELETE /api/users/:id': r('user.delete', 'user'),
  'PUT /api/users/password': r('user.password_change', 'user'),
  'PUT /api/mode': r('instance.mode', 'instance'),
  'PUT /api/alerts/settings': r('alerts.settings', 'instance'),
  'POST /api/alert-channels': r('alerts.channel_add', 'alert_channel'),
  'DELETE /api/alert-channels/:id': r('alerts.channel_delete', 'alert_channel'),
  // accounts, transports
  'POST /api/accounts': r('account.add', 'account'),
  'PUT /api/accounts/:id': r('account.update', 'account'),
  'DELETE /api/accounts/:id': r('account.remove', 'account'),
  'PUT /api/accounts/:id/safe-delete': r('account.safe_delete_change', 'account'),
  'POST /api/transports': r('transport.create', 'transport'),
  'PUT /api/transports/:id': r('transport.update', 'transport'),
  'DELETE /api/transports/:id': r('transport.delete', 'transport'),
  'PUT /api/accounts/:id/transport': r('transport.assign', 'account'),
  // storage
  'POST /api/storage/targets': r('storage.target_create', 'storage_target'),
  'PUT /api/storage/targets/:id': r('storage.target_update', 'storage_target'),
  'POST /api/storage/migrations': r('storage.migration_start', 'storage_migration'),
  'POST /api/storage/migrations/:id/pause': r('storage.migration_pause', 'storage_migration'),
  'POST /api/storage/migrations/:id/resume': r('storage.migration_resume', 'storage_migration'),
  'POST /api/storage/migrations/:id/cancel': r('storage.migration_cancel', 'storage_migration'),
  'POST /api/storage/migrations/:id/finish': r('storage.migration_finish', 'storage_migration'),
  // backup
  'PUT /api/backup': r('backup.settings', 'instance'),
  'POST /api/backup/run': r('backup.run', 'instance'),
  'POST /api/setup/restore': r('backup.restore', 'instance'),
  'POST /api/export': r('backup.export', 'instance'),
  'POST /api/import': r('backup.import', 'instance'),
  // rules + filters
  'POST /api/rules': r('rule.create', 'rule'),
  'PUT /api/rules/:id': r('rule.update', 'rule'),
  'DELETE /api/rules/:id': r('rule.delete', 'rule'),
  'POST /api/suggestions/:id/accept': r('rule.suggestion_accept', 'suggestion'),
  'POST /api/filters': r('filter.create', 'filter'),
  'PUT /api/filters/:id': r('filter.update', 'filter'),
  'DELETE /api/filters/:id': r('filter.delete', 'filter'),
  'POST /api/filters/:id/run': r('filter.run', 'filter'),
  // webhooks + API tokens
  'POST /api/webhooks': r('webhook.create', 'webhook'),
  'PUT /api/webhooks/:id': r('webhook.update', 'webhook'),
  'DELETE /api/webhooks/:id': r('webhook.delete', 'webhook'),
  'POST /api/webhooks/:id/rotate': r('webhook.rotate_secret', 'webhook'),
  'POST /api/webhook-allowlist': r('webhook.allowlist_add', 'instance'),
  'DELETE /api/webhook-allowlist/:id': r('webhook.allowlist_remove', 'instance'),
  'POST /api/api-tokens': r('api_token.create', 'api_token'),
  'DELETE /api/api-tokens/:id': r('api_token.delete', 'api_token'),
  // sharing
  'PUT /api/accounts/:id/shares': r('share.grant', 'account'),
  'DELETE /api/accounts/:id/shares/:userId': r('share.revoke', 'account'),
  // disposable addresses
  'POST /api/disposable/:id/dispose': r('disposable.dispose', 'disposable'),
  'POST /api/disposable/:id/undispose': r('disposable.undispose', 'disposable'),
  'POST /api/disposable/bulk': r('disposable.bulk', 'disposable'),
  // keys + certificates, newsletters, indexing
  'POST /api/pgp/keys/generate': r('pgp.key_generate', 'pgp_key'),
  'POST /api/pgp/keys/import': r('pgp.key_import', 'pgp_key'),
  'DELETE /api/pgp/keys/:id': r('pgp.key_delete', 'pgp_key'),
  'POST /api/smime/certs/import-p12': r('smime.cert_import', 'smime_cert'),
  'POST /api/smime/certs/import': r('smime.cert_import', 'smime_cert'),
  'DELETE /api/smime/certs/:id': r('smime.cert_delete', 'smime_cert'),
  'POST /api/newsletters/unsubscribe': r('newsletter.unsubscribe', 'newsletter'),
  'POST /api/health/attachment-index': r('attachments.backfill_start', 'instance'),
};
