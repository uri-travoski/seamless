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
- **Labels are personal.** You cannot label shared mail; the owner's labels stay the owner's.
- **Notes are private.** A note you add to a shared message is visible only to you.
- **Sending:** replies from a shared mailbox go out through the owner's server and identity, and the copy lands in the
  mailbox's Sent folder. A viewer who tries to send gets "403 – viewers cannot send".
- **Snooze, follow-ups and tracking reports** belong to the mailbox owner; they are not available to people the mailbox is
  shared with yet.
- The IMAP/SMTP facade for desktop clients only exposes your **own** mailboxes.

## Working a shared inbox together
Open a thread in a shared mailbox and you'll find, under the messages:

- **Assigned to…** — pick who owns the thread (only people with access to the mailbox are listed). They get a notification
  ("Alex assigned you a thread"). The list shows their initials on the row.
- **Open / Pending / Done** — the thread's status. A thread nobody has touched counts as Open.
- **Internal comments** — a clearly marked box for notes to your team. They are **never sent** to the customer. Type `@name`
  (first name or the part of the email before `@`) to mention a teammate; they get a notification, but only if they have access
  to that mailbox. Comments are limited to 5000 characters. Viewers can read comments but not write.
- **"Alex is replying…"** — while a teammate has a reply open on the same thread you see this line, so you don't answer twice.
  It disappears 60 seconds after they stop (or when they close the reply). People without access to the mailbox never see it.

Viewers can look but not change anything; responders and managers can assign, change status and comment.
If someone's access is removed, their assignments are cleared.

## Finding things
In the sidebar, a **Shared** section appears as soon as you have any sharing: **Assigned to me** and **Unassigned**.
Search operators: `assigned:me`, `assigned:none`, `status:open`, `status:pending`, `status:done`
(for example `status:pending assigned:me`).
