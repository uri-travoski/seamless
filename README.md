# Seamless

Self-hosted, AI-native webmail. Multi-user, unified inbox across many IMAP accounts, portable `.eml` storage in S3-compatible object storage, Postgres + pgvector core, installable PWA. Successor to MailDeck — see `DESIGN.md` for the full architecture and roadmap (classification cascade, retention engine, Gmail onboarding, IMAP/SMTP/CardDAV facades).

## Features (phase 1)

- **Multi-user** — admin + member logins, per-user accounts, labels, filters, AI config, mail. First run creates the admin.
- **Unified inbox** — every account's Inbox merged into one view; Sent → one Sent, Drafts → one Drafts. Per-account color bars.
- **Portable storage** — every message archived as raw RFC822 `.eml` in S3 (MinIO / R2 / B2).
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

## Tests

```bash
npm test    # vitest against Postgres (creates/rebuilds the seamless_test database; stack must be up)
```

## Environment

See `.env.example`. Key vars: `SEAMLESS_SECRET` (required), `PORT` (4900), `DATABASE_URL`, `DATA_DIR`, `PUBLIC_URL`, `S3_*`.
