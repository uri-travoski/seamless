# Devices & contacts

Seamless is the system of record, and your phone or desktop mail app can connect **to Seamless itself** — read, move, flag, and send through it, with contacts synced too.

## App passwords

Standard mail apps log in with an **app password**, not your main password. Create one under **Settings > Devices**: give it a label ("iPhone Mail", "Thunderbird desk"), choose its scopes (IMAP, SMTP, CardDAV), and copy the generated secret. Revoke any device password at any time; last-used times are shown.

## Connect a mail app (IMAP + SMTP)

Point Thunderbird, iOS Mail, K-9, or any IMAP client at Seamless using the host and ports shown on the Devices screen, with your Seamless email and the app password:

- **IMAP** — your labels appear as folders; flags, moves, and searches stay in sync with the web app.
- **SMTP** — mail you send is relayed out through the owning account's real provider (so SPF/DKIM stay intact) and a copy lands in Sent.

Drafts and sent mail saved by the client show up in Seamless too.

## Sync contacts (CardDAV)

Add a **CardDAV** account on your phone pointing at the address shown on the Devices screen, using the same app password. Your Seamless addressbook then syncs to the phone's Contacts natively.

## The addressbook

Seamless builds an addressbook automatically, like Gmail: the moment you send, every recipient is saved, and so is every sender you reply to (never no-reply addresses, your own addresses or mailing-list mail). There is an **Undo** on the small "Saved to contacts" message and an on/off switch in **Settings > Contacts**. Manage it there:

- Add contacts with several emails and phones, edit, merge duplicates, hide, filter and sort.
- Organise people into **groups** (they sync to phones as vCard categories, and a group name works in the To field).
- **Import / export** vCard, Google CSV, Outlook CSV and generic CSV.
- Compose autocomplete matches names, emails and organisations and ranks by how recently and often you interact.

Everything is explained in [Contacts](32-contacts.md).
