# Seamless manual — start here

Each page says what a feature is, how to set it up step by step, how to use it every day, and what its limits are.
In Settings, the **?** at the top right of each tab opens the matching page.

## Set up my mail
- [Getting started](01-getting-started.md)
- [Sending & receiving mail](25-sending-receiving.md) — what Seamless can and can't do, with a recipe for every kind of account
- [Accounts & providers](05-accounts-providers.md) — IMAP, Gmail, Microsoft, POP3, SendGrid, Brevo, SES, Mailgun, Postmark, Cloudflare
- [MXroute](24-mxroute.md)
- [Fetching, syncing & pagination](09-syncing-pagination.md)
- [Devices & contacts](08-devices-contacts.md) — use your phone or desktop mail app with Seamless

## Organise
- [Reading & organising mail](02-reading-organizing.md) — labels, snooze, folders
- [Searching](03-searching.md) — including smart views
- [Composing & sending](04-composing.md) — undo send, follow-ups, templates, quick replies
- [Shared mailboxes](19-shared-inbox.md)
- [Leads](21-leads.md)
- [Setup recipes, click by click](28-setup-recipes.md)

## Stop unwanted mail
- [Stopping unwanted senders](26-stopping-unwanted-senders.md)
- [Disposable addresses](16-disposable.md)
- [Phishing warnings](14-phishing.md)
- [Trash & retention](27-trash-retention.md)

## Send as my business
- [Businesses and identities](18-businesses.md)
- [Composing & sending](04-composing.md)

## Automate
- [AI, rules & retention](06-ai-automation.md)
- [Teach the AI](07-teach-the-ai.md)
- [Notifications](13-notifications.md)

## Security & backups
- [Security](12-security.md)
- [Encryption](23-encryption.md)
- [Audit log](22-audit-log.md)
- [Administrator tools & storage limits](29-administrator.md) — users, password reset, mailbox for a user, quotas
- [Viewing old mail](30-viewing-old-mail.md) — attach a bucket of archives, import old mail, Viewing mode and a second view-only copy
- [Backup and restore](11-backup-restore.md)
- [Storage](17-storage.md)
- [Health](15-health.md)
- [Critical alerts](31-alerts.md) — be told by SMS, Telegram or email when a mailbox stops working; red pinned notifications
- [Troubleshooting](10-troubleshooting.md)

## Integrations
- [Integrations: webhooks, apps, API](20-integrations.md)

## What Seamless doesn't do
- It is not a mail server: it cannot receive mail from the internet by itself ([details](25-sending-receiving.md)).
- It does not change your DNS records; it can only check them.
- It does not send **email digests** (summary emails of your notifications or newsletters) and has no **thread mute**.
- It cannot read text inside scanned images or photos (no OCR).
- It cannot stop a message reaching your provider; it files it after it arrives ([details](26-stopping-unwanted-senders.md)).

## Where things are in Settings
The Settings menu is grouped. Use the **Search settings…** box at the top to jump to anything ("trash", "deleted", "recycle bin", "undo send", "api token"…).

| Group | Tabs |
|---|---|
| Mail | General, Mailboxes, Sending, Disposable |
| Business | Businesses, Leads, Integrations |
| Organise | Labels, Filters, Rules, Templates, Newsletters, AI |
| Alerts & look | Notifications, Appearance |
| Security | Security, Alerts ([details](31-alerts.md)), Encryption, Audit log |
| Data | Storage (buckets, **Trash & retention**), Backup, Archives ([details](30-viewing-old-mail.md)), Import |
| Devices | Contacts, Devices |
| System | Health, Logs, Users (admins: [details](29-administrator.md)) |
