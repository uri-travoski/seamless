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
| Manager | Everything a responder can, plus manage assignments (arrives with the shared-inbox workflow). |

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
