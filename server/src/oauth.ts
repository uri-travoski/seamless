import { assertLive } from './mode.ts';
import { syncAccountIdentities } from './business/identities.ts';
import { q, one, run, insertId } from './db.ts';
import { encrypt, decrypt, randomToken } from './crypto.ts';
import { config } from './config.ts';
import type { AccountRow } from './imap/sync.ts';

/**
 * Google / Microsoft OAuth2 for mail access. Both providers are consumed through
 * IMAP/SMTP XOAUTH2, so the whole sync + send engine stays identical to plain IMAP —
 * only the credential differs. Google's scope also covers the Gmail REST API used by
 * the learn-from-Gmail onboarding.
 */

export interface ProviderDef {
  authUrl: string;
  tokenUrl: string;
  scope: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  extraAuthParams: Record<string, string>;
}

export const PROVIDERS: Record<'google' | 'microsoft', ProviderDef> = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/ openid email',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  microsoft: {
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access openid email',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false }, // STARTTLS
    extraAuthParams: {},
  },
};

export async function getOauthApp(provider: string): Promise<{ clientId: string; clientSecret: string } | null> {
  const row = await one<any>('SELECT * FROM oauth_apps WHERE provider = ?', [provider]);
  if (!row) return null;
  return { clientId: row.client_id, clientSecret: decrypt(row.client_secret_enc) };
}

export async function saveOauthApp(provider: string, clientId: string, clientSecret: string): Promise<void> {
  await run(`
    INSERT INTO oauth_apps(provider, client_id, client_secret_enc, created_at) VALUES (?,?,?,?)
    ON CONFLICT(provider) DO UPDATE SET client_id = excluded.client_id, client_secret_enc = excluded.client_secret_enc
  `, [provider, clientId, encrypt(clientSecret), Date.now()]);
}

// short-lived state tokens binding the OAuth round-trip to the logged-in user
const pendingStates = new Map<string, { userId: number; provider: 'google' | 'microsoft'; ts: number }>();

export function redirectUri(provider: string): string {
  return `${config.publicUrl}/api/oauth/${provider}/callback`;
}

export async function startAuthUrl(userId: number, provider: 'google' | 'microsoft'): Promise<string | null> {
  const app = await getOauthApp(provider);
  if (!app) return null;
  const def = PROVIDERS[provider];
  const state = randomToken(20);
  pendingStates.set(state, { userId, provider, ts: Date.now() });
  for (const [s, v] of pendingStates) if (Date.now() - v.ts > 15 * 60_000) pendingStates.delete(s);
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri(provider),
    response_type: 'code',
    scope: def.scope,
    state,
    ...def.extraAuthParams,
  });
  return `${def.authUrl}?${params}`;
}

function jwtEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return payload.email ?? payload.preferred_username ?? null;
  } catch { return null; }
}

export interface CallbackResult { accountId: number; email: string; created: boolean }

/** Exchange the code, discover the mailbox address, create or refresh the account row. */
export async function handleCallback(provider: 'google' | 'microsoft', code: string, state: string): Promise<CallbackResult> {
  const pending = pendingStates.get(state);
  if (!pending || pending.provider !== provider) throw new Error('invalid or expired OAuth state');
  pendingStates.delete(state);
  const app = await getOauthApp(provider);
  if (!app) throw new Error('provider not configured');
  const def = PROVIDERS[provider];

  const res = await fetch(def.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: app.clientId, client_secret: app.clientSecret,
      code, grant_type: 'authorization_code', redirect_uri: redirectUri(provider),
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${(await res.text()).slice(0, 200)}`);
  const tok = (await res.json()) as any;
  if (!tok.refresh_token) throw new Error('no refresh token returned — remove the app from your account and connect again');
  const email = jwtEmail(tok.id_token);
  if (!email) throw new Error('could not determine the mailbox address');

  const expiresAt = Date.now() + (Number(tok.expires_in) || 3600) * 1000 - 60_000;
  const existing = await one<any>('SELECT id FROM accounts WHERE user_id = ? AND lower(email) = lower(?) AND kind = ?',
    [pending.userId, email, provider === 'google' ? 'gmail' : 'microsoft']);

  if (existing) {
    await run('UPDATE accounts SET oauth_refresh_enc = ?, oauth_access_enc = ?, oauth_expires_at = ?, enabled = true WHERE id = ?',
      [encrypt(tok.refresh_token), encrypt(tok.access_token), expiresAt, existing.id]);
    return { accountId: existing.id, email, created: false };
  }

  const id = await insertId(`
    INSERT INTO accounts(user_id, kind, name, email, aliases, imap_host, imap_port, imap_secure, imap_user, imap_pass_enc,
      smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, color,
      oauth_refresh_enc, oauth_access_enc, oauth_expires_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `, [
    pending.userId, provider === 'google' ? 'gmail' : 'microsoft', email.split('@')[0], email, '[]',
    def.imap.host, def.imap.port, def.imap.secure, email, '',
    def.smtp.host, def.smtp.port, def.smtp.secure, email, '',
    provider === 'google' ? '#d93025' : '#0f6cbd',
    encrypt(tok.refresh_token), encrypt(tok.access_token), expiresAt, Date.now(),
  ]);
  await syncAccountIdentities(id);
  return { accountId: id, email, created: true };
}

/** Fresh access token for an OAuth account, refreshing when near expiry. */
export async function freshAccessToken(accountId: number): Promise<string> {
  assertLive('signing in to mail servers');
  const acct = await one<any>('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!acct?.oauth_refresh_enc) throw new Error('not an OAuth account');
  if (acct.oauth_access_enc && acct.oauth_expires_at && acct.oauth_expires_at > Date.now()) {
    return decrypt(acct.oauth_access_enc);
  }
  const provider = acct.kind === 'gmail' ? 'google' : 'microsoft';
  const app = await getOauthApp(provider);
  if (!app) throw new Error('provider not configured');
  const res = await fetch(PROVIDERS[provider as 'google' | 'microsoft'].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: app.clientId, client_secret: app.clientSecret,
      refresh_token: decrypt(acct.oauth_refresh_enc), grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed: ${(await res.text()).slice(0, 200)}`);
  const tok = (await res.json()) as any;
  const expiresAt = Date.now() + (Number(tok.expires_in) || 3600) * 1000 - 60_000;
  await run('UPDATE accounts SET oauth_access_enc = ?, oauth_expires_at = ? WHERE id = ?',
    [encrypt(tok.access_token), expiresAt, accountId]);
  return tok.access_token as string;
}

/** imapflow / nodemailer credential for any account kind. */
export async function accountAuth(acct: Pick<AccountRow, 'id' | 'kind' | 'imap_user' | 'imap_pass_enc'>): Promise<{ user: string; pass?: string; accessToken?: string }> {
  if (acct.kind === 'gmail' || acct.kind === 'microsoft') {
    return { user: acct.imap_user, accessToken: await freshAccessToken(acct.id) };
  }
  return { user: acct.imap_user, pass: decrypt(acct.imap_pass_enc) };
}
