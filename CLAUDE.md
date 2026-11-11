# Seamless — working notes for Claude

Self-hosted multi-user webmail. Planning pack lives next to the repo in `../Planning/` (tiers T0–T6;
build one tier at a time, each has a "done when" gate).

## Stack
- `server/` Node 20 + Fastify + Postgres 17 (pgvector) + S3-compatible blobs (MinIO in dev). TypeScript run by `tsx`.
- `web/` Vite + React 18 + zustand, TipTap compose, Phosphor icons.
- `shared/` API types (`types.ts`) and pure helpers used by both (`templates.ts`).
- `stack/docker-compose.dev.yml` — Postgres :5460, MinIO :9100, GreenMail (IMAP :3144 / SMTP :3026).

## Run / test / build
```bash
docker-compose -f stack/docker-compose.dev.yml -p seamless up -d
npm install
npm test                       # vitest against seamless_test (stack must be up)
npm run build                  # web/dist + server typecheck
cd server && npm start         # serves API + built web on $PORT (static asset list is read at start: restart after a web build)
```

## Ground rules (from Planning/00-README.md)
- Never break existing tests; every feature adds its own (`server/test/*.test.ts`), bug fixes add a test that failed first.
- Migrations are append-only: add `{ id: N, sql }` to `MIGRATIONS` in `server/src/db.ts`; never edit an applied one.
- Every table is in the backup automatically (the engine dumps all tables); secrets in new tables are encrypted with `SEAMLESS_SECRET` (`crypto.ts` encrypt/decrypt).
- Per-user scoping on every query, plus a test that user B can't read user A's rows.
- After a change other tabs should see: `bumpState()` + WebSocket `broadcast({type:'stateChange'}, userId)`.
- Notifications go through the event bus: `emitEvent(userId, type, subject, payload, client?)` (`server/src/events/`).
- Update `docs/manual/*.md` for anything a user sees. Bump the version after each tier (T0 0.26.0, T1 0.27.0, …).

## Conventions (AD-7)
- Routes: `server/src/routes/<domain>.ts`, each exports `register(app)`; registered in `routes/index.ts`. Keep them thin.
- Logic: `server/src/<domain>/` (e.g. `mail/categories.ts`, `mail/tracking.ts`, `auth/sessions.ts`, `auth/mfa.ts`).
- Scope (T1): list/count/search endpoints take `scope = unified | category:<id> | account:<id>` → `scopeAccountIds()`.
- UI colours come from theme tokens only (`web/src/theme/registry.ts` → CSS custom properties). No raw hex in components.
- Client routing: `web/src/router.ts` (`/mail/<scope>/<folder>`, `/notifications`, `/settings/<tab>`, `/mail/msg/<id>/opens`).
- Times stored as epoch ms (UTC); shown in the user's zone (default `Australia/Perth`).
