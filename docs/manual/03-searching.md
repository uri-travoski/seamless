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
- `business:"Office Cleaners R Us"` — mail for one of your businesses: messages in a mailbox that has an address in that business, or delivered to one of the business's addresses (see "Businesses").
- `risk:high` or `risk:medium` — messages with a phishing warning (see "Phishing and lookalike warnings").
- `before:2026-07-01` and `after:2026-06-01` — date range (YYYY-MM-DD).
- `"exact phrase"` — match the words together, in order.

## Examples

- `from:paypal has:attachment` — statements and receipts from PayPal that carry a file.
- `label:Travel after:2026-06-01` — recent travel mail.
- `is:unread from:boss` — unread mail from your boss.
- `"invoice number" before:2026-01-01` — older invoices by phrase.

## Notes

- Search **excludes Bin and Spam** unless you ask for them with `in:bin` / `in:spam` (or `in:trash` / `in:junk`).
- `category:work` limits a search to the mailboxes in a category (any category name or key works, e.g. `category:personal is:unread`). Search also follows the scope picked in the top-right switcher.
- Operators can be combined freely; everything is AND-ed together.
- Clearing the box (the **x** or Escape) returns you to whatever mailbox you were in.

## Shared inbox operators
`assigned:me` · `assigned:none` · `status:open|pending|done` — see *Shared mailboxes*.
