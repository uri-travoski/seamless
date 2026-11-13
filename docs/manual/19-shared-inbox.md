# Shared mailboxes

A mailbox (a connected email account) can be **shared** with other people who have a login on the same Seamless.
Everyone works from the one mailbox; the mail stays with its owner.

## Sharing a mailbox
Settings → Mailboxes → pick a mailbox → **Share with…**. Choose a person and a role. Only the owner (or an admin) can
change sharing. Removing someone, or changing their role, takes effect straight away.

| Role | Can do |
|---|---|
| Viewer | Read mail, search, open attachments and the original source. Cannot change anything or send. |
| Responder | Everything a viewer can, plus mark read/unread, star, move, archive, delete, and reply or send **as the shared address**. |
| Manager | Everything a responder can; also manages who is assigned (responders can assign too). |

## Where it shows up
- The mailbox switcher has a **Shared** section. Shared mail is also included in **Unified**.
- Choose a shared mailbox to see only its mail (`shared:<id>` scope).
- Search covers shared mail you can read — never mail from mailboxes that were not shared with you.

## Good to know
- **Labels are personal unless the owner shares them.** Your own labels never go onto shared mail. The owner can offer their labels, and you can accept them (see *Sharing labels* below).
- **Notes are private.** A note you add to a shared message is visible only to you.
- **Sending:** replies from a shared mailbox go out through the owner's server and identity, and the copy lands in the
  mailbox's Sent folder. A viewer who tries to send gets "403 – viewers cannot send".
- **Follow-up reminders and tracking reports** belong to the mailbox owner. **Snooze** is off on shared mail unless the owner or a manager turns it on (see *Team settings* below).
- The IMAP/SMTP facade for desktop clients only exposes your **own** mailboxes.

## Working a shared inbox together
Open a thread in a shared mailbox and you'll find, under the messages:

- **Assigned to…** — pick who owns the thread (only people with access to the mailbox are listed). They get a notification
  ("Alex assigned you a thread"). The list shows their initials on the row.
- **Open / Pending / Done** — the thread's status. A thread nobody has touched counts as Open.
- **Team internal comments** — a clearly marked box for notes to your team. They are **never sent** to the customer. Type `@name`
  (first name or the part of the email before `@`) to mention a teammate; they get a notification, but only if they have access
  to that mailbox. Comments are limited to 5000 characters. Viewers can read comments but not write.
- **"Alex is replying…"** — while a teammate has a reply open on the same thread you see this line, so you don't answer twice.
  It disappears 60 seconds after they stop (or when they close the reply). People without access to the mailbox never see it.

Viewers can look but not change anything; responders and managers can assign, change status and comment.
If someone's access is removed, their assignments are cleared.

## Finding things
Open the **menu** at the top-right: a **Shared Mailbox** item appears as soon as you have any sharing. Click it to expand **Assigned to me** and **Unassigned**.
Search operators: `assigned:me`, `assigned:none`, `status:open`, `status:pending`, `status:done`
(for example `status:pending assigned:me`).

## Sharing labels
Labels are personal by default. The owner of a mailbox can offer their labels to the people they share it with; each person
decides for themselves.

**If you own the mailbox (offering):**
1. Settings → **Mailboxes**, find the mailbox and click **Share with…**.
2. When adding a person, tick **Also share my labels with this person** and click **Share**. For someone you already share
   with, tick the same box under their name.
3. By default all your labels are offered. To offer only some, click **Pick labels** next to their name and tick the ones you want
   (nothing ticked = all labels).
4. Next to their name you see where it stands: *waiting for their answer*, *accepted* or *rejected*. If they rejected, you can
   click **Offer again**.
5. To stop, untick the box. The labels disappear for that person straight away; they stay on the messages for you.

**If you were offered labels:**
1. You get a notification ("Alex shared 3 labels from Support") and a banner at the top of Settings → **Labels**.
2. Click **Accept** to use them, **Reject** to say no, or **Decide later**. *Decide later* keeps the offer waiting and hides the
   banner for a week; you can still answer any time under **Shared with me** on the same page.
3. Accepted labels show on the shared mailbox's mail (with the owner's name and colour), appear in the sidebar, and work in
   search (`label:Work`). You cannot rename, recolour or delete them.
4. **Responders and managers** can tick or untick these labels on messages of that shared mailbox; everyone who has the label
   sees the change. **Viewers** see the labels but cannot change them.
5. Changed your mind? Settings → Labels → **Shared with me** → **Leave** (or **Accept** again after rejecting).

Your own labels stay personal and still cannot be used on shared mail.

## Team settings: snooze and round robin
Settings → Mailboxes → **Share with…** → **Team settings** (owner or a manager). Both are off until you turn them on, per mailbox.

- **Allow snoozing.** When on, responders and managers can snooze a thread of this mailbox. It is hidden **for everyone** until the
  time (a team decision) and the thread shows "Snoozed by <name> until …". It comes back as unread when the time is up. Anyone who
  may snooze can also remove the snooze. When it is off the Snooze button is greyed with "Snoozing is off for this shared mailbox".
  Viewers can never snooze. **Follow-up reminders stay with the owner.**
- **Round robin.** Tick "Hand out new threads in turn" and choose who takes part (owner, responders, managers). Each **new** thread
  that arrives live is assigned to the next person in the pool, who gets a notification. Replies to existing threads, old mail
  fetched when a mailbox is first connected, and mail in other folders are never assigned. `assigned:me` finds your threads.
  Settings → Mailboxes shows a **Round robin** box where you can tick "I'm away" for a mailbox: you are skipped until you untick it.
  If nobody is available, the thread stays unassigned. The order carries on fairly after a restart; people removed from the
  mailbox are skipped. Changes to these settings are written to the audit log.

## Read and unread are shared
There is one read state per message. When one person marks a shared message read, everyone with access sees it as read; when
someone marks it unread again, it is unread for everyone. (Starring works the same way.) Notes and personal labels stay private.

## Shared mailboxes on a viewing copy
On a copy in [Viewing mode](30-viewing-old-mail.md) shared mailboxes, shared labels and team settings work as usual; only sending and receiving are switched off.
