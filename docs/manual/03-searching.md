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
- `opened:yes` / `opened:no` — mail you sent with tracking turned on, that was (or wasn't) opened by a real person. Automatic opens by mail-privacy proxies don't count. Untracked mail matches neither.
- `replied:yes` / `replied:no` — has been answered: marked as answered, or someone else wrote later in the same conversation.
- `older_than:7d` / `newer_than:2w` — by age. Units: `h` hours, `d` days, `w` weeks, `m` months (30 days), `y` years (365 days), e.g. `older_than:3m`.
- `size>5mb` / `size<100kb` — by message size (`b`, `kb`, `mb`, `gb`).
- `attachment:"invoice 1234"` — text **inside** attachments (PDF, Word `.docx`, Excel `.xlsx`/CSV, PowerPoint `.pptx`, plain text, Markdown, HTML).
- `filename:quote*.pdf` — attachment file name; `*` matches any characters and `?` one character. Works for every attachment, including images.
- `is:vip` — mail from one of your VIP senders (see "VIPs" in Notifications).
- `is:waiting` — sent mail with a live "remind me if no reply" follow-up (see "Follow-ups").
- `is:snoozed` — mail that is snoozed right now.
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

## Smart views

A **smart view** is nothing more than a **saved search** that lives in the sidebar under **Smart views**, with a live
count of the messages that match. It never moves, deletes or changes mail. The AI never "runs" a view either: the AI only
*labels* mail (see [AI, rules & retention](06-ai-automation.md)), and a view that mentions a label simply searches for
that label.

### The suggested views

The first time you have none, the sidebar offers a card of **Suggested views**. Press **+ Add** next to the ones you want;
**Dismiss** hides the card for good. Each is exactly this search:

| View | Search it saves | How it is decided |
|---|---|---|
| **VIPs** | `is:vip` | Rule: the sender is on **your** VIP list (an address or a whole domain — **Settings → Notifications → VIPs**). No AI. |
| **Waiting for reply** | `is:waiting` | Rule: a sent message that still has a follow-up reminder open (waiting or due). No AI. See *Follow-up reminders*. |
| **Unpaid invoices** | `label:Invoices is:unread` | **AI/rules label + unread.** Needs a label called **Invoices** (create it in **Settings → Labels**); rules or the AI apply it to invoice mail. "Unpaid" here only means *unread* — Seamless doesn't know if you paid. With no Invoices label the view is empty. |
| **High risk** | `risk:high` | Rule: the phishing checks flagged the message as high risk ([Phishing](14-phishing.md)). No AI. |
| **Attachments over 5 MB** | `has:attachment size>5mb` | Rule: the message has an attachment and is larger than 5 MB. No AI. |
| **Disposable address mail** | `is:disposable` | Rule: the message was delivered to one of your disposable addresses ([Disposable addresses](16-disposable.md)). No AI. |

### Make your own

1. Type a search in the box at the top (try `from:bank is:unread has:attachment`).
2. Click the **bookmark** button next to the **x**.
3. In **Save this search** give it a **Name**, an **Icon** and optionally a **Colour**.
4. Tick **Show in the sidebar**, **Show how many messages match** and/or **Notify me when new mail matches**.
5. Press **Save view**.

### Change or remove one

1. Hover the view in the sidebar and click the **pencil**.
2. Edit the name, the **Search** text, icon, colour or the tick-boxes, then **Save** — or press **Delete** to remove the
   view (your mail is untouched).

### Good to know

- **Counts** refresh when mail changes (at most every 30 seconds) and always equal the number of messages the view lists.
- **Notify on match:** a view with notifications on creates a "Smart view match" notification (Settings → Notifications)
  once per new message, only for mail that arrives after you turned it on.
- Because a view is just a search, anything in the *What you can search* list above works, including `category:`,
  `business:`, `assigned:` and `attachment:`.

## Shared inbox operators
`assigned:me` · `assigned:none` · `status:open|pending|done` — see *Shared mailboxes*.

## Searching inside attachments

Plain search words also look inside attachments, so searching `plumbing` finds the email whose `invoice-1234.pdf` mentions plumbing. Messages that match in the body are listed first; messages that match only in an attachment follow, with a line such as **Matched in invoice-1234.pdf: …the plumbing services…** under the subject and in the reading pane.

- New mail is indexed in the background a moment after it arrives.
- Supported: PDF, Word (`.docx`), Excel (`.xlsx`), CSV, PowerPoint (`.pptx`), text, Markdown and HTML. Up to 200 KB of text is kept per attachment, and files over 20 MB are skipped. Password-protected or damaged files are skipped quietly.
- **Scanned documents and photos are not searchable** (no OCR). You can still find them by file name with `filename:`.
- **Existing mail**: an admin opens **Settings → Health → Attachment search** and presses **Index attachments of existing mail**. It works through 100 messages at a time, can be interrupted and carries on where it stopped, and shows its progress on that page.
