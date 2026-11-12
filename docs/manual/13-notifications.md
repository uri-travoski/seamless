# Notifications

## The bell

The bell in the top-right corner shows how many notifications are unread and, when clicked, the latest 20 (the list scrolls inside the pop-up): new mail, someone opening your email, send failures, mailboxes that can't sync, backups, security changes. Repeats collapse into one line ("Opened 5×"). Click a notification to go straight to it — an open goes to the **open report**, new mail to the message. **Mark all read** clears the badge (in every open tab); the gear opens the settings.

## All notifications

**See all notifications** opens the full list, with filters that stay in the address bar (so you can bookmark a view):

- **All / Unread / Read**
- **Type** — New mail, Opened, Reminders, Follow-ups, Snooze, Send failures, Sync errors, Backups, Security, Leads, Smart views, Assignments
- **Mailbox or category**
- **Date** — today, last 7 or 30 days, or a custom range
- **Search** in the title and text

Choose 25, 50 or 100 per page. Tick notifications to mark them read, unread, or delete them.

## Settings > Notifications

- A row per type with **In-app** (the bell) and **Push** (your phone or desktop).
- **Mute mailboxes** — a muted mailbox still gets mail, it just doesn't notify.
- **Quiet hours** — push is held between the times you set (Perth time); the bell still fills up.
- **Sound** — a short chime when something new arrives.

The **Mailbox space** rows warn you (and the administrators) at 80 % and 100 % of your storage limit; they never stop mail arriving ([details](29-administrator.md)).

Push needs to be enabled once per device in **Settings > General**. "New sign-in" notifications are off by default; turn them on here if you want one every time someone signs in.

## VIPs

A VIP is an address (`boss@example.com`) or a whole domain (`bigclient.com`) you never want to miss.

- **Mark one:** right-click a message (or the ⋯ menu) → **Mark sender as VIP**, or add it under **Settings > Notifications > VIPs**. VIP mail shows a ★ badge in the list.
- **Never auto-removed:** the AI and your rules can still label VIP mail, but nothing archives, moves or deletes it automatically, and the retention sweep skips it. Marking a sender VIP also cancels any pending deletion on their existing mail.
- **Always notifies:** VIP mail raises a bell notification and a push even if "New mail" is switched off. By default it also ignores quiet hours; untick **VIP mail ignores quiet hours** to hold its push like everything else. A muted mailbox stays muted.
- Search with `is:vip`; a **VIPs** smart view is offered in the sidebar suggestions.

