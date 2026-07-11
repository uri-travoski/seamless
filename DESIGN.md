# Seamless — Design & Build Plan

Self-hosted, AI-native webmail. Successor to MailDeck: keeps every MailDeck feature, adds an
AI classification + retention pipeline ("keep only what's worth keeping"), connects to
Gmail / Microsoft / Apple / any IMAP server, and — via built-in IMAP/SMTP/CardDAV facades —
lets standard mobile and desktop mail clients connect to Seamless itself. Multi-user.

**App name:** Seamless · **Icon:** provided SVG (voicemail-style "@" mark) → `web/public/icon.svg`, used for PWA manifest + favicon.

---

## 0. Decisions (locked 2026-07-11)

| Decision | Choice |
|---|---|
| Codebase | Fresh repo at `~/Projects/Seamless`; port proven MailDeck modules (IMAP sync, S3 `.eml` store, threading, compose, virtual list, JMAP subset) |
| External clients | Built-in IMAP4rev1 + SMTP-submission facade; Seamless is the system of record |
| Database | Postgres 17 + pgvector (embeddings) + FTS (tsvector) |
| AI | Pluggable OpenAI-compatible per task; default classifier `gemini-2.5-flash-lite`; embeddings local (bge-small, in-process ONNX) |
| Users | Multi-user from day one (roles: admin, member) |
| Safe delete | Per-account toggle, default OFF; verify blob + checksum, grace window, move to origin Trash (modes: trash / expunge / archive) |
| Gmail/MS auth | OAuth2 first-class; setup wizard walks through app registration; app-password + plain IMAP fallback (Apple/iCloud/traditional) |
| Contacts | Auto-built addressbook + management UI + vCard import/export + CardDAV server |

Config source of truth: `Gmail-Rules-Sheet.xlsx` (tabs: README, Rules ×137, Forwarding Accounts,
Labels ×38, Settings, Preferences, Forwarding Out, AI Fallback). Importer treats tabs as schema.

---

## 1. Architecture

```
┌────────────────────────────── Seamless server (Node 22 + TS, Fastify) ─────────────────────────────┐
│  HTTP :4900   REST/JMAP API · WS push · PWA static · CardDAV (/dav) · setup wizard · help pages     │
│  IMAP :1993   facade — standard clients read Seamless's own store (app-password auth)               │
│  SMTP :1587   submission facade — relays out via the owning account's real SMTP / Gmail API / Graph │
│  Workers (pg-boss queues, same process or `--workers`):                                             │
│    sync        per-account fetch (IMAP IDLE / Gmail API / MS Graph delta) → parse → S3 + Postgres   │
│    classify    the cascade: rules → embeddings → LLM → review                                       │
│    retention   nightly disposition sweep → recoverable Trash → purge                                │
│    safedelete  origin-side deletion after verify + grace                                            │
│    embed       vector upserts (corrections, onboarding backfill)                                    │
│    scheduler   send-later delivery (ported from MailDeck)                                           │
│    logclean    prune processing/AI logs per user settings                                            │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
     Postgres :5460 (pgvector, FTS, pg-boss)          MinIO :9100/:9101 (raw .eml + attachments)
```

- **Repo layout:** `server/` `web/` `shared/` `stack/` (docker compose: postgres+pgvector, minio) `docs/` (user manual, this file).
- **Frontend:** Vite + React + zustand + @tanstack/react-virtual + TipTap, IndexedDB cache, optimistic mutations, WS push, installable PWA — MailDeck's stack, ported.
- **Flow:** origin server → sync worker → raw RFC822 in S3 (sha256 verified) + metadata/FTS in Postgres → `classify` job → labels + disposition → UI/WS + IMAP facade see the same store.
- **Classify once, at ingest, async** — never in the request path. Re-classification = re-enqueue.
- **Ports:** API/web 4900 (dev web 5900), Postgres 5460, MinIO 9100/9101, IMAP 1993 (dev plaintext 1143), SMTP 1587. No clashes with MailDeck (4870/5870), ServiceMax (5436), CleanHire (5457).
- **Candidate libs:** imapflow + mailparser (client sync), nodemailer (SMTP out), zone-eu `imap-core`/wildduck server components for the IMAP facade (else minimal IMAP4rev1 subset by hand: LOGIN, LIST, SELECT, UID FETCH/SEARCH/STORE/COPY, APPEND, IDLE, EXPUNGE), SheetJS (xlsx), `@huggingface/transformers` ONNX bge-small for embeddings, googleapis + @azure/msal-node for OAuth.

### Connectivity per provider

| Provider | Sync | Send | Auth |
|---|---|---|---|
| Gmail | Gmail API (history/delta; labels readable) with IMAP XOAUTH2 fallback | Gmail API send / SMTP XOAUTH2 | OAuth2 (user's GCP app) |
| Microsoft/Outlook | MS Graph delta with IMAP XOAUTH2 fallback | Graph sendMail / SMTP XOAUTH2 | OAuth2 (user's Azure app) |
| Apple/iCloud | IMAP | SMTP | app-specific password |
| Traditional | IMAP (IDLE) | SMTP | password |

OAuth client credentials are instance-level (`oauth_apps`), entered once in the wizard; per-account
tokens encrypted AES-256-GCM with `SEAMLESS_SECRET` (MailDeck pattern).

---

## 2. Schema (Postgres)

```sql
-- identity ----------------------------------------------------------------
users(id, email UNIQUE, name, password_hash, role TEXT CHECK (role IN ('admin','member')),
      created_at);
sessions(id, user_id, token_hash, expires_at, last_seen_at, created_at);
app_passwords(id, user_id, label,                -- "iPhone Mail", "Thunderbird desk"
      secret_hash, scopes TEXT[],                -- {imap,smtp,carddav}
      created_at, last_used_at);                 -- facade + CardDAV logins

-- origin accounts ----------------------------------------------------------
oauth_apps(id, provider TEXT CHECK (provider IN ('google','microsoft')),
      client_id, client_secret_enc, created_at);
accounts(id, user_id, name, email, color, kind TEXT,          -- gmail|microsoft|apple|imap
      auth_enc JSONB,                                         -- tokens or password, encrypted
      imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_tls,
      aliases TEXT[],
      safe_delete_enabled BOOL DEFAULT false,
      safe_delete_mode TEXT DEFAULT 'trash',                  -- trash|expunge|archive
      safe_delete_grace_days INT DEFAULT 30,
      state TEXT, last_sync_at, created_at);
identities(id, user_id, account_id, email, name, signature_html, is_default BOOL);

-- labels -------------------------------------------------------------------
labels(id, user_id, name, parent_id, color, sort,
      system_role TEXT NULL,             -- inbox|sent|drafts|scheduled|archive|junk|trash|review
      keep_default BOOL DEFAULT false,   -- label carries its retention
      retention TEXT DEFAULT 'inherit',  -- keep|delete|inherit
      retention_days INT NULL,           -- e.g. Sale=10, Service Notifications=60
      protected BOOL DEFAULT false,      -- never auto-deleted, never auto-forwarded
      auto_mark_read BOOL DEFAULT false);

-- mail ---------------------------------------------------------------------
threads(id, user_id, subject_norm, last_date, message_count);
emails(id, user_id, account_id, thread_id,
      message_id, in_reply_to, references_ids TEXT[],
      from_addr, from_name, from_domain, to_addrs JSONB, cc_addrs JSONB, bcc_addrs JSONB,
      delivered_to,                        -- base local-part drives via/ source rules
      subject, snippet, date,
      headers JSONB,                       -- list_id, list_unsubscribe, precedence,
                                           -- auto_submitted, auth_results, return_path
      has_attachments BOOL, size INT,
      blob_key, blob_sha256,               -- raw .eml in S3, checksum = safe-delete gate
      seen BOOL, starred BOOL, answered BOOL, draft BOOL,
      opened_at TIMESTAMPTZ,               -- first read in Seamless
      user_touched BOOL DEFAULT false,     -- manual unread/star after auto-read → retention skips
      state TEXT,                          -- received|pending|classified|needs_review|trashed|purged
      review_reason TEXT,
      disposition TEXT,                    -- keep|delete
      delete_at TIMESTAMPTZ, keep_reason TEXT,
      origin_uid, origin_mailbox,
      origin_state TEXT DEFAULT 'present', -- present|trashed|archived|expunged
      origin_deleted_at,
      fts tsvector, created_at);
email_labels(email_id, label_id,
      applied_by TEXT,                     -- rule|embedding|ai|user|import
      rule_id NULL, confidence REAL, created_at);
attachments(id, email_id, filename, mime, size, blob_key, extracted_text TEXT); -- PDF text → LLM

-- classification config (spreadsheet tabs → tables) --------------------------
rules(id, user_id, enabled BOOL, ord INT,
      match_field TEXT,     -- from|from_domain|to|delivered_to|subject_contains|body|header|list_id
      match_value TEXT, exclude_contains TEXT,
      action TEXT,          -- 'label' | 'ai'   (ai = fall through to LLM with note as guidance)
      label_id NULL, stop BOOL DEFAULT true, note TEXT,
      source TEXT,          -- manual|imported|suggested|promoted
      hit_count INT DEFAULT 0, created_at);
preferences(id, user_id, enabled BOOL, guidance TEXT,        -- plain English, injected into prompt
      version INT, active BOOL, created_at);
user_settings(user_id, key, value JSONB);  -- dry_run, ai_conf_threshold(0.7), embed_threshold(0.88),
                                           -- batch_size, ai_budget_usd_month, log_retention, trash_days(30)
routes(id, user_id, enabled BOOL, label_id, forward_to, only_after DATE, note); -- Forwarding Out (optional phase)

-- AI + learning ---------------------------------------------------------------
ai_decisions(id, email_id, tier TEXT,      -- rule|embedding|llm
      model, output JSONB,                 -- the orthogonal-fields JSON verbatim
      confidence REAL, reason TEXT,
      preference_version INT, prompt_version INT,
      cost_usd NUMERIC, latency_ms INT, created_at);
email_vectors(email_id PRIMARY KEY, user_id, label_id, embedding vector(384), created_at);
corrections(id, user_id, email_id, from_label_id, to_label_id,
      kind TEXT,                           -- relabel|restore_from_trash|delete|keep|unread_protect
      applied_to_index BOOL DEFAULT false, created_at);
rule_suggestions(id, user_id, pattern JSONB, suggested_label_id,
      evidence_count INT, status TEXT DEFAULT 'pending', created_at);
processor_notes(id, user_id,
      scope TEXT,                          -- email|sender|domain|label
      scope_value TEXT, email_id NULL,
      note TEXT,                           -- user's plain-English instruction
      directives JSONB,                    -- LLM-parsed: {label, auto_read, delete_if_unread_days,
                                           --  respect_manual_unread, retention}
      active BOOL DEFAULT true, created_at, updated_at);

-- contacts ---------------------------------------------------------------------
contacts(id, user_id, display_name, first_name, last_name, org, photo_blob_key,
      vcard TEXT, etag,                    -- CardDAV representation
      sent_count INT, received_count INT, last_interaction_at,
      auto_created BOOL, hidden BOOL, created_at, updated_at);
contact_emails(contact_id, email, is_primary BOOL);

-- ops ---------------------------------------------------------------------------
processing_logs(id, user_id, email_id NULL,
      kind TEXT,        -- sync|classify|ai|retention|safe_delete|import|facade|carddav|send
      level TEXT, message, meta JSONB, created_at);   -- pruned by logclean per settings
gmail_imports(id, user_id, account_id, status, stats JSONB, started_at, finished_at);
scheduled_sends(...);                       -- ported from MailDeck
```

Indexes: `emails(user_id, thread_id)`, `(user_id, state, delete_at)`, `(user_id, from_domain)`,
`(message_id)`, GIN on `fts`, HNSW on `email_vectors.embedding`.

---

## 3. Classification cascade

Worker runs tiers in order, stops at first confident answer. Everything logged to
`ai_decisions` + `processing_logs`.

**3a. Deterministic rules** — free. User's rule table in `ord` order; `stop` ends matching.
Raw-header rules are first-class (`List-Id` / `List-Unsubscribe` → marketing;
`Precedence: bulk`, `Auto-Submitted` → machine notification; `Authentication-Results` for spoof
checks; `Delivered-To` base local-part → `via/` source labels, replacing the Forwarding Accounts
tab). Rules with `action='ai'` fall through to 3c carrying their note as guidance
(AliExpress, Google Play, `.edu.au`, Substack, Xiaomi, eDreams, ollama.com, promptwireai.com…).

**3b. Embedding similarity** — cheap, learns automatically. Embed subject + snippet + key headers
(bge-small, 384-dim, local). kNN against `email_vectors`; if top similarity > 0.88 and top-k
agree → apply that label at that confidence. Seeded by Gmail onboarding, updated by every
correction.

**3c. Cheap LLM** — ambiguous slice only. Prompt contains: truncated body, decisive headers,
**extracted attachment text** (itemised invoice = decisive), active `preferences` (plain English,
versioned), matching `processor_notes`, 2–3 nearest labelled neighbours as few-shot, label tree
with meanings. Structured JSON output, **orthogonal fields — never one label**:

```json
{
  "category": "receipt|statement|bill|notification|marketing|travel|school|personal|...",
  "label": "Receipts",
  "is_real_document": true,
  "requires_action": false,
  "worth_keeping": true,
  "retention": "keep_1y",
  "warranty_months": 24,
  "confidence": 0.93,
  "reason": "<= 12 words"
}
```

This resolves the hard pairs: ToS notice → `requires_action:false → delete`; "account will be
suspended" → `requires_action:true → keep`; "payment processed" bare → `is_real_document:false →
delete`; same subject with itemised PDF → `is_real_document:true → Receipts, keep`; receipt
mentioning 2-year warranty → `keep_2y`.

Decisions cached by `(from_addr, normalised_subject, content_hash)` — forwarded/near-identical
mail classifies once. Per-user monthly AI budget; over budget → rules+embeddings only.

**3d. Human review** — below `ai_conf_threshold` (0.7): `state='needs_review'`, surfaces in a
Review lane for one-tap decisions. Never guess-and-delete.

---

## 4. Retention engine

Every classified email gets `disposition` + `delete_at`. **Default is delete** (N days from label
`retention_days`, sheet-seeded: To Delete 60, Sale 10, Service Notifications 60). "Keep" only via:
keep-set category, `is_real_document`, `requires_action`, label `keep_default`, protected label,
processor-note directive, or user action.

- Dynamic lengths from the classifier: `warranty_months:24` → `delete_at = received + 24mo`;
  statements → 7y; tickets → event + buffer.
- Nightly cron: `delete` + `delete_at < now()` + no protected label + not `user_touched` →
  recoverable Trash (30-day grace) → purge (DB row tombstoned, S3 blob deleted).
- **Protected class** (sheet: Keep long term, Banking/Statements, Our Invoices, company labels,
  Staff Documents, Visa) — sweep can never touch, never auto-forward.
- Read-state conditions: processor notes like "delete if I don't read it in 7 days" compile to
  `delete_if_unread_days`; retention checks `opened_at`. `user_touched` (manually marked unread
  after auto-read) always wins — hands off.
- Global `dry_run` setting (sheet default TRUE): pipeline logs what it *would* do; Settings shows
  the preview until user flips it live.

Rule: safe to keep too long, never safe to delete too early. Trash is always the first stop.

---

## 5. Learning loop

Every correction (`corrections`) fires:
1. **Embedding index update** — next similar mail is right, free.
2. **Pattern detection → rule suggestions** — "5 emails from xiaomi.com moved to Sale — make it a
   rule?" One tap promotes to a deterministic rule (`source='promoted'`), shrinking LLM spend.
3. **Training-set accumulation** — future: distil a local classifier.

**Processor notes** (per-email note icon, also settable per sender/domain/label): user writes plain
English ("newsletter I signed up for — label Newsletter, mark read, delete if unread 7 days, but if
I mark unread manually leave it alone"). A one-off LLM call parses it into `directives` JSONB
(shown to the user for confirmation); the raw note is also injected verbatim into future LLM
classifications matching its scope. Notes are the highest-priority guidance tier.

**Preferences** are versioned with rollback; each `ai_decision` records the preference version that
produced it. Rules/preferences editable with **dry-run diff** against last N emails before going live.

---

## 6. Spreadsheet importer

`server/src/import/xlsx.ts` (SheetJS), idempotent, dry-run preview first. Wizard step + Settings →
"Import config".

| Tab | Destination | Notes |
|---|---|---|
| Labels | `labels` | tree from `/` paths; tier column → keep/protected defaults |
| Rules | `rules` | `Apply Label: AI` → `action='ai'`; Exclude If Contains → `exclude_contains`; Category=promotions → header/heuristic rule |
| Preferences | `preferences` | verbatim, enabled flag |
| Settings | `labels.retention_days` + `user_settings` | "Retention: X" rows → labels; thresholds/dry-run/batch → settings; "Add To Delete to labels" hack → those labels get `retention_days` directly (Sale 10, School 60, Service Notifications 60) — the additive To-Delete trick dies |
| Forwarding Accounts | `via/` labels + `delivered_to` rules | replaces script's pass 1; plus-tags collapse to base local-part |
| Forwarding Out | `routes` | stored; forwarding engine is optional/late phase |
| AI Fallback | prompt fixtures | the 8 cases become documented prompt guidance + test fixtures |

Exporter back to `.xlsx` (same tabs) for bulk editing — round-trip.

---

## 7. Gmail onboarding — "learn from my Gmail"

One-click wizard step. OAuth `gmail.readonly`.

1. **Fetch** labels + per-label message metadata (sender, domain, subject, headers, snippet, full label set).
2. **Analyse** sender→label consistency: ≥90% one label → deterministic rule proposal; mixed
   senders (PayPal, Google Play) → `action='ai'` + generated preference describing the split;
   subject-token and header patterns → keyword rule candidates.
3. **Propose & preview** — rules table with per-rule dry-run counts (catches/agrees/disagrees);
   accept / edit / reject each.
4. **Seed memory** — embed the entire labelled history into `email_vectors`. The similarity tier
   thinks like the user from minute one.
5. **Map labels** — reconcile Gmail label tree to Seamless labels with inferred retention;
   import accepted rules + preferences.

Progress UI with live counters; `gmail_imports` tracks runs; resumable.

---

## 8. Safe delete (origin-side)

Settings → per account. Default OFF. An email is origin-deletable only when **all** hold:
blob in S3 with matching sha256, DB row `classified`, older than `safe_delete_grace_days`,
account toggle on. Then per `safe_delete_mode`: move to origin Trash (default; origin's own
30-day trash = second net) / expunge / archive-at-origin ("Imported" folder). Every action →
`processing_logs` + `origin_state`/`origin_deleted_at`. Wizard shows a dry-run count
("would remove 3,078 messages from Gmail, oldest first") before enabling. Gmail via API
(`users.messages.trash`), IMAP via COPY+STORE \Deleted+EXPUNGE.

---

## 9. Facades — standard clients connect to Seamless

- **IMAP :1993** (TLS): LOGIN (app-passwords), LIST/LSUB (labels as folders, `/` hierarchy),
  SELECT, UID FETCH (BODY from S3), UID SEARCH (Postgres FTS), STORE (flags → same store the web
  UI uses), COPY/MOVE (label ops), APPEND (client saves drafts/sent), IDLE (WS-bridged push),
  EXPUNGE. CONDSTORE/QRESYNC if the chosen lib gives it cheaply.
- **SMTP :1587** submission: AUTH with app-passwords; message relayed via the owning account's
  real outbound (Gmail API / Graph / SMTP) so SPF/DKIM stay with the provider; copy lands in Sent.
- **CardDAV `/dav/addressbooks/{user}/default/`**: PROPFIND, REPORT (addressbook-query,
  sync-collection), GET/PUT/DELETE vCards, ETags from `contacts.etag`. Phones sync contacts
  natively. Same app-password auth.
- Settings → Devices: create/revoke app passwords, per-scope, with last-used display and
  copy-paste server settings card (host/ports for IMAP/SMTP/CardDAV).

---

## 10. Addressbook

Auto-built from send/reply history: every recipient of a sent mail and every sender the user
replied to → `contacts` (`auto_created`), counters + `last_interaction_at` maintained by sync.
Never auto-create from unsolicited senders. UI: browse/search/edit/merge/hide, photo, vCard
import/export. Compose autocomplete ranks by interaction recency/frequency. CardDAV exposes it (§9).

---

## 11. UI

Base = MailDeck's proven shell (sidebar, unified views, per-account color bars, split/table
layouts, virtualized list). Screenshot mapping:

- **Main list** (`Main Default UI.png`): label chips in-row, checkbox/star, unread counts,
  account colors, chips for AutoSorted/via/-style provenance (`2026-07-11_103730.png`).
- **Conversation** (`email conversation flow.png`): Gmail-style thread — collapsed older messages,
  expand-on-click, sender avatars, star per message, Reply/Forward at bottom.
- **Inline reply** (`reply inline UI.png`): reply editor grows inline at thread bottom.
- **Compose** (`New Email in corner UI.png`, `New Email UI full popup.png`): docked corner window,
  minimize/maximize to full popup, multi-window dock (ported).
- **Create label** (`create label popup.png`): Synology-style modal — nest-under dropdown, name,
  color palette.
- **Row indicators** (`showing email viewed & notes icons.png`): open-tracking eye + count, note icon.
- **New in Seamless:** per-email **processor-note icon** (pencil-bubble; filled when a note exists;
  opens note editor with parsed-directive confirmation), **"why this label?"** tooltip
  (reason + confidence + tier from `ai_decisions`), **Review lane** (one-tap keep/label/delete),
  **countdown badge** on To-Delete mail ("deleted in 6d", click to keep), **Logs screen**
  (filterable AI/processing log, auto-clear settings), **Trash** with restore.
- **Settings:** Accounts (+ safe delete), AI providers & budget, Rules (table editor + dry-run
  diff), Preferences, Labels & retention, Devices/app-passwords, Contacts, Logs, Import/Export.
- **Animations** (feedback, not decoration; CSS transitions + View Transitions API, ~150–250ms):
  row slide-out on archive/delete/label with undo toast, chip pop-in on label apply, compose dock
  minimize/restore, thread expand/collapse, skeleton shimmer, sync spinner in sidebar, subtle
  countdown-badge pulse on review items. Respect `prefers-reduced-motion`.
- **Setup wizard** (first run): admin user → (optional) OAuth app credentials with guided
  screenshots for GCP/Azure registration → add accounts → import spreadsheet (or skip → defaults)
  → learn-from-Gmail (optional) → AI provider + budget → safe-delete opt-in (per account, with
  dry-run counts) → done. Every step skippable, resumable.
- **User manual:** `docs/manual/*.md` rendered in-app at `/help` (searchable): getting started,
  connecting each provider, rules & preferences, processor notes, retention & trash, safe delete,
  connecting phone/desktop clients (per-client walkthroughs), CardDAV, troubleshooting.

---

## 12. Build phases (each independently verifiable)

1. **Foundation** — repo, `stack/` compose (pg+pgvector, MinIO), migrations (§2), multi-user auth
   + sessions, plain-IMAP account connect, sync worker → S3+Postgres (ported), threading, unified
   inbox UI (list, split/table, conversation view), compose/send/drafts/send-later, search (FTS),
   labels CRUD, minimal wizard. *Done when: two IMAP accounts sync, mail reads/sends/threads, all
   MailDeck core behaviours pass.*
2. **Rules + retention (no AI)** — xlsx importer + exporter, rules engine on ingest + run-over-existing,
   label retention, dispositions, nightly cron, Trash + restore, countdown badges, dry-run mode,
   logs screen + logclean. *Done when: sheet imports clean; seeded mail auto-labels; retention
   dry-run report matches expectations; nothing protected ever swept (test-enforced).*
3. **AI tiers + learning** — pluggable providers, LLM classify with orthogonal JSON, preferences
   (versioned, dry-run diff), attachment text extraction, embeddings + pgvector kNN, review lane,
   corrections → index + rule suggestions, processor notes (parse → directives → retention/read
   behaviours), "why this label?", decision cache + budget. *Done when: hard-pair fixtures (ToS vs
   suspension, notice vs real invoice, warranty) classify correctly; a correction visibly changes
   the next similar mail.*
4. **OAuth + Gmail learn + safe delete** — Google/Microsoft OAuth flows + wizard guidance, Gmail
   API/Graph sync + send, onboarding analyser (§7), safe-delete worker (§8) with dry-run counts.
   *Done when: real Gmail connects, history seeds vectors, proposed rules review-able; safe delete
   trashes at origin only after verified import.*
5. **Facades + contacts** — IMAP server, SMTP submission, app-passwords/Devices UI, addressbook
   auto-build + UI + vCard, CardDAV. *Done when: iOS Mail/Thunderbird read, move, flag and send
   through Seamless; phone syncs contacts.*
6. **Polish** — full setup wizard, PWA (offline shell, push), animations pass, manuals, dark mode,
   accessibility, load test on the ~3k-message corpus, optional forwarding-out engine (`routes`).

---

## 13. Non-goals (v1)

Hosting a real MTA (no port-25 inbound; deliverability stays upstream) · CalDAV ·
fine-tuned local classifier (phase-3 data collection enables it later) · iOS/Android native apps
(PWA + IMAP facade cover it) · multi-tenant billing.
