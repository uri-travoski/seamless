# Viewing old mail (open an archive in another copy of the app)

You can keep years of old mail out of your everyday app (see [Archive old mail](11-backup-restore.md)) and still read and search it later, in this app or in a second copy of it. This page explains the idea, the **import** step, **Viewing mode**, and a step-by-step recipe for a dedicated second copy.

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

## AI memory in imported archives

When the archive has an `ai/` folder, the import (category **AI memory**, on by default) merges it: guidance, rules, label retention and newsletter
choices are added next to yours (nothing of yours is overwritten; duplicates are skipped), and each archived message keeps its decisions and learned
examples. In **Viewing mode** the labels and the *why?* explanation of old mail are shown, but the AI never runs: no AI calls are made and nothing
is re-filed.

## Viewing mode (Live vs Viewing only)

An app is either in **Live mode** (the normal app) or **Viewing mode** (a reference copy).

| | Live | Viewing only |
|---|---|---|
| Fetch new mail (IMAP, POP3, push) | yes | **no** — nothing connects to any mail server |
| Send mail (compose, reply, scheduled, forwarding, API, mail apps) | yes | **no** |
| Read, search, labels, filters and rules (including **Run on existing mail**), saved views, templates, contacts, notes, stars, moves, delete, exports, backups, settings, users, shared mailboxes | yes | **yes — exactly the same** |
| Drafts | saved on the server | saved in this app only |

In Viewing mode the screen shows a bar, **"Viewing mode — reference copy. Mail cannot be sent or received."**, the browser tab starts with `[Viewing]`, the Compose button is greyed, and the Send button is disabled. The refusal is enforced by the server too: a send attempt (even from the API or a mail app) is answered with *"Viewing mode: sending mail is turned off"*, and nothing is stored from a push-inbound address.

### Switching (administrators)
**Settings → General → Mode.**
- **Live → Viewing only**: confirm, and every connection to mail servers is closed.
- **Viewing only → Live**: you are warned that *"This instance will start fetching and sending mail for its connected mailboxes"* and must type **LIVE**. Mail that was queued earlier (scheduled sends, messages waiting to send, pending changes to mail servers — for example because a backup was restored here) is counted and, by default, **discarded**, so old queued mail is never sent by surprise. Untick the box to keep it.
- If the server was started with `SEAMLESS_MODE=viewing` (or `live`), the switch shows **"Set by the server configuration"** and cannot be changed in the app.

Restoring a backup into a Viewing instance never connects to a mail server, even though the restored mailboxes still carry passwords.

The mode is also shown on **Settings → Health** and in `/healthz` (`"mode":"viewing"`).

## Recipe: a second copy that only views old mail

This keeps old mail away from your everyday app: a second copy of the app that cannot send or receive, with its own database and bucket.

**(a) What you need**
- A second copy of the app (the same image or source as your live one) on any machine, ideally not exposed to the internet.
- Its **own database** (for example `seamless_viewer`) and **own bucket** for what it stores. Do not share the live app's.
- The archives themselves (a bucket you can read, or a downloaded folder or `.zip`).

**(b) Configure it.** Copy `stack/viewer.env.example` to `.env.viewer`. The important lines:

```
SEAMLESS_MODE=viewing
SEAMLESS_SECRET=<a long random string, its own>
PORT=4902
PUBLIC_URL=http://localhost:4902
DATABASE_URL=postgres://seamless:seamless@localhost:5461/seamless_viewer
S3_BUCKET=seamless-viewer
FACADE_IMAP_PORT=1144
FACADE_SMTP_PORT=1588
```

If you use Docker, `stack/docker-compose.viewer.yml` starts the app and its own Postgres from that file: `docker compose -f stack/docker-compose.viewer.yml up -d`.

**(c) First login.** Open `http://localhost:4902`. It is a brand-new app, so it asks you to create the first administrator. Choose any email and password (they do not have to match your live app). You will see the Viewing mode bar straight away.

**(d) Bring the archives in.** **Settings → Archives → Attach a bucket**, fill in the bucket that holds your archives (a read-only key is enough), **Test and attach**, tick the archives and press **Import**. Or upload a `.zip`. See [Settings → Archives](#settings--archives-administrators-only) above.

**(e) Browse and search.** Each archived mailbox appears as "Archive — name@example.com (2012–2020)". Search with the normal search box and every operator (`from:`, `before:`, `attachment:`…). Labels, saved views and templates that came with the archive are ready to use.

**(f) Add more later.** When your live app archives another batch, come back to **Settings → Archives**, press **Find archives** and import the new ones. Mail already imported is skipped, so nothing is duplicated.

**(g) What you cannot do.** Send or reply to mail, receive new mail, test mailbox connections, or add mailboxes that connect to a server. Everything else works, including exports and backups of the viewer itself. To use the copy as a live app instead, switch it to Live (only possible when `SEAMLESS_MODE` is not set) and read the warning first.
