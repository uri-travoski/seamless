import pg from 'pg';
import { config } from './config.ts';

// int8 (counts, BIGINT ms timestamps) come back as numbers, not strings
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

/** Convert `?` placeholders to Postgres `$n` so ported SQL stays readable. */
function ph(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(ph(sql), params as any[]);
  return res.rows as T[];
}

export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(sql, params))[0];
}

export async function run(sql: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query(ph(sql), params as any[]);
  return res.rowCount ?? 0;
}

/** INSERT helper that returns the new row id (0 when ON CONFLICT DO NOTHING skipped the insert). */
export async function insertId(sql: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query(ph(sql) + ' RETURNING id', params as any[]);
  return res.rows[0] ? Number(res.rows[0].id) : 0;
}

const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);

CREATE TABLE accounts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_secure BOOLEAN NOT NULL DEFAULT true,
  imap_user TEXT NOT NULL, imap_pass_enc TEXT NOT NULL,
  smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_secure BOOLEAN NOT NULL DEFAULT true,
  smtp_user TEXT NOT NULL, smtp_pass_enc TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2f7ed8',
  signature TEXT NOT NULL DEFAULT '',
  sent_copy BOOLEAN NOT NULL DEFAULT true,
  ai_categorize BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL
);
CREATE INDEX acct_user ON accounts(user_id);

CREATE TABLE mailboxes (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  delimiter TEXT NOT NULL DEFAULT '/',
  role TEXT,
  name TEXT NOT NULL,
  uidvalidity BIGINT NOT NULL DEFAULT 0,
  UNIQUE(account_id, path)
);

CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  uid BIGINT NOT NULL,
  message_id TEXT,
  in_reply_to TEXT,
  references_ids TEXT NOT NULL DEFAULT '[]',
  thread_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  from_addr TEXT NOT NULL DEFAULT '',
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  reply_to_json TEXT NOT NULL DEFAULT '[]',
  delivered_to TEXT,
  date BIGINT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  unread BOOLEAN NOT NULL DEFAULT true,
  flagged BOOLEAN NOT NULL DEFAULT false,
  answered BOOLEAN NOT NULL DEFAULT false,
  draft BOOLEAN NOT NULL DEFAULT false,
  has_attachments BOOLEAN NOT NULL DEFAULT false,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  s3_key TEXT,
  tracking_token TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE(mailbox_id, uid)
);
CREATE INDEX msg_list ON messages(mailbox_id, date DESC);
CREATE INDEX msg_thread ON messages(thread_id);
CREATE INDEX msg_msgid ON messages(message_id);
CREATE INDEX msg_account_date ON messages(account_id, date DESC);
CREATE INDEX msg_user_date ON messages(user_id, date DESC);

CREATE TABLE message_fts (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  addrs TEXT NOT NULL DEFAULT '',
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', left(coalesce(subject,'') || ' ' || coalesce(body,'') || ' ' || coalesce(addrs,''), 500000))
  ) STORED
);
CREATE INDEX msg_fts_tsv ON message_fts USING GIN (tsv);

CREATE TABLE labels (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#e05656',
  description TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, name)
);

CREATE TABLE message_labels (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id, label_id)
);

CREATE TABLE filters (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort INTEGER NOT NULL DEFAULT 0,
  match TEXT NOT NULL DEFAULT 'all',
  conditions TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  stop BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE tracking_opens (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL,
  ts BIGINT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT ''
);
CREATE INDEX opens_token ON tracking_opens(token);

CREATE TABLE ai_providers (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_enc TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT ''
);

CREATE TABLE ai_tasks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  provider_id INTEGER REFERENCES ai_providers(id) ON DELETE SET NULL,
  model TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY(user_id, task)
);

CREATE TABLE op_queue (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  keys_json TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE scheduled_sends (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  message_id TEXT,
  s3_key TEXT NOT NULL,
  envelope_from TEXT NOT NULL,
  envelope_to TEXT NOT NULL,
  send_at BIGINT NOT NULL,
  tracking_token TEXT,
  reply_to_email_id TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX sched_due ON scheduled_sends(send_at);

CREATE TABLE notes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY(user_id, email_id)
);
`,
  },
  {
    id: 2,
    sql: `
-- labels carry their retention (DESIGN.md §4)
ALTER TABLE labels
  ADD COLUMN parent_id INTEGER REFERENCES labels(id) ON DELETE SET NULL,
  ADD COLUMN keep_default BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN retention_days INTEGER,
  ADD COLUMN protected BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN auto_mark_read BOOLEAN NOT NULL DEFAULT false;

-- classification + retention state per message
ALTER TABLE messages
  ADD COLUMN headers_json TEXT NOT NULL DEFAULT '{}',         -- decisive raw headers (list-id, precedence, ...)
  ADD COLUMN classify_state TEXT NOT NULL DEFAULT 'pending',  -- pending|classified|needs_review
  ADD COLUMN review_reason TEXT,
  ADD COLUMN disposition TEXT NOT NULL DEFAULT 'keep',        -- keep|delete
  ADD COLUMN delete_at BIGINT,
  ADD COLUMN keep_reason TEXT,
  ADD COLUMN trashed_at BIGINT,
  ADD COLUMN opened_at BIGINT,
  ADD COLUMN user_touched BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX msg_retention ON messages(user_id, disposition, delete_at);
CREATE INDEX msg_classify ON messages(user_id, classify_state);

CREATE TABLE rules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  ord INTEGER NOT NULL DEFAULT 0,
  match_field TEXT NOT NULL,   -- from|from_domain|to|delivered_to|subject_contains|body_contains|header|list_id|category
  match_value TEXT NOT NULL,
  exclude_contains TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT 'label',  -- label|ai
  label_id INTEGER REFERENCES labels(id) ON DELETE CASCADE,
  stop BOOLEAN NOT NULL DEFAULT true,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual', -- manual|imported|suggested|promoted
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX rules_user_ord ON rules(user_id, ord);

CREATE TABLE preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  guidance TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL
);

CREATE TABLE user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(user_id, key)
);

CREATE TABLE routes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  label_id INTEGER REFERENCES labels(id) ON DELETE CASCADE,
  forward_to TEXT NOT NULL,
  only_after BIGINT,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE processing_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  email_id INTEGER,
  kind TEXT NOT NULL,   -- classify|retention|import|sync|send
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE INDEX plogs_user_time ON processing_logs(user_id, created_at DESC);
`,
  },
  {
    id: 3,
    sql: `
CREATE EXTENSION IF NOT EXISTS vector;

-- every AI verdict, auditable + cacheable (DESIGN.md §3c)
CREATE TABLE ai_decisions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  tier TEXT NOT NULL,               -- embedding|llm
  model TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL,             -- the orthogonal-fields JSON verbatim
  confidence REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  cache_key TEXT,
  preference_version INTEGER,
  latency_ms INTEGER,
  created_at BIGINT NOT NULL
);
CREATE INDEX aidec_email ON ai_decisions(email_id);
CREATE INDEX aidec_cache ON ai_decisions(user_id, cache_key);

-- the "memory": embeddings of labelled mail (dim varies by provider; exact scan per user+dim)
CREATE TABLE email_vectors (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  dim INTEGER NOT NULL,
  embedding vector NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX vec_user_dim ON email_vectors(user_id, dim);

-- the gold: every user correction (feeds the index + rule suggestions)
CREATE TABLE corrections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_id INTEGER,
  from_domain TEXT NOT NULL DEFAULT '',
  from_label_id INTEGER,
  to_label_id INTEGER,
  kind TEXT NOT NULL,               -- relabel|delete|restore
  created_at BIGINT NOT NULL
);
CREATE INDEX corr_user ON corrections(user_id, created_at DESC);

CREATE TABLE rule_suggestions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_field TEXT NOT NULL,
  match_value TEXT NOT NULL,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  evidence INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|dismissed
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, match_field, match_value, label_id)
);

-- per-sender/domain processing instructions ("teach the AI")
CREATE TABLE processor_notes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,              -- sender|domain
  scope_value TEXT NOT NULL,
  note TEXT NOT NULL,               -- plain English, injected into every AI decision for this scope
  label_id INTEGER REFERENCES labels(id) ON DELETE SET NULL,
  auto_read BOOLEAN NOT NULL DEFAULT false,
  retention_days INTEGER,
  delete_if_unread BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(user_id, scope, scope_value)
);

ALTER TABLE messages ADD COLUMN delete_if_unread BOOLEAN NOT NULL DEFAULT false;
`,
  },
  {
    id: 4,
    sql: `
-- instance-level OAuth app registrations (admin enters client id/secret once)
CREATE TABLE oauth_apps (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE CHECK (provider IN ('google','microsoft')),
  client_id TEXT NOT NULL,
  client_secret_enc TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

ALTER TABLE accounts
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'imap',              -- imap|gmail|microsoft
  ADD COLUMN oauth_refresh_enc TEXT,
  ADD COLUMN oauth_access_enc TEXT,
  ADD COLUMN oauth_expires_at BIGINT,
  ADD COLUMN safe_delete_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN safe_delete_mode TEXT NOT NULL DEFAULT 'trash', -- trash|expunge
  ADD COLUMN safe_delete_grace_days INTEGER NOT NULL DEFAULT 30;

-- origin-side lifecycle: once Seamless removes a message at the origin, the local
-- copy is the record and sync must never delete it
ALTER TABLE messages
  ADD COLUMN origin_state TEXT NOT NULL DEFAULT 'present',   -- present|removed
  ADD COLUMN origin_deleted_at BIGINT;
CREATE INDEX msg_origin ON messages(account_id, origin_state);

CREATE TABLE gmail_imports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running',                    -- running|done|error
  stats TEXT NOT NULL DEFAULT '{}',
  proposals TEXT NOT NULL DEFAULT '[]',
  started_at BIGINT NOT NULL,
  finished_at BIGINT
);

-- Gmail-history seeds aren't local messages: drop the FK, keep the PK
ALTER TABLE email_vectors DROP CONSTRAINT IF EXISTS email_vectors_message_id_fkey;
ALTER TABLE email_vectors ADD COLUMN source TEXT NOT NULL DEFAULT 'local';  -- local|gmail
`,
  },
  {
    id: 5,
    sql: `
-- per-device credentials for the IMAP/SMTP/CardDAV facades
CREATE TABLE app_passwords (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'imap,smtp,carddav',
  created_at BIGINT NOT NULL,
  last_used_at BIGINT
);

-- auto-built addressbook (send/reply history) + CardDAV representation
CREATE TABLE contacts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  org TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  sent_count INTEGER NOT NULL DEFAULT 0,
  received_count INTEGER NOT NULL DEFAULT 0,
  last_interaction_at BIGINT,
  auto_created BOOLEAN NOT NULL DEFAULT true,
  hidden BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX contacts_user ON contacts(user_id, hidden);

CREATE TABLE contact_emails (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY(contact_id, email)
);
CREATE INDEX contact_email_lookup ON contact_emails(email);

-- forwarding-out engine marker (routes table shipped in migration 2)
ALTER TABLE messages ADD COLUMN forwarded_at BIGINT;
`,
  },
  {
    id: 6,
    sql: `
-- "Teach the AI": content-similarity processor notes (anchor embedding + AI-parsed directives)
ALTER TABLE processor_notes ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE processor_notes ADD COLUMN IF NOT EXISTS embedding vector;
ALTER TABLE processor_notes ADD COLUMN IF NOT EXISTS embed_dim INTEGER;
`,
  },
  {
    id: 7,
    sql: `
-- T0 F-01: sessions expire (30 d idle / 90 d absolute) and can be listed + revoked
ALTER TABLE sessions
  ADD COLUMN last_seen_at BIGINT,
  ADD COLUMN expires_at BIGINT,
  ADD COLUMN ip TEXT NOT NULL DEFAULT '',
  ADD COLUMN user_agent TEXT NOT NULL DEFAULT '',
  ADD COLUMN label TEXT NOT NULL DEFAULT '';
UPDATE sessions SET last_seen_at = created_at,
  expires_at = LEAST(created_at + 7776000000, (extract(epoch FROM now()) * 1000)::bigint + 2592000000);
CREATE INDEX sessions_user ON sessions(user_id);

-- T0 F-02: second factor (TOTP now; WebAuthn columns reserved for passkeys)
CREATE TABLE user_mfa (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('totp','webauthn')),
  label TEXT NOT NULL DEFAULT '',
  secret_enc TEXT,
  credential_id TEXT,
  public_key TEXT,
  sign_count BIGINT DEFAULT 0,
  confirmed BOOLEAN NOT NULL DEFAULT false,
  last_step BIGINT,                 -- last accepted TOTP time step (replay guard)
  created_at BIGINT NOT NULL,
  last_used_at BIGINT
);
CREATE INDEX user_mfa_user ON user_mfa(user_id);
CREATE TABLE user_recovery_codes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at BIGINT,
  PRIMARY KEY (user_id, code_hash)
);
`,
  },
  {
    id: 8,
    sql: `
-- T0 F-04: one event bus feeds notifications (now), webhooks (T5) and the audit log (T6)
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE INDEX events_user_time ON events(user_id, created_at DESC);
CREATE INDEX events_type ON events(type);

CREATE TABLE notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id BIGINT REFERENCES events(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  group_key TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  read_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX notif_user_time ON notifications(user_id, created_at DESC);
CREATE INDEX notif_user_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notif_group_open ON notifications(user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL;

CREATE TABLE notification_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  in_app BOOLEAN NOT NULL DEFAULT true,
  push BOOLEAN NOT NULL DEFAULT false,
  email_digest BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, type)
);

-- a muted mailbox still records events, but raises no notifications
CREATE TABLE notification_mutes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, account_id)
);
`,
  },
];

/** Run `fn` in one transaction. Events emitted through the client are only turned into
 *  notifications after COMMIT, so a rollback leaves neither an event nor a notification. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    const after = afterCommit.get(client) ?? [];
    afterCommit.delete(client);
    for (const cb of after) await cb();
    return out;
  } catch (err) {
    afterCommit.delete(client);
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const afterCommit = new WeakMap<pg.PoolClient, (() => Promise<void>)[]>();

/** Queue work to run once `client`'s transaction commits (dropped on rollback). */
export function onCommit(client: pg.PoolClient, cb: () => Promise<void>): void {
  const list = afterCommit.get(client) ?? [];
  list.push(cb);
  afterCommit.set(client, list);
}

/** Same `?` placeholder style as q(), against a transaction client. */
export async function clientQuery<T = any>(client: pg.PoolClient, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(ph(sql), params as any[])).rows as T[];
}

export async function migrate(): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
  for (const m of MIGRATIONS) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [m.id]);
    if (done.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations(id, applied_at) VALUES ($1, $2)', [m.id, Date.now()]);
      await client.query('COMMIT');
      console.log(`[db] applied migration ${m.id}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

// Monotonic state counter: bump on any change the client should refetch for.
export async function bumpState(): Promise<string> {
  const res = await pool.query(`
    INSERT INTO settings(key, value) VALUES('state', '1')
    ON CONFLICT(key) DO UPDATE SET value = ((settings.value)::bigint + 1)::text
    RETURNING value
  `);
  return res.rows[0].value as string;
}

export async function currentState(): Promise<string> {
  return (await getSetting('state')) ?? '0';
}
