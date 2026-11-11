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

## Sending through a provider

By default a mailbox sends through its own SMTP server. Under **Settings > Sending** you can add a *provider* instead: **SendGrid**, **Brevo**, **Amazon SES**, **Mailgun**, **Postmark**, or any **SMTP relay** (with presets for Gmail, Outlook, iCloud, Zoho, Fastmail and the SMTP side of the API providers). Each form asks only for what that provider needs (an API key, a region, a sending domain…). Keys are stored encrypted and are never shown again; leave the field blank when editing to keep the stored one.

- **Test** checks the key with a call that sends nothing (for example SendGrid's scopes or Mailgun's domain lookup) and shows each step. Amazon SES and relay tests check the sign-in.
- To use a provider, open **Settings > Mailboxes**, edit the mailbox and choose **Send through** on the last step. Choose “This mailbox's own SMTP” to go back.
- **Fallback:** pick another provider to try once if this one is rate-limited (HTTP 429), down, or unreachable. A `send.failed` notification tells you the fallback was used. Rejections such as a bad address or unverified sender are *not* retried, because a second provider would reject them too.
- The sending address (or its domain) must be verified at the provider.
- A copy still goes into the mailbox's Sent folder when “Save a copy in Sent” is on.
- Cloudflare Email Sending is not offered as an API provider yet; use its SMTP details with the *SMTP relay* type.
- The daily limit field is stored for later; it is not enforced yet.

## Managing accounts

Edit an account any time, disable it to pause syncing, or remove it. Removing an account stops its sync and deletes its rows from Seamless (your mail stays on the origin server).
