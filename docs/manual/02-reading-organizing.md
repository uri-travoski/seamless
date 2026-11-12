# Reading & organizing mail

## List views

Switch between **Split** and **Table** view with the button above the list (or in **Settings > Appearance**). Split shows the list beside the reading pane; Table is a full-width list where clicking a row opens the message.

## Reading a row

Each row shows, left to right:

- **Account color dot** — a colored dot at the very start of the row showing which connected account the mail belongs to (see below).
- **Checkbox** — select for bulk actions.
- **Star** — click to flag; starred mail also appears under **Starred**.
- **Sender**, then **subject** and a preview of the body.
- **Label chips** — the colored labels applied to the mail.
- **Badges** on the right:
  - **Eye + number** — open tracking. On your **sent** mail it means the recipient opened it. On an **inbox** row, a reply-arrow + eye means *your reply in that thread was opened*.
  - **Paperclip** — the message has attachments.
  - **Countdown** (orange `Nd`) — the retention sweep will move this to Trash in N days. Open it and keep it to cancel.
  - **Note icon** — a private note is attached.
- **Date**.

### Account color dots

Each account you connect gets its own color, set in **Settings > Mailboxes** (the same dot appears next to the account in the sidebar). In the unified inbox — where every account's mail is merged together — the colored dot at the very start of each row tells you at a glance which account a message arrived on. Hover the dot to see the account's email address.

![Blue and purple account color dots marking two accounts in the message list](/manual/account-color-dots.png)

In this example, blue marks one account and purple another. Add more accounts and each gets its own distinct color.

## Bulk actions

Tick one or more checkboxes (or the master checkbox) and a bulk toolbar appears: mark read/unread, move, label, or delete many messages at once.

## The reading pane

Opening a message shows the whole **conversation**: older messages are collapsed, click to expand. Each message has its own star, a **Reply** / **Forward** row, and a **Download .eml** button for the raw original.

- **Attachments** appear as tiles under the message — click to download.
- **Summarize** (top right) uses AI to condense a long thread into a few bullets.
- **Why this label?** (next to the sender) shows which tier applied the label and how confident it was.

## Labels

Labels are colored, work across all accounts, and each carries its own **retention** (see AI, rules & retention).

- **Apply / remove** — use the tag menu in the reading-pane toolbar to toggle labels on the open message. On the applied chips, click the **×** to remove a label directly.
- **Recolor** — click the **color dot** in front of a label (in the sidebar or in Settings > Labels) to open the color palette and pick a new color; it updates everywhere.
- **Create / edit** — **Settings > Labels**, or the **+** next to the sidebar LABELS heading. Give it a name, a description (which the AI uses to categorize), a color, and retention rules.

## Snooze

Snooze hides a conversation from your Inbox and brings it back, unread and at the top, at the time you choose.

- Click the **clock** icon on a row (hover it), in the reading toolbar or in the bulk bar, use **Snooze** in the
  right-click menu, or press **b**.
- Choose **Later today**, **This evening**, **Tomorrow** (8 am), **This weekend** (Saturday 8 am), **Next week**
  (Monday 8 am), **Someday** (30 days) or **Pick date and time…**. Times are in Perth time; choices that have already
  passed today aren't offered.
- The whole conversation is snoozed, and snoozed mail doesn't count as unread. Look in **Snoozed** (sidebar, under
  *More*) to see what's waiting — the list shows when each one returns. Right-click > **Remove snooze** brings one back now.
- If someone replies while a conversation is snoozed it comes back straight away (turn this off in
  **Settings > General > Sending and snoozing**).
- When it returns you get a **Back in your Inbox** notification.

## Private notes

Open a message and add a **private note** — a personal reminder attached to that email. It is only visible to you and is never sent. This is different from **Teach the AI**, which changes how future mail is handled.

## Moving & cleaning up

Every message has the same set of actions in four places:

- **Hover** a row: Archive, Delete, Mark read/unread, Report spam fade in on the right. On a phone, **swipe left** to archive and **swipe right** to toggle read.
- **Right-click** a row: Reply, Reply all, Forward, Mark read/unread, Star, **Label ▸**, **Move to ▸**, Archive, Report spam, Delete, **Block sender**, **Create filter from this…**, Open report (tracked mail), Print, View original, Download .eml.
- The **reading-pane toolbar** (the ⋮ button holds the full menu).
- The **bulk bar** when rows are ticked. Tick the box at the top to select the page; a banner then offers **Select all N in this view** — the action then runs on the server across every matching message.

Archive, Delete, Spam and Move show an **Undo** for 5 seconds (bulk actions too). Delete moves mail to the **Bin**; deleting from the Bin or Spam is permanent and asks first. **Block sender** makes a filter that sends their future mail to Spam.

## Mailbox categories and the switcher

The button in the top-right shows where you are — **Unified**, a category (**Work**, **Personal**, **Disposable**, or your own) or a single mailbox — with its unread count. Click it (or press **Ctrl+K**) for the list: categories first, then every mailbox A–Z. Type to filter, use the arrow keys and Enter. Shortcuts: **g u** Unified, **g w** Work, **g p** Personal, **g d** Disposable.

Everything follows the scope: the list, folder counts, label counts, Starred and search. The choice is remembered and is part of the address (`/mail/work/inbox`), so a reload keeps it. Assign mailboxes to categories in **Settings > Mailboxes > Categories** (drag a mailbox onto a category; one mailbox can be in several).

## Sidebar

Inbox (with **Review** under it when the AI needs a decision), Starred, Drafts, Scheduled, Sent, **Templates**, **Spam**, **Bin**, then **More** (Archive). Labels follow, A–Z by default, nested under their parent. Reorder the folders and choose what lives under More in **Settings > Labels > Sidebar**. When the scope is a single mailbox, its own folders appear under **Folders**.

## Labels

**Settings > Labels** lists every label with its message count. Nest a label inside another, choose whether it shows in the sidebar **always**, **only if unread**, or is **hidden**, and sort the sidebar A–Z, manually or by count. Tick two labels to **merge** them (messages, rules, filters and AI memory all move to the one you keep), or tick several to delete them.

## Keyboard shortcuts

Press **?** for the full list (turn them off there or in Settings > General): **j/k** next/previous, **o**/Enter open, **u** back, **x** select, **e** archive, **#** delete, **!** spam, **s** star, **Shift+I/U** read/unread, **l** label, **v** move, **r/a/f** reply/all/forward, **c** compose, **/** search.

## Themes

**Settings > Appearance**: the **Seamless** theme is the original look; **Rolltop** is warm and paper-toned with serif titles; **Simply Seamless** is a quiet, content-first light theme (actions and checkboxes appear on hover, tinted label pills, quick filters above the list). Pick light, dark or match the system, a custom accent colour, comfortable or compact rows, and a font (Inter by default; any Google font by name), text size (16 by default). The list toolbar also has a compact/comfortable rows toggle next to the split/table toggle.


## Shared mailboxes
Mailboxes shared with you appear under **Shared** in the switcher — see [Shared mailboxes](19-shared-inbox.md).

## Calendar invites

When an email carries a calendar invitation (a `text/calendar` part or `.ics` attachment), a card appears at the top of the message: title, time, location or video link (Google Meet, Zoom and Teams links are detected), organiser and attendees.

- **Times** are shown in your zone (Australia/Perth by default). If the organiser's zone is different, theirs is shown next to it, e.g. an `America/New_York` 9:00 am meeting shows as 9:00 pm Perth time.
- **Accept / Maybe / Decline** sends a standard reply (an iMIP `METHOD:REPLY`) to the organiser from the address you were invited on, with an optional note. The card then shows what you answered.
- A later update to the same event (same UID, same or higher sequence) refreshes the card; a cancellation marks it **Cancelled** and turns off the reply buttons.
- **Download .ics** is always available.
- **CalDAV (optional):** connect a calendar with `PUT /api/calendar-connection {url, username, password}` (password stored encrypted). The card then offers **Add to calendar**, which saves the event to `<calendar-url>/<uid>.ics`. There is no settings screen for this yet, and conflict checking against your calendar is not built.
- On a shared mailbox, viewers can see the card but only responders and managers can reply.

## Newsletters

Seamless recognises newsletters and bulk mail from their headers (`List-Unsubscribe`, `List-Id`, `Precedence: bulk/list`, and the markers
mailing services add, such as Mailchimp, SendGrid and Mailgun).

**The first time** a sender's newsletter reaches you, a slim bar appears above the message with three choices:

- **Keep in Inbox** – nothing changes; the bar stays out of your way afterwards.
- **Read later** – this issue and every future one from that sender skip the Inbox and wait in the **Read later** folder
  (there is no sidebar entry for Read later at the moment). The list shows each item's estimated reading time (words ÷ 230 per minute). Read later items don't
  count towards the Inbox's unread number.
- **Unsubscribe** – see below.

Mail from a **VIP** sender and mail you have **snoozed** is never moved by this feature.

**Unsubscribe.** If the newsletter supports one-click unsubscribe (RFC 8058), Seamless sends the request for you from the server
(private and local addresses are refused, like webhooks). Otherwise, if it has a `mailto:` address, Seamless sends an empty
"unsubscribe" mail from the address the newsletter was delivered to. If it only has a web link, the link opens in a new tab for you
to finish. Afterwards a filter called *Unsubscribed: sender* moves that sender's future mail to the Bin (or Archive – your choice)
and the sender is remembered as *Unsubscribed*. Delete the filter to undo it.

**Settings** (Settings → Newsletters):

- *Archive a Read later item once I have read it* (off by default).
- *Delete Read later items after N days unless starred* – on by default, 30 days. It moves items to the Bin, follows the
  retention **dry-run** switch, and skips starred, VIP and snoozed mail.
- Where an unsubscribed sender's mail goes (Bin or Archive), and the list of senders you have decided on.

There is no newsletter digest email.
