# Phones, desktop clients & contacts

Seamless is the mail server your devices talk to — important once safe delete makes it the only
complete copy of your mail.

## Connect a mail app

1. Settings → Devices → **Create app password** (one per device; revoke any time).
2. In the mail app, add an IMAP account with the server settings shown on that page:
   - **IMAP**: your Seamless host, the port shown (TLS if configured, else use only on a trusted
     network or behind a TLS reverse proxy)
   - **SMTP**: same host, submission port — sending relays through the right account
     automatically based on the From address
   - **Username**: your Seamless login email · **Password**: the app password
3. Folders: the unified INBOX/Sent/Drafts/Archive/Junk/Trash plus one folder per label under
   `Labels/`. Flag and move changes made on the phone flow back to the store (and the origin
   server where the message still exists there).

Tested against standard IMAP clients; very old clients that require full BODYSTRUCTURE MIME
maps may fall back to downloading whole messages.

## Contacts (CardDAV)

The addressbook builds itself from who you write to and who you reply to — never from
unsolicited senders. Manage it under Settings → Contacts (edit, hide, vCard import/export).

Sync to a phone: add a CardDAV account (iOS: Settings → Contacts → Accounts → Other; Android:
DAVx5) with the CardDAV URL from Settings → Devices, your login email, and an app password.

## Compose anywhere

Autocomplete in the web composer ranks addresses by how often you actually interact with them.
The same addressbook serves every device via CardDAV.
