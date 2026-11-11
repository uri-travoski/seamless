# DMS endpoint Seamless sends to

Seamless (connector **DMS**) calls this on your document management system. **The DMS must accept this shape** — it is
an assumption until the DMS is built.

```
POST <baseUrl>/api/inbox/upload
Authorization: Bearer <token>
Content-Type: multipart/form-data; boundary=…
```

Parts:

| Part | Type | Meaning |
|---|---|---|
| `file` (repeated) | any, with `filename` | One part per attachment of the email. |
| `metadata` | `application/json` | `{ "sender", "senderName", "subject", "date" (ISO), "messageId", "documentType" (null for now), "link" }` |

`link` is a URL back to the email in Seamless (`/mail/msg/m<id>`).

Expected response: any `2xx` means stored (the first 2 KB of the body is kept in the delivery log). `401/403` bad token,
`4xx` rejected (retried on the webhook schedule, up to about 20 hours), `5xx` temporary. Make the upload idempotent on
`messageId` plus filename: a retry may repeat a request that actually succeeded.
