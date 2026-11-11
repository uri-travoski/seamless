# BizBooks endpoint Seamless sends to

Seamless (connector **BizBooks**) calls this on BizBooks. **BizBooks must accept this shape** — it is an assumption until
BizBooks is built.

```
POST <baseUrl>/api/bills-inbox
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "supplier": "Acme Pty Ltd",
  "abn": "51824753556",
  "total": 110.0,
  "gst": 10.0,
  "dueDate": "2026-08-15",
  "invoiceNumber": "INV-1042",
  "messageId": "<bill1@acme.test>",
  "subject": "Invoice INV-1042",
  "from": "billing@acme.test",
  "date": "2026-07-08T10:00:00.000Z",
  "link": "https://mail.example.com/mail/msg/m123",
  "filename": "inv.pdf",
  "pdfBase64": "…"
}
```

- Any field except `messageId`, `subject`, `from`, `date`, `link` may be `null` (nothing was found). `abn` is 11 digits, `total`/`gst` are dollars, `dueDate` is `YYYY-MM-DD`.
- The first PDF attachment is sent as `pdfBase64` (up to 5 MB); a larger one is sent as `pdfUrl`, a signed link that works for 1 hour. Without a PDF neither key is present.
- Fields come from the user's AI provider (schema-constrained prompt) with a pattern-matching fallback for ABN, totals and dates.

Response: any `2xx` = accepted. Make it idempotent on `messageId`; Seamless retries failures on the webhook schedule.
