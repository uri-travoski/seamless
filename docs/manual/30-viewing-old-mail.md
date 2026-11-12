# Viewing old mail (open an archive in another copy of the app)

You can keep years of old mail out of your everyday app (see [Archive old mail](11-backup-restore.md)) and still read and search it later, in this app or in a second copy of it. This page explains the idea and the **import** step. (The step-by-step recipe for setting up a dedicated second copy is added with *Viewing mode*.)

## Two ways to bring old mail into an app

| You want | Use | What you get |
|---|---|---|
| Browse and search **old mail** in an app that has its own, different mail | **Settings → Archives → Import** (this page) | The archived mail, as read-only "Archive — you@example.com (2012–2020)" mailboxes, plus (optionally) your labels, rules, filters, saved views, templates, contacts, businesses and more, merged with what is already there |
| A **complete clone** of another app (users, settings, everything) | **Settings → Backup → Restore** of a full backup | Everything arrives exactly as it was; this **replaces** the data of the app you restore into |

Use **Archives → Import** when you only want to read old mail. Use a full **Restore** when you are building a copy of the whole app.

## Settings → Archives (administrators only)

### Attach a bucket
1. **Settings → Archives → Attach a bucket**. Give the endpoint, region, bucket, the **folder (prefix)** that holds the archives, an access key and secret key. A **read-only key is enough**: the app never writes to this bucket.
2. **Test and attach** runs seven read-only checks (reach the server, sign in, list the folder, find archives, read a manifest, check the format version, read one message and verify its checksum). Nothing is saved if a check fails.
3. **Find archives** lists every archive in the folder: name, date, rule, mailboxes, message count, size and the app version that made it. An archive made by a **newer** version of the app than this one is shown greyed with the reason and cannot be imported until you update.
4. A normal full **Backup** in the same folder is recognised too. It is not imported: the page tells you to use **Settings → Backup → Restore** instead, because that replaces this app's data.

### Or use a file
If you downloaded an archive folder, **Upload a .zip** of it (a zip of the folder that contains `manifest.json`), or type the path of a folder on the server and press **Read folder**.

### Import
1. Tick the archives to import. If there are several mailboxes, choose all or some.
2. Choose what else to bring over (all ticked by default): **labels, rules, filters, saved views, templates and quick replies, contacts, businesses and identities, VIP and trusted senders, notes, appearance**. Anything with the same name that already exists here is **kept as it is and skipped** (never overwritten). The result is shown on the import card ("labels: 3 new, 1 kept").
3. **Import**. You can leave the page. The card shows a progress bar, can be **paused and resumed**, and survives a restart: messages that already arrived are never copied twice, so importing the same archive again changes nothing.
4. If some messages fail (a damaged file in the archive, for example) they are listed with **Show failed**, and **Retry failed** tries only those again.

### What you get
- One read-only mailbox per archived mailbox, named "Archive — name@example.com (first year–last year)", with the original folders, dates, read/starred/answered state and labels. There is no sending or receiving for these mailboxes and no password is stored.
- The mail behaves like any other: lists, threads, search (including `attachment:` and every other operator), labels, exports and backups of this app.
- Imported mail is **protected from automatic deletion** (it is marked "keep" with the reason "archived"), so a label's retention countdown can never delete a reference copy. You can still delete a message by hand.
- No AI classification, no notifications, no filters or rules run on the imported mail as it arrives. Afterwards you can use a filter's **Run on existing mail** to apply it to the archive.
- Labels appear in the sidebar with their colours and nesting. Filters and rules appear in Settings and can be edited. Saved views and templates are ready to use. Contacts autocomplete. Businesses and identities appear.

### Remove imported mail
**Remove imported mail** on an import card deletes only the messages that came from that archive (and its archived mailbox once empty). Labels, rules and other app data that were merged in stay; remove those in their own Settings pages.

## Good to know
- Archives contain no passwords, tokens, API keys or private keys. Business logos up to 256 KB are included.
- The bucket's read-only key is stored encrypted, like every other storage key, and is never shown again.
- Large uploaded `.zip` files are read into memory; for a very large archive prefer attaching the bucket.
