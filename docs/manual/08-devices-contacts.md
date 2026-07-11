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

Seamless builds an addressbook automatically from your outgoing mail: every recipient of a message you send, and every sender you reply to, becomes a contact (it never adds unsolicited senders). Manage it under **Settings > Contacts**:

- Browse, search, edit, merge, or hide contacts, and add photos.
- **Import / export vCards**.
- Compose autocomplete ranks contacts by how recently and often you interact with them.
