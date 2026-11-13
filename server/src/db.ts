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

export const MIGRATIONS: { id: number; sql: string }[] = [
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
  {
    id: 9,
    sql: `
-- T1 F-07: mailbox categories (Unified is virtual; Work/Personal/Disposable are built in)
CREATE TABLE mailbox_categories (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'folder',
  color TEXT NOT NULL DEFAULT '#2f7ed8',
  sort_order INTEGER NOT NULL DEFAULT 0,
  builtin BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, key)
);
CREATE TABLE mailbox_category_members (
  category_id INTEGER NOT NULL REFERENCES mailbox_categories(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (category_id, account_id)
);
CREATE INDEX mcm_account ON mailbox_category_members(account_id);
INSERT INTO mailbox_categories(user_id, key, name, icon, color, sort_order, builtin, created_at)
SELECT u.id, b.key, b.name, b.icon, b.color, b.ord, true, (extract(epoch FROM now()) * 1000)::bigint
FROM users u CROSS JOIN (VALUES
  ('work', 'Work', 'briefcase', '#2f7ed8', 1),
  ('personal', 'Personal', 'house', '#3f9c56', 2),
  ('disposable', 'Disposable', 'timer', '#b26a00', 3)
) AS b(key, name, icon, color, ord)
ON CONFLICT (user_id, key) DO NOTHING;
`,
  },
  {
    id: 10,
    sql: `
-- T1 F-11: label organisation (parent_id + sort already exist since migration 2)
ALTER TABLE labels ADD COLUMN sidebar_visibility TEXT NOT NULL DEFAULT 'always'
  CHECK (sidebar_visibility IN ('always','unread','hidden'));
CREATE INDEX labels_parent ON labels(parent_id);
`,
  },
  {
    id: 11,
    sql: `
-- T1 F-12: reusable templates with placeholders
CREATE TABLE templates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  shortcut TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX templates_user ON templates(user_id);
CREATE UNIQUE INDEX templates_shortcut ON templates(user_id, shortcut) WHERE shortcut IS NOT NULL AND shortcut <> '';
`,
  },
  {
    id: 12,
    sql: `
-- T1 F-15: per-send tracking records (optionally one token per recipient) + open classification
CREATE TABLE tracked_sends (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  group_token TEXT,              -- per-recipient copies point at the sent copy's token
  recipient TEXT,                -- null = whole message
  subject TEXT NOT NULL DEFAULT '',
  sent_at BIGINT NOT NULL
);
CREATE INDEX tracked_group ON tracked_sends(group_token);
ALTER TABLE tracking_opens
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS client TEXT,
  ADD COLUMN IF NOT EXISTS proxied BOOLEAN NOT NULL DEFAULT false;
`,
  },
  {
    id: 13,
    sql: `
-- T2: generic job runner + undo send / snooze / follow-ups
CREATE TABLE jobs (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  run_at BIGINT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  locked_until BIGINT,
  created_at BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE INDEX jobs_due ON jobs(run_at) WHERE status = 'pending';
CREATE INDEX jobs_user_kind ON jobs(user_id, kind, status);

ALTER TABLE messages ADD COLUMN snoozed_until BIGINT, ADD COLUMN sort_date BIGINT;
UPDATE messages SET sort_date = date;
CREATE INDEX msg_snoozed ON messages(user_id, snoozed_until) WHERE snoozed_until IS NOT NULL;
CREATE INDEX msg_sort ON messages(mailbox_id, sort_date DESC);

CREATE TABLE followups (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  message_id_header TEXT,
  thread_id TEXT,
  due_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','replied','due','cancelled')),
  job_id BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX followups_user ON followups(user_id, status);
CREATE INDEX followups_header ON followups(message_id_header) WHERE message_id IS NULL;
`,
  },
  {
    id: 15,
    sql: `
-- "Ignore this mailbox" in health checks, the status dot and failure alerts
ALTER TABLE accounts ADD COLUMN health_ignored BOOLEAN NOT NULL DEFAULT false;
`,
  },
  {
    id: 14,
    sql: `
-- T2 F-20: phishing / lookalike risk per message + the user's "this sender is safe" list
CREATE TABLE message_risk (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('none','medium','high')),
  reasons JSONB NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);
CREATE TABLE trusted_senders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('address','domain')),
  value TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, kind, value)
);
`,
  },
  {
    id: 16,
    sql: `
-- T3 F-22: outbound transports (SMTP presets now, API providers later) + inbound kind per mailbox
CREATE TABLE transports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config_enc TEXT NOT NULL,
  fallback_id INTEGER REFERENCES transports(id) ON DELETE SET NULL,
  daily_limit INTEGER,
  created_at BIGINT NOT NULL
);
CREATE INDEX transports_user ON transports(user_id);
ALTER TABLE accounts ADD COLUMN outbound_transport_id INTEGER REFERENCES transports(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN inbound_kind TEXT NOT NULL DEFAULT 'imap' CHECK (inbound_kind IN ('imap','pop3','push','none'));
`,
  },
  {
    id: 17,
    sql: `
-- T3 F-22: bounces (failed-delivery reports linked to the sent message)
CREATE TABLE bounces (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  diagnostic TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  UNIQUE (message_id, recipient)
);
CREATE INDEX bounces_user ON bounces(user_id);
`,
  },
  {
    id: 18,
    sql: `
-- T3 F-23: POP3 receive + local (non-IMAP) mailboxes
ALTER TABLE mailboxes ADD COLUMN next_uid INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN pop3_host TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN pop3_port INTEGER NOT NULL DEFAULT 995;
ALTER TABLE accounts ADD COLUMN pop3_secure BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE accounts ADD COLUMN pop3_user TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN pop3_pass_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN pop3_interval_min INTEGER NOT NULL DEFAULT 5;
ALTER TABLE accounts ADD COLUMN pop3_leave_on_server BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE accounts ADD COLUMN pop3_delete_after_days INTEGER;
CREATE TABLE pop3_seen (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  uidl TEXT NOT NULL,
  fetched_at BIGINT NOT NULL,
  message_row_id INTEGER,
  PRIMARY KEY (account_id, uidl)
);
`,
  },
  {
    id: 19,
    sql: `
-- T3 F-24: push inbound (Cloudflare Email Routing Worker -> signed POST). messages.delivered_to already exists.
CREATE TABLE push_inboxes (
  token TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  secret_enc TEXT NOT NULL,
  domains TEXT[] NOT NULL DEFAULT '{}',
  catch_all BOOLEAN NOT NULL DEFAULT true,
  unknown_policy TEXT NOT NULL DEFAULT 'deliver' CHECK (unknown_policy IN ('deliver','reject')),
  created_at BIGINT NOT NULL
);
CREATE INDEX push_inboxes_account ON push_inboxes(account_id);
CREATE TABLE push_seen (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  message_row_id INTEGER,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (account_id, dedupe_key)
);
`,
  },
  {
    id: 20,
    sql: `
-- T3 F-25: disposable addresses (aliases on a push/catch-all domain)
CREATE TABLE disposable_addresses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  address TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disposed')),
  expires_at BIGINT,
  forward_to_category INTEGER REFERENCES mailbox_categories(id) ON DELETE SET NULL,
  notify BOOLEAN NOT NULL DEFAULT true,
  received_count INTEGER NOT NULL DEFAULT 0,
  dropped_count INTEGER NOT NULL DEFAULT 0,
  last_received_at BIGINT,
  last_sender TEXT NOT NULL DEFAULT '',
  signup_domain TEXT,
  leak_domains TEXT[] NOT NULL DEFAULT '{}',
  disposed_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX disposable_user ON disposable_addresses(user_id);
CREATE INDEX disposable_account ON disposable_addresses(account_id);
ALTER TABLE messages ADD COLUMN disposable_id INTEGER REFERENCES disposable_addresses(id) ON DELETE SET NULL;
CREATE INDEX messages_disposable ON messages(disposable_id) WHERE disposable_id IS NOT NULL;
`,
  },
  {
    id: 21,
    sql: `
-- T3 F-26: storage targets (mail / backup / spool buckets chosen in the UI). creds_enc = encrypt(JSON {accessKey, secretKey})
CREATE TABLE storage_targets (
  id SERIAL PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('mail','backup','spool')),
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  region TEXT NOT NULL,
  bucket TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT 'seamless/',
  force_path_style BOOLEAN NOT NULL DEFAULT false,
  creds_enc TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  accept_same_bucket BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT NOT NULL,
  verified_at BIGINT,
  last_test TEXT
);
CREATE INDEX storage_targets_role ON storage_targets(role, active);
`,
  },
  {
    id: 22,
    sql: `
-- T3 F-27: verified storage migration. source_enc / dest_enc = encrypt(JSON S3Config) so rollback and cleanup
-- still work when the source was the environment's bucket (no storage_targets row).
CREATE TABLE storage_migrations (
  id SERIAL PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('mail','backup')),
  kind TEXT NOT NULL DEFAULT 'forward' CHECK (kind IN ('forward','rollback')),
  mode TEXT NOT NULL DEFAULT 'sample' CHECK (mode IN ('sample','strict')),
  status TEXT NOT NULL DEFAULT 'planning',
  from_target_id INTEGER,
  to_target_id INTEGER,
  source_enc TEXT NOT NULL,
  dest_enc TEXT NOT NULL,
  source_bucket TEXT NOT NULL,
  dest_bucket TEXT NOT NULL,
  source_prefix TEXT NOT NULL DEFAULT '',
  related_id INTEGER,
  total_items INTEGER NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  copied_items INTEGER NOT NULL DEFAULT 0,
  copied_bytes BIGINT NOT NULL DEFAULT 0,
  verified_items INTEGER NOT NULL DEFAULT 0,
  retain_until BIGINT,
  error TEXT,
  started_by INTEGER,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT,
  switched_at BIGINT,
  cleaned_at BIGINT
);
CREATE TABLE storage_migration_items (
  id BIGSERIAL PRIMARY KEY,
  migration_id INTEGER NOT NULL REFERENCES storage_migrations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  size BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','copied','verified','failed')),
  to_verify BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  UNIQUE (migration_id, key)
);
CREATE INDEX storage_migration_items_status ON storage_migration_items(migration_id, status);
`,
  },
  {
    id: 23,
    sql: `
-- T3 F-28: blob mirror index. One row per mail blob already copied to the backup store, so the
-- next run copies only new keys. prefix = the mirror prefix the copy went to (a changed backup
-- prefix means the old rows no longer count).
CREATE TABLE backup_blob_index (
  key TEXT PRIMARY KEY,
  size BIGINT NOT NULL DEFAULT 0,
  mirrored_at BIGINT NOT NULL,
  prefix TEXT NOT NULL DEFAULT ''
);
`,
  },
  {
    id: 24,
    sql: `
-- T4 F-30: businesses and per-address identities.
CREATE TABLE businesses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL DEFAULT '',
  logo_key TEXT,
  brand_color TEXT NOT NULL DEFAULT '#2f7ed8',
  website TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  abn TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  default_signature_html TEXT NOT NULL DEFAULT '',
  disclaimer_html TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX businesses_user ON businesses(user_id);
CREATE TABLE identities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  signature_html TEXT,
  reply_to TEXT,
  bcc_self BOOLEAN NOT NULL DEFAULT false,
  transport_id INTEGER REFERENCES transports(id) ON DELETE SET NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (account_id, email)
);
CREATE INDEX identities_user ON identities(user_id);
INSERT INTO identities(user_id, account_id, email, display_name, signature_html, is_default)
  SELECT user_id, id, email, CASE WHEN name <> '' THEN name ELSE email END, NULLIF(signature, ''), true FROM accounts
  ON CONFLICT DO NOTHING;
INSERT INTO identities(user_id, account_id, email, display_name, is_default)
  SELECT a.user_id, a.id, al.v, CASE WHEN a.name <> '' THEN a.name ELSE al.v END, false
  FROM accounts a, LATERAL jsonb_array_elements_text(a.aliases::jsonb) AS al(v)
  ON CONFLICT DO NOTHING;
`,
  },
  {
    id: 25,
    sql: `
-- T4 F-30: wrong-business guard can be switched off per contact.
ALTER TABLE contacts ADD COLUMN no_business_guard BOOLEAN NOT NULL DEFAULT false;
`,
  },
  {
    id: 26,
    sql: `
-- T4 F-31: quick replies
ALTER TABLE templates ADD COLUMN business_id INTEGER REFERENCES businesses ON DELETE SET NULL;
ALTER TABLE templates ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE templates ADD COLUMN pin_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE templates ADD COLUMN send_direct BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE templates ADD COLUMN last_used_at BIGINT;
ALTER TABLE templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'reply';
`,
  },
  {
    id: 27,
    sql: `
-- T4 F-32: shared mailboxes. Shared mail rows keep messages.user_id = the owner.
CREATE TABLE mailbox_shares (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer','responder','manager')),
  created_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX mailbox_shares_user ON mailbox_shares(user_id);
CREATE TABLE assignments (
  message_thread_id TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','done')),
  due_at BIGINT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (account_id, message_thread_id)
);
CREATE TABLE thread_comments (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_thread_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  mentions INTEGER[] NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE INDEX thread_comments_thread ON thread_comments(account_id, message_thread_id);
`,
  },
  {
    id: 28,
    sql: `
-- T4 F-33: calendar invites (iMIP) + optional CalDAV connection
CREATE TABLE calendar_invites (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  uid TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'REQUEST',
  summary TEXT NOT NULL DEFAULT '',
  starts_at BIGINT,
  ends_at BIGINT,
  all_day BOOLEAN NOT NULL DEFAULT false,
  tz TEXT,
  location TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  organizer JSONB,
  attendees JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  my_partstat TEXT,
  raw_ics TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, uid)
);
CREATE INDEX calendar_invites_message ON calendar_invites(message_id);
CREATE TABLE calendar_connections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id)
);
`,
  },
  {
    id: 29,
    sql: `
-- T4 F-34: saved searches / smart views
CREATE TABLE saved_views (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'magnifying-glass',
  color TEXT,
  query TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'unified',
  sort TEXT NOT NULL DEFAULT 'date_desc',
  pinned BOOLEAN NOT NULL DEFAULT true,
  show_count BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notify BOOLEAN NOT NULL DEFAULT false,
  last_notified_message_id INTEGER
);
CREATE INDEX saved_views_user ON saved_views(user_id, sort_order);
`,
  },
  {
    id: 30,
    sql: `
-- T4 F-35: VIP senders (the mute half of F-35 was dropped by the user)
CREATE TABLE vip_senders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('address','domain')),
  value TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, kind, value)
);
`,
  },
  {
    id: 31,
    sql: `
-- T5 F-36: outgoing webhooks
CREATE TABLE webhooks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  event_types TEXT[] NOT NULL,
  filter_query TEXT,
  include TEXT NOT NULL DEFAULT 'metadata' CHECK (include IN ('metadata','body','attachments','raw')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL
);
CREATE INDEX webhooks_user ON webhooks(user_id);
CREATE TABLE webhook_deliveries (
  id BIGSERIAL PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  http_status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT,
  last_error TEXT,
  request_body TEXT,
  response_snippet TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries(webhook_id, id DESC);
CREATE TABLE webhook_allowlist (
  id SERIAL PRIMARY KEY,
  cidr_or_host TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);
`,
  },
  {
    id: 32,
    sql: `
-- T5.2 F-36: connector presets on top of webhooks (dms | bizbooks | todoist | vikunja | task-webhook)
ALTER TABLE webhooks ADD COLUMN connector TEXT;
ALTER TABLE webhooks ADD COLUMN connector_config_enc TEXT;
`,
  },
  {
    id: 33,
    sql: `
-- T5.3 F-37: personal API tokens for REST v1 (only the sha256 of the token is stored)
CREATE TABLE api_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  last_used_at BIGINT,
  expires_at BIGINT,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);
`,
  },
  {
    id: 34,
    sql: `
-- T5.4 F-38: lead capture (sources are search-language queries; leads keep the parsed form fields)
CREATE TABLE lead_sources (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL
);
CREATE INDEX lead_sources_user ON lead_sources(user_id);
CREATE TABLE leads (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  source_id INTEGER REFERENCES lead_sources(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  name TEXT, email TEXT, phone TEXT, suburb TEXT, service TEXT, details TEXT,
  fields JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','quoted','won','lost','spam')),
  repeat_count INTEGER NOT NULL DEFAULT 0,
  first_reply_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX leads_user_created ON leads(user_id, created_at DESC);
CREATE INDEX leads_user_email ON leads(user_id, lower(email));
`,
  },
  {
    id: 35,
    sql: `
-- T6.2 F-41: text extracted from attachments, searched together with the body
CREATE TABLE attachment_text (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(coalesce(filename,'') || ' ' || coalesce(text,''), 500000))) STORED,
  created_at BIGINT NOT NULL,
  UNIQUE (message_id, part_id)
);
CREATE INDEX attachment_text_tsv ON attachment_text USING GIN (tsv);
CREATE INDEX attachment_text_user ON attachment_text(user_id);
`,
  },
  {
    id: 36,
    sql: `
-- T6.3 F-40: newsletter detection, per-sender choice, Read later
ALTER TABLE messages ADD COLUMN is_newsletter BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN newsletter_sender TEXT;
ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT;
ALTER TABLE messages ADD COLUMN list_unsubscribe_post TEXT;
ALTER TABLE messages ADD COLUMN read_later BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN read_later_at BIGINT;
ALTER TABLE messages ADD COLUMN read_minutes INTEGER;
CREATE INDEX messages_read_later ON messages(user_id, read_later) WHERE read_later;
CREATE TABLE newsletter_senders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('inbox','read_later','unsubscribed')),
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, sender)
);
`,
  },
  {
    id: 37,
    sql: `
-- T6.4 F-39: OpenPGP keys (own keys keep the private key encrypted under SEAMLESS_SECRET; contact keys are public only)
CREATE TABLE pgp_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity_id INTEGER REFERENCES identities(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('own','contact')),
  email TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  public_armored TEXT NOT NULL,
  private_enc TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, fingerprint)
);
CREATE INDEX pgp_keys_user_email ON pgp_keys(user_id, lower(email));
`,
  },
  {
    id: 38,
    sql: `
-- T6.5 F-39: S/MIME certificates (own certs keep the PKCS#8 private key encrypted under SEAMLESS_SECRET; contact certs are public only)
CREATE TABLE smime_certs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity_id INTEGER REFERENCES identities(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('own','contact')),
  email TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  subject TEXT NOT NULL,
  issuer TEXT NOT NULL,
  serial TEXT NOT NULL,
  cert_pem TEXT NOT NULL,
  key_enc TEXT,
  not_after BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, fingerprint)
);
CREATE INDEX smime_certs_user_email ON smime_certs(user_id, lower(email));
`,
  },
  {
    id: 39,
    sql: `
-- T6.1 F-42: append-only audit log. No FK on the actor: rows must outlive a deleted user.
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id INTEGER,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','api_token','system')),
  actor_token_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip TEXT,
  user_agent TEXT,
  details JSONB,
  created_at BIGINT NOT NULL
);
CREATE INDEX audit_log_actor ON audit_log(actor_user_id, created_at DESC);
CREATE INDEX audit_log_action ON audit_log(action, created_at DESC);
CREATE INDEX audit_log_time ON audit_log(created_at DESC);
-- The app's DB user owns the table, so REVOKE would protect nothing: guard with triggers.
-- Only the retention job (and restore/test reset) sets seamless.audit_prune = 'on' inside its transaction.
CREATE FUNCTION audit_log_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('seamless.audit_prune', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF TG_OP = 'TRUNCATE' THEN RETURN NULL; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_guard();
`,
  },
  {
    id: 40,
    // Mail lists sort by COALESCE(sort_date, date): give that exact expression an index so opening the Inbox of a
    // huge mailbox walks the newest rows instead of sorting every matching one.
    sql: `
CREATE INDEX msg_sort_expr ON messages ((COALESCE(sort_date, date)) DESC, id DESC);
`,
  },
  {
    id: 41,
    // T8.1: admin tools. must_change_password = temporary password set by an admin; disabled = cannot sign in, sync off;
    // storage_quota_bytes NULL = unlimited. quota_alerts remembers which threshold already raised a notification.
    sql: `
ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN last_login_at BIGINT;
ALTER TABLE users ADD COLUMN storage_quota_bytes BIGINT;
CREATE TABLE quota_alerts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('warning','full')),
  raised_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, level)
);
`,
  },
  {
    id: 42,
    // T8.2: shared labels. The share row says whether the owner offered their labels and what the invitee answered;
    // shared_label_offers = the picked labels (no rows = all of the owner's labels).
    sql: `
ALTER TABLE mailbox_shares ADD COLUMN labels_shared BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE mailbox_shares ADD COLUMN labels_status TEXT NOT NULL DEFAULT 'none' CHECK (labels_status IN ('none','pending','accepted','rejected'));
ALTER TABLE mailbox_shares ADD COLUMN labels_later_at BIGINT;
CREATE TABLE shared_label_offers (
  account_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, user_id, label_id),
  FOREIGN KEY (account_id, user_id) REFERENCES mailbox_shares(account_id, user_id) ON DELETE CASCADE
);
`,
  },
  {
    id: 43,
    // T8.3: per-mailbox team settings. allow_snooze = responders/managers may snooze for everyone; auto_assign = round robin of
    // NEW live threads over mailbox_rr_members (row = takes part, active = not away). rr_cursor = user id last assigned.
    sql: `
CREATE TABLE mailbox_team_settings (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  allow_snooze BOOLEAN NOT NULL DEFAULT false,
  auto_assign TEXT NOT NULL DEFAULT 'off' CHECK (auto_assign IN ('off','round_robin')),
  rr_cursor INTEGER
);
CREATE TABLE mailbox_rr_members (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (account_id, user_id)
);
ALTER TABLE messages ADD COLUMN snoozed_by INTEGER;
`,
  },
  {
    id: 44,
    // T8.4: archive old mail. items.message_id has no FK on purpose: in move mode the message row is deleted after the copy is verified.
    sql: `
CREATE TABLE mail_archives (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  older_than_days INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',
  mode TEXT NOT NULL CHECK (mode IN ('copy','move')),
  target_id INTEGER REFERENCES storage_targets(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','running','verifying','done','failed','restoring')),
  message_count INTEGER NOT NULL DEFAULT 0,
  byte_count BIGINT NOT NULL DEFAULT 0,
  options JSONB NOT NULL DEFAULT '{}',
  index_files JSONB NOT NULL DEFAULT '[]',
  restore_result JSONB,
  cutoff BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT,
  error TEXT,
  manifest_key TEXT
);
CREATE INDEX mail_archives_user ON mail_archives(user_id, id DESC);
CREATE TABLE mail_archive_items (
  archive_id INTEGER NOT NULL REFERENCES mail_archives(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  mailbox_path TEXT NOT NULL,
  uid BIGINT NOT NULL,
  s3_key TEXT NOT NULL,
  sha256 TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','copied','verified','removed','failed')),
  error TEXT,
  PRIMARY KEY (archive_id, message_id)
);
CREATE INDEX mail_archive_items_state ON mail_archive_items(archive_id, state);
`,
  },
  {
    id: 45,
    // T8.5: optional monthly archive rule (one per user) with a notification summary.
    sql: `
CREATE TABLE archive_schedules (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  older_than_days INTEGER NOT NULL DEFAULT 1095,
  scope TEXT NOT NULL DEFAULT 'all',
  mode TEXT NOT NULL DEFAULT 'copy' CHECK (mode IN ('copy','move')),
  target_id INTEGER REFERENCES storage_targets(id) ON DELETE SET NULL,
  options JSONB NOT NULL DEFAULT '{}',
  next_due_at BIGINT,
  last_run_at BIGINT,
  last_archive_id INTEGER
);
`,
  },
  {
    id: 46,
    // T8.6: open an archive in another instance. archive_imports = one row per archive being imported (from a bucket,
    // an uploaded .zip or a folder); mail_archive_imports = which archived message keys already arrived (idempotent resume).
    // Read-only "archived mailboxes" are accounts with archived = true (inbound_kind 'none', enabled = false: never polled).
    sql: `
ALTER TABLE storage_targets DROP CONSTRAINT IF EXISTS storage_targets_role_check;
ALTER TABLE storage_targets ADD CONSTRAINT storage_targets_role_check CHECK (role IN ('mail','backup','spool','archive_source'));
CREATE TABLE archive_imports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('bucket','zip','folder')),
  target_id INTEGER REFERENCES storage_targets(id) ON DELETE SET NULL,
  source_ref TEXT NOT NULL DEFAULT '',
  archive_path TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','paused','done','failed')),
  options JSONB NOT NULL DEFAULT '{}',
  summary JSONB NOT NULL DEFAULT '{}',
  total INTEGER,
  imported INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  config_result JSONB,
  account_ids JSONB NOT NULL DEFAULT '[]',
  error TEXT,
  created_at BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE INDEX archive_imports_user ON archive_imports(user_id, id DESC);
CREATE TABLE mail_archive_imports (
  import_id INTEGER NOT NULL REFERENCES archive_imports(id) ON DELETE CASCADE,
  message_key TEXT NOT NULL,
  message_id INTEGER,
  state TEXT NOT NULL CHECK (state IN ('imported','skipped','failed')),
  error TEXT,
  PRIMARY KEY (import_id, message_key)
);
ALTER TABLE accounts ADD COLUMN archived BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN source_archive_id INTEGER;
`,
  },
  {
    id: 47,
    // T8.9: critical alerts. alert_channels = where to send (config_enc holds the secrets, encrypted with SEAMLESS_SECRET);
    // scope 'team' = an admin's channel that also gets alerts about shared mailboxes and instance problems.
    // alerts = one open row per problem (unique partial index); deliveries = per-channel result of the send.
    sql: `
CREATE TABLE alert_channels (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('email','twilio','sms_gateway','telegram')),
  name TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user','team')),
  config_enc TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  verified_at BIGINT,
  last_ok_at BIGINT,
  last_error TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX alert_channels_user ON alert_channels(user_id);
CREATE TABLE alerts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'critical' CHECK (severity IN ('critical')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  account_id INTEGER,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved')),
  read_at BIGINT,
  opened_at BIGINT NOT NULL,
  resolved_at BIGINT,
  last_sent_at BIGINT,
  send_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT,
  recovered_sent BOOLEAN NOT NULL DEFAULT false,
  deliveries JSONB NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX alerts_one_open ON alerts(user_id, kind, source_type, source_id) WHERE state = 'open';
CREATE INDEX alerts_user ON alerts(user_id, id DESC);
`,
  },
  {
    id: 48,
    // T8.10: AI transparency + sticky corrections. email_vectors gain a weight (a user-corrected example counts for more)
    // and the embedding model (so a provider switch can be re-embedded lazily); corrections keep what is needed to undo.
    sql: `
ALTER TABLE email_vectors ADD COLUMN weight REAL NOT NULL DEFAULT 1;
ALTER TABLE email_vectors ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE email_vectors ADD COLUMN corrected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE corrections ADD COLUMN source TEXT NOT NULL DEFAULT 'label';   -- label|fix|move
ALTER TABLE corrections ADD COLUMN remembered BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE corrections ADD COLUMN why TEXT NOT NULL DEFAULT '';
ALTER TABLE corrections ADD COLUMN undo_json TEXT;
ALTER TABLE corrections ADD COLUMN undone BOOLEAN NOT NULL DEFAULT false;
`,
  },
  {
    id: 49,
    // T8.11: contact management. Email labels, phones, groups; "undo" of an auto-save is remembered so neither the instant
    // path nor the batch harvest recreates that contact.
    sql: `
ALTER TABLE contact_emails ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN phones_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE contact_groups (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX contact_groups_name ON contact_groups(user_id, lower(name));
CREATE TABLE contact_group_members (
  group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY(group_id, contact_id)
);
CREATE INDEX contact_group_members_contact ON contact_group_members(contact_id);
CREATE TABLE contact_suppressed (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(user_id, email)
);
`,
  },
  {
    id: 50,
    // T9.1: Android app. Sessions remember which client made them (90 days renewed on use for the app);
    // mobile_devices holds the FCM token per signed-in phone and goes away with its session.
    sql: `
ALTER TABLE sessions ADD COLUMN client TEXT NOT NULL DEFAULT '';
CREATE TABLE mobile_devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(token) ON DELETE CASCADE,
  fcm_token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'android',
  device_name TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  notify_mail BOOLEAN NOT NULL DEFAULT true,
  notify_alerts BOOLEAN NOT NULL DEFAULT true,
  hide_content BOOLEAN NOT NULL DEFAULT false,
  last_seen_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX mobile_devices_user ON mobile_devices(user_id);
`,
  },
  {
    id: 51,
    // T10.1: catch-all mailbox for disposable addresses. A normal IMAP/POP3 account can be flagged `catchall`:
    // it stops being listed and is only fetched and routed into a local destination account (a push inbox that
    // lists the catch-all domains). Unknown addresses can be quarantined (kept a week, then purged).
    sql: `
ALTER TABLE accounts ADD COLUMN catchall BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN catchall_after TEXT NOT NULL DEFAULT 'move' CHECK (catchall_after IN ('move','delete','leave'));
ALTER TABLE accounts ADD COLUMN catchall_clean_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE accounts ADD COLUMN catchall_dest_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE push_inboxes DROP CONSTRAINT IF EXISTS push_inboxes_unknown_policy_check;
ALTER TABLE push_inboxes ADD CONSTRAINT push_inboxes_unknown_policy_check CHECK (unknown_policy IN ('deliver','reject','drop','quarantine'));
ALTER TABLE push_inboxes ADD COLUMN domain_policies JSONB NOT NULL DEFAULT '{}';
ALTER TABLE push_inboxes ADD COLUMN source_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE;
CREATE TABLE catchall_seen (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  handled BOOLEAN NOT NULL DEFAULT false,
  outcome TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (account_id, source_key)
);
CREATE TABLE unknown_addresses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'quarantine' CHECK (status IN ('quarantine','blocked')),
  received_count INTEGER NOT NULL DEFAULT 0,
  dropped_count INTEGER NOT NULL DEFAULT 0,
  last_from TEXT NOT NULL DEFAULT '',
  last_subject TEXT NOT NULL DEFAULT '',
  first_at BIGINT NOT NULL,
  last_at BIGINT NOT NULL,
  UNIQUE (account_id, address)
);
CREATE TABLE quarantined_mail (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  unknown_id INTEGER NOT NULL REFERENCES unknown_addresses(id) ON DELETE CASCADE,
  s3_key TEXT NOT NULL,
  from_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  received_at BIGINT NOT NULL
);
CREATE INDEX quarantined_mail_unknown ON quarantined_mail(unknown_id);
`,
  },
  {
    id: 52,
    // T10.2: paused + disposed become one status, `stopped`. Counters are kept; stopped_at/stopped_stored drive the
    // Bin window (15 days / 100 mails) and the 6-month automatic cleanup. keep_all = "keep everything from this address".
    sql: `
ALTER TABLE disposable_addresses DROP CONSTRAINT IF EXISTS disposable_addresses_status_check;
UPDATE disposable_addresses SET status = 'stopped' WHERE status IN ('paused','disposed');
ALTER TABLE disposable_addresses ADD CONSTRAINT disposable_addresses_status_check CHECK (status IN ('active','stopped'));
ALTER TABLE disposable_addresses ADD COLUMN stopped_at BIGINT;
ALTER TABLE disposable_addresses ADD COLUMN stopped_stored INTEGER NOT NULL DEFAULT 0;
ALTER TABLE disposable_addresses ADD COLUMN keep_all BOOLEAN NOT NULL DEFAULT false;
UPDATE disposable_addresses SET stopped_at = COALESCE(disposed_at, (extract(epoch from now()) * 1000)::bigint) WHERE status = 'stopped';
ALTER TABLE push_inboxes ADD COLUMN reject_stopped BOOLEAN NOT NULL DEFAULT false;
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

export async function migrate(db: pg.Pool = pool): Promise<void> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
  for (const m of MIGRATIONS) {
    const done = await db.query('SELECT 1 FROM schema_migrations WHERE id = $1', [m.id]);
    if (done.rowCount) continue;
    const client = await db.connect();
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
