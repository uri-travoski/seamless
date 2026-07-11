# Searching your mail

The search box is at the top of every screen. Type a query and press **Enter**; press **Escape** to clear it and return to the inbox.

Search runs on the server across **all** of your mail — not just the messages currently loaded on screen. So a search for a message buried thousands of rows deep still finds it.

## What you can search

Plain words match the subject, body, and participants (full-text). Combine them with any of these operators:

- `from:alice` — sender contains "alice" (name or address).
- `to:support` — a recipient contains "support".
- `label:Receipts` — has the label "Receipts".
- `in:trash` / `in:sent` / `in:archive` — search a specific mailbox by role.
- `is:unread` — only unread mail.
- `is:starred` — only starred mail.
- `has:attachment` — only messages with attachments.
- `before:2026-07-01` and `after:2026-06-01` — date range (YYYY-MM-DD).
- `"exact phrase"` — match the words together, in order.

## Examples

- `from:paypal has:attachment` — statements and receipts from PayPal that carry a file.
- `label:Travel after:2026-06-01` — recent travel mail.
- `is:unread from:boss` — unread mail from your boss.
- `"invoice number" before:2026-01-01` — older invoices by phrase.

## Notes

- Search **excludes Trash and Junk** unless you ask for them with `in:trash` or `in:junk`.
- Operators can be combined freely; everything is AND-ed together.
- Clearing the box (the **x** or Escape) returns you to whatever mailbox you were in.
