# Seamless inbound Worker

Receives mail from Cloudflare Email Routing and pushes it, HMAC-signed, to your Seamless server
(`POST /api/ingest/<token>`). Retries 3× (1 s, 4 s, 16 s); if Seamless stays unreachable it forwards the
message to `FALLBACK_ADDRESS` so nothing is lost.

1. In Seamless: Settings → Mailboxes → Add → "Own domain (Cloudflare Email Routing)". Note the token and secret.
2. `cp wrangler.toml.example wrangler.toml`, set `SEAMLESS_URL`, `ROUTES`, `FALLBACK_ADDRESS`.
3. `npx wrangler secret put SECRETS` and paste `{"<token>":"<secret>"}`.
4. `npx wrangler deploy`.
5. Cloudflare dashboard → Email → Email Routing → Routes: catch-all action "Send to a Worker" → `seamless-inbound`.

`src/index.ts` exports `routeFor`, `sign` and `deliver` for tests; the Worker itself uses no dependencies.

## Disposed addresses
Before accepting a message the Worker fetches `GET /api/ingest/<token>/disposed` (signed with the same secret) and
caches the list for 5 minutes. A message to a disposed address is refused at SMTP time with "Address disabled".
If Seamless is unreachable the last known list is used; Seamless also drops disposed mail on arrival.
