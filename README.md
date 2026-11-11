# Seamless

Self-hosted, AI-native webmail. Multi-user, unified inbox across many IMAP accounts, portable `.eml` storage in S3-compatible object storage, Postgres + pgvector core, installable PWA. Successor to MailDeck — see `DESIGN.md` for the full architecture and roadmap (classification cascade, retention engine, Gmail onboarding, IMAP/SMTP/CardDAV facades).

## Features

- **Mailbox categories + switcher** — group mailboxes into Work / Personal / Disposable (or your own) and switch Unified ⇄ category ⇄ single mailbox from the top-right; every list, count and search follows the scope.
- **VIP senders** — mark an address or domain as VIP: ★ badge, never auto-archived/deleted by rules, AI or retention, always notifies (even in quiet hours), `is:vip` search.
- **Notifications centre** — bell with the latest six, a filterable paginated page, per-type in-app / push settings, mailbox mutes, quiet hours. Built on an internal event bus.
- **Undo send** — Send holds the message for a few seconds (you choose: off, 5, 10, 20 or 30) with a countdown and Undo; it is sent exactly once even if the server restarts.
- **Snooze** — hide a conversation until later today / tomorrow / next week / a date you pick (Perth time); it returns unread at the top, or sooner if someone replies. A Snoozed view lists what's waiting.
- **Follow-up reminders** — "remind me if no reply in 3 days"; a reply from one of the people you wrote to cancels it, otherwise you're notified. A Waiting-for-reply view lists them.
- **Phishing and lookalike warnings** — flags failed sender checks, display-name tricks, lookalike domains (`0fficecleaners.com.au`, Cyrillic letters), bank-detail scams, risky attachments and lying links; high risk switches links off. Trusted-senders list, `risk:high` search.
- **Sending, receiving and storage choices** — send through SMTP or an API provider (SendGrid, Brevo, SES, Mailgun, Postmark) with bounce tracking and a DNS check; receive over IMAP, POP3 or a signed push from your own domain; throwaway **disposable addresses**; storage targets with verified migration, mirrored email backups and a portable encrypted export/import. ARC-aware sender checks avoid false alarms on forwarded mail.
- **Health and alerts** — one page for mailboxes, sending, background tasks, storage, backups and the server, with alerts when something turns red and a public `/healthz` for uptime monitors.
- **Open tracking that tells people from proxies** — eye toggle on the compose toolbar (on by default), per-recipient tracking, open report with client, time and proxy/scanner flagging.
- **Templates** — placeholders (`{{recipient.first_name}}`, `{{date+7d}}`, `{{?Question}}`), picker in compose and `;shortcut` expansion.
- **Gmail-style actions** — hover actions, right-click menu, bulk bar with "select all N matching", undo, and the full keyboard set (`?`).
- **Themes** — Seamless (original), Rolltop (warm, serif) and Simply Seamless (content-first); light/dark/system, accent colour, density.
- **Security** — TOTP two-factor with recovery codes, session list/revoke with expiry, rate limits, CSP and security headers.
- **Multi-user** — admin + member logins, per-user accounts, labels, filters, AI config, mail. First run creates the admin.
- **AI classification cascade** — deterministic rules (raw headers first-class) → embedding similarity against your own labelled mail → LLM structured verdicts (real document? requires action? worth keeping? how long?) → human review lane. Every correction teaches it; repeated corrections become rule suggestions.
- **Retention engine** — labels carry retention (protected / keep / delete-after-N-days); hourly sweep to recoverable Trash with dry-run default, countdown badges, full processing logs with auto-clear.
- **Spreadsheet config** — importer/round-trip for the rules sheet (Labels, Rules, Settings, Preferences, Forwarding tabs = the schema).
- **Gmail / Microsoft OAuth** — XOAUTH2 sync + send, learn-from-Gmail onboarding (labelled history → rules + AI routing + embedding seed).
- **Safe delete** — per account: checksum-verified archived mail is removed at the origin after a grace window (origin Trash first); Seamless keeps the record forever.
- **Device facades** — built-in IMAP + SMTP submission servers (app passwords) so Thunderbird/iOS Mail/K-9 connect to Seamless directly; CardDAV serves the auto-built addressbook.
- **Processor notes** — per-sender/domain instructions ("newsletter I signed up for — delete after 7 days unless I read it") enforced deterministically and injected into AI decisions.
- **Unified inbox** — every account's Inbox merged into one view; Sent → one Sent, Drafts → one Drafts. Per-account color bars.
- **Portable storage** — every message archived as raw RFC822 `.eml` in S3 (MinIO / R2 / B2).
- **Encrypted backup + disaster restore** — scheduled database backups (twice-daily → weekly) to object storage, AES-256-GCM with `SEAMLESS_SECRET`, verified on write and pruned to a keep-count. Backups are **self-describing**: a rebuilt server finds its own mail bucket from the backup and proves it by checksum, so "restored" never means "rows are back but every body 404s". Restore from the first-run screen or the CLI. Backups can live in a **separate bucket or provider** from the mail they protect.
- **JMAP subset API** the client talks to (`Mailbox/get`, `Email/query|get|set`, `Thread/get`, `Identity/get`, `EmailSubmission/set`, `#ref` back-references).
- **Reply-from matching** — auto-replies from the address a message was delivered to (Delivered-To → To → Cc, primary + aliases).
- **Fast frontend** — virtualized list, server-side pagination, IndexedDB cache, optimistic mutations, WebSocket push.
- **Two layouts** — split view or Gmail-style table view.
- **Search** — Postgres full-text (tsvector) with a query language: `from: to: label: in: is:unread is:starred has:attachment before: after: "phrases"`.
- **Colored labels** (per user, across all accounts) + **filter engine** (conditions + actions, applied on ingest or run over existing mail).
- **AI, pluggable** — any OpenAI-compatible endpoint(s), mapped per task: categorize, summarize, draft. Per user.
- **Rich compose** — TipTap editor, attachments, multi-window dock, drafts, **send later**, **open tracking**.
- **PWA** — installable, offline shell, Web Push.
- Credentials AES-256-GCM encrypted at rest with `SEAMLESS_SECRET`.

## Architecture

```
web/     Vite + React + zustand SPA (virtual list, TipTap, IndexedDB, service worker)
server/  Node + Fastify: IMAP sync (imapflow + IDLE), SMTP send (nodemailer),
         Postgres (pg + tsvector FTS, pgvector-ready), S3 blob store, JMAP endpoint, WS push, AI
shared/  TypeScript API contract shared by both
stack/   docker compose: Postgres 17 (pgvector), MinIO, GreenMail (dev IMAP/SMTP)
docs/    user manual (grows with later phases)
```

Messages sync from IMAP → parsed → raw stored in S3, metadata + FTS in Postgres → threaded by Message-ID/References per user. Client mutations write optimistically and queue IMAP ops that flush on the next sync tick.

## Quick start (local demo)

Requires Node 20+ and Docker.

```bash
npm install
cp .env.example .env         # then set SEAMLESS_SECRET to any long random string
docker compose -f stack/docker-compose.dev.yml -p seamless up -d   # Postgres + MinIO + GreenMail
npm run seed                 # seed demo mail into GreenMail
npm run ai-stub              # optional: local OpenAI-compatible stub on :4909

npm run dev:server           # API + sync on :4900
npm run dev:web              # Vite dev server on :5900 (proxies to :4900)
```

Open http://localhost:5900, create the admin account, then add accounts under Settings → Accounts:

| Field | Value |
|-------|-------|
| IMAP host/port | `localhost` / `3144`, TLS off |
| SMTP host/port | `localhost` / `3026`, TLS off |
| Users | `alice`/`alicepw`, `support`/`supportpw`, `bob`/`bobpw` (all `@demo.test`) |

For AI in the demo, add a provider with base URL `http://localhost:4909/v1` and enable the tasks.

## Production

```bash
npm run build                # builds web/dist + typechecks server
DATA_DIR=/var/lib/seamless NODE_ENV=production npm start --workspace server
```

Point `DATABASE_URL` at your Postgres (pgvector image), `S3_*` at your MinIO/R2/B2 bucket, and set `PUBLIC_URL`. Put a TLS-terminating reverse proxy in front.

Or run the image, which serves the API and the built web app:

```bash
docker run -d --name seamless --restart unless-stopped -p 4900:4900 \
  --env-file .env -v /var/lib/seamless:/app/data \
  ghcr.io/uri-travoski/seamless:latest
```

## Backup & restore

Turn it on in **Settings → Backup**: pick a schedule (twice-daily → weekly), an hour, and how many runs to keep. Every run writes an encrypted dump to object storage, reads it back to verify it, prunes old runs, and alerts you (push + email + banner + log) if anything fails.

The `.eml` blobs are never copied — a backup is the *index*, not the archive, so a few thousand messages costs a couple of hundred KB.

To recover on a rebuilt box, give it the same `SEAMLESS_SECRET` and point `S3_BACKUP_*` at the bucket. Then either restore from the first-run screen, or:

```bash
npm run restore -- --list            # what is in the bucket
npm run restore -- --latest          # restore the newest
npm run restore -- --verify-only     # drill: prove it reads back, change nothing
```

The backup records **which bucket holds the mail** (and, encrypted, the credentials for it), so a restored server reconnects to the blobs on its own and checksum-verifies one before declaring success. Full details, including troubleshooting: `docs/manual/11-backup-restore.md`.

> **Keep `SEAMLESS_SECRET` somewhere other than the server.** It decrypts the backups and every credential inside them. Without it they are unreadable.

## Tests

```bash
npm test    # vitest against Postgres (creates/rebuilds the seamless_test database; stack must be up)
```

## Environment

See `.env.example`. Key vars: `SEAMLESS_SECRET` (required), `PORT` (4900), `DATABASE_URL`, `DATA_DIR`, `PUBLIC_URL`, `S3_*` (mail blobs).

Backups reuse the `S3_*` bucket unless you separate them — recommended, so one deleted bucket or leaked key cannot take both: `S3_BACKUP_BUCKET`, plus optional `S3_BACKUP_ENDPOINT` / `_REGION` / `_ACCESS_KEY` / `_SECRET_KEY` / `_FORCE_PATH_STYLE` (each falls back to its `S3_*` twin), and `BACKUP_PREFIX` (default `seamless/`).
