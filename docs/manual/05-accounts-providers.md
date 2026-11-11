# Accounts & providers

Add and manage mailboxes under **Settings > Mailboxes**. Each mailbox syncs independently and merges into your unified inbox. **Add mailbox** opens a short wizard: address and colour → provider (detected from the address) → incoming → outgoing → **Test** (separate *Test incoming* and *Test outgoing* buttons that show each step: DNS, connect, TLS, sign-in, folders) → categories → identity (signature, aliases, Sent copy). A wrong password fails clearly at the *Sign in* step.

## IMAP / SMTP accounts

For most providers (Fastmail, iCloud, company mail, self-hosted), choose **Add account** and enter:

- **IMAP** host, port, and whether TLS is on — for reading mail.
- **SMTP** host, port, and TLS — for sending.
- Username and password. For **Apple / iCloud** and Gmail with 2FA, generate an **app-specific password** at your provider and use that.

Give the account a **name**, a **color** (the bar shown on its rows), a **signature**, and any **aliases** you send from.

## Gmail and Microsoft (OAuth)

Connect **Gmail** or **Microsoft / Outlook** with **Connect with OAuth** instead of a password. The setup wizard walks you through registering an app in Google Cloud or Azure once; after that, accounts authorize with a click and Seamless syncs and sends over XOAUTH2. Tokens are encrypted at rest.

The OAuth app credentials are entered once per instance (they are shared by everyone on your server); each user's account tokens are separate and private.

## Safe delete (origin-side cleanup)

By default Seamless keeps your mail on the origin server untouched. If you turn on **Safe delete** for an account (per account, off by default), Seamless can remove mail **at the source** after it has been safely archived here — but only when every check passes: the raw message is stored with a matching checksum, it is older than the grace window you set, and the account toggle is on.

Choose the mode: move to the origin's **Trash** (default — a second safety net), **expunge**, or archive. The wizard shows a dry-run count ("would remove N messages") before you enable it. Seamless keeps its own copy forever regardless.

## Managing accounts

Edit an account any time, disable it to pause syncing, or remove it. Removing an account stops its sync and deletes its rows from Seamless (your mail stays on the origin server).
