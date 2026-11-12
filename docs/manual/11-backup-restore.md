# Backup and restore

Your mail is already safe. Every message is archived as a raw `.eml` file in object storage, and those files are portable — any mail client can read them.

Everything *else* is not. Labels, threads, read and starred state, your rules, every AI decision and embedding, retention countdowns, contacts, app passwords and users live only in Postgres, on the server. If the server dies, that is what you lose: not the mail, but everything that makes it findable and everything the AI has learned about you.

Backup closes that gap. It writes the database to object storage, encrypted, so a destroyed server is a restore rather than a loss.

## What is in a backup

Two objects per run, in a folder named for the moment it was taken:

```
<bucket>/seamless/2026-07-14T02-00-00-000Z/
    manifest.json          plaintext — what this backup is
    data.ndjson.gz.enc     ciphertext — the database itself
```

**`data.ndjson.gz.enc`** is every table, gzipped, then AES-256-GCM encrypted with your `SEAMLESS_SECRET`. It holds the whole database: mail metadata, labels, rules, AI decisions, embeddings, contacts, users, and your stored account credentials.

**`manifest.json`** is deliberately left readable, so you can list and check backups without the secret. It records when the backup was taken, how many rows, a checksum, and **which bucket the mail blobs live in** — but never any credentials.

By default the `.eml` files are **not copied**. They are already in object storage, and the restored rows point straight back at them. A backup is the *index*, not the archive. That is why a few thousand messages costs a couple of hundred kilobytes rather than gigabytes. If you want the mail itself protected too, turn on **Include emails** (next section).

### The app folder

Backups always live under a `seamless/` folder inside the bucket, so one bucket can hold several applications' backups without them mixing. Anything you type in the prefix box is nested inside it — `nightly` becomes `seamless/nightly/`. This cannot be escaped, by design.

## Turning it on

**Settings > Backup.**

1. Tick **Back up automatically**. Nothing runs until you do; the default is off.
2. **How often** — every N hours (1–24), twice a day, daily, every 2 days, twice a week, weekly, or monthly (every 30 days). For *every N hours* the hour-of-day setting does not matter; only the gap does.
3. **At** — the UTC hour the run starts. Twice-daily also runs twelve hours later.
4. **Keep last** — how many runs to retain. Older ones are deleted from the bucket automatically.
5. **Where it goes** — the prefix inside your bucket. Leave it alone unless you have a reason.
6. **Email me if a backup fails** — one address, or several separated by commas.
7. **Include emails** — also copy the mail files into the backup storage (see below).

**Back up now** runs one immediately, whatever the schedule says. Use it once after setup, so you have a backup before you need one.

## Include emails (blob mirror)

With **Include emails** on, each run also copies every mail file to `<prefix>blobs/<same key>` in the backup storage. A small index remembers what is already there, so the second run copies only new messages. After copying, 20 random files are read back from the mirror and checked against their SHA-256; a mismatch makes the backup a **failure**. The backup's `manifest.json` records `blobs: { mirrored, total, lastKey, verifiedSample }`, and each backup carries a `blobs.keys.gz` list of the files its database rows refer to.

When old backups are deleted (keep-count), mirror files that no remaining backup refers to are deleted too (mark-and-sweep). Turning the option off stops copying but leaves the mirror in place until it ages out of every kept backup.

**Restoring mail from the mirror.** If the main mail bucket is lost, restore with the mirror as the mail store:

```
npm run restore -- --latest --mail-from-mirror
```

The restore finishes by telling you whether the mail was reachable; if the main bucket could not serve it and the backup has a mirror, it says so and suggests this flag. (On the first-run screen the same option is sent as `mailFromMirror`.) Backups made by older versions (format 1) still restore normally; they just have no mirror.

## What each run does

1. **Writes** the encrypted dump and its manifest to storage.
2. **Reads back** what it just wrote — checksum, then decryption, then a full parse. A backup that cannot be read is reported as a **failure**, not a success. An unverified backup is a rumour.
3. **Prunes** older runs beyond your keep-count (and sweeps unreferenced mirror files).
4. **Records** the result in **Settings > Logs** under `backup`.
5. **Alerts** you if anything went wrong.

If the server is switched off through a scheduled slot, the run happens shortly after it comes back rather than waiting a whole cycle.

## When a backup fails

Three things happen at once, so a silent failure is not possible:

- a **notification** to every admin (in-app and push by default; change it in Settings > Notifications — `backup.failed` / `backup.ok`),
- an **email**, to every address in the alert field,
- a **red banner** in Settings > Backup that stays until dismissed, plus an `ERROR` line in **Settings > Logs**.

The email goes out through your first connected account. Separate several addresses with commas — `you@example.com, ops@example.com`. Duplicates and typos are dropped rather than allowed to break delivery for everyone else.

If the storage bucket itself is unreachable, the Backup page still loads and shows you why. That is deliberate: the page you need in order to fix a broken bucket must not be the page that breaks with it.

## Restoring

There is no restore button in Settings, on purpose. Restoring replaces every table, and the situation that calls for it is a server that no longer exists — one you cannot log in to.

### From the browser

On the rebuilt machine, give Seamless the same `SEAMLESS_SECRET` and point `S3_BACKUP_*` at the bucket holding your backups. Then open Seamless. Because the database is empty it shows the first-run setup screen, and that screen lists the backups it can see.

Pick one, press **Restore**, then sign in with your existing account. Your password still works — it came back with the database.

If it finds nothing, it asks you where to look: bucket, endpoint, access key, secret key. You do **not** need to tell it where the mail is — that travels inside the backup.

### From the terminal

```bash
npm run restore -- --list                    # what is in the bucket
npm run restore -- --latest                  # restore the newest
npm run restore -- --key seamless/2026-07-14T02-00-00-000Z/
npm run restore -- --latest --verify-only    # check it reads back, change nothing
npm run restore -- --prefix nightly/ --list  # if you used a custom prefix
```

The restore runs in **one transaction**: if anything fails part-way, nothing is applied. It refuses to run against a database that still has users unless you add `--force`.

### The mail comes back too

The backup knows which bucket holds your mail, and the credentials for it, so a restored server **reconnects on its own** — you do not have to remember or retype the mail bucket's settings.

Then it proves it: it fetches one message's blob and checks it against the checksum embedded in the key. You will see either

```
Mail blobs: bucket "seamless-emails" (from the backup — no S3_* needed)
  reachable: fetched msg/1/1c57…e49.eml and its checksum matches.
```

or a plain warning that the bucket is unreachable. Without that check, a restore would "succeed" with every row in place and every message body silently failing to open — the worst way to fail, because you would only find out weeks later.

If you *do* set `S3_BUCKET` in the environment, it wins. That is how you migrate mail to a new bucket.

## Export and import

A backup is for disaster recovery and needs the same `SEAMLESS_SECRET` to read. An **export** is for moving: one
file, `.seamless-export`, protected by a password you choose (at least 12 characters), that imports on any Seamless
server — even one with a different `SEAMLESS_SECRET`. Every stored secret (mailbox passwords, sending-service keys,
storage credentials) is re-encrypted with your export password inside the file and with the new server's secret on import.

### Make an export
**Settings → Backup → Export everything…** (admins). Pick a password, optionally tick *Include the mail itself*
(adds every `.eml`; the file can get big), and the browser downloads it. Keep the password somewhere safe — it
cannot be recovered. Each export is recorded as a notification event.

### Import on a new server
On the first-run screen (no users yet) open **Import from export file**, choose the file and enter its password.
The whole database is restored. If the export included mail, the messages are written to *this* server's mail
storage; otherwise the server reconnects to the mail bucket named in the export and checks that it can read it.
A wrong password or a damaged file is reported and nothing is written. A full import is refused once any user exists.

### Import just the settings
**Settings → Backup → Import settings from an export file** merges the labels, rules, filters, templates, sending
services, categories and preferences into your account. Anything whose name already exists is skipped, so running
it twice is safe. No mail or mailboxes are imported. The settings come from the user with your email address in
the file, or else the first admin.

## Keeping backups away from the mail

By default, backups sit in the same bucket as the mail. That is convenient, and it is also a single point of failure: one deleted bucket, or one leaked key, takes both.

To separate them, name a different bucket:

```
S3_BACKUP_BUCKET=backups
```

Better still, give the backups their own endpoint and credentials, so they live in a different account — or a different provider — from the mail they protect:

```
S3_BACKUP_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_BACKUP_REGION=auto
S3_BACKUP_BUCKET=backups
S3_BACKUP_ACCESS_KEY=...
S3_BACKUP_SECRET_KEY=...
S3_BACKUP_FORCE_PATH_STYLE=false
```

Every `S3_BACKUP_*` falls back to its `S3_*` twin, so leaving them unset keeps the single-bucket behaviour.

Restore is unaffected by the split. The backup only ever carried the database; the restored rows reach the mail through the mail bucket's own settings. Losing the mail bucket does not even stop a restore — the database comes back whole, and the bodies reappear when the mail bucket does.

## The one thing that can still lose you everything

`SEAMLESS_SECRET` decrypts your backups. It also decrypts the account credentials inside them — including the keys to your mail bucket.

**Keep a copy somewhere other than the server.** A password manager is right; the server's own disk is not. With the bucket but without the secret, your backups are unreadable.

Your `.eml` files remain plain files in the bucket regardless, so the mail itself is never held hostage — but the labels, rules and AI history would be gone.

## Run a drill

A backup you have never restored is a hope, not a plan. Once, after setting this up:

```bash
npm run restore -- --latest --verify-only
```

That downloads the backup, checks the checksum, decrypts it with your secret and parses every row — without touching the database. If it prints a row count, the recovery path is real.

## Troubleshooting

**"No backups found" on a rebuilt server.**
Almost always the prefix. The prefix you typed in Settings was stored in the database — the very thing you lost. A rebuilt box looks in the default `seamless/`. If you used a custom one, set it in the environment (`BACKUP_PREFIX=seamless/nightly/`) or pass it: `npm run restore -- --prefix nightly/ --list`. Check `S3_BACKUP_BUCKET` too.

**"SEAMLESS_SECRET does not match the one this backup was written with".**
The backup is fine; the key is wrong. Find the secret that was in use when the backup was taken. There is no way around this one — that is the point of encrypting it.

**"checksum mismatch: backup payload is corrupt or truncated".**
The upload was cut short or the object was damaged. Restore an older run instead — this is exactly why **Keep last** is more than 1.

**"Cannot reach your storage bucket" banner.**
Credentials or endpoint are wrong, or the bucket does not exist. Check `S3_BACKUP_*`. Note that Seamless *creates* a bucket that does not exist, so a typo in the bucket name quietly makes a new empty bucket rather than failing — if backups have "disappeared", check you are looking at the right bucket name.

**Restore succeeded, but no message bodies open.**
The database is back but the mail bucket is not reachable. The restore will have told you so. Point `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` at the mail bucket and restart. The rows are fine; only the bodies are missing.

**Backups are failing every night.**
Open **Settings > Logs** and filter to `backup`. The `ERROR` line names the cause. The most common are expired storage credentials and a full disk on the object store.

**The scheduled backup never runs.**
Check that **Back up automatically** is actually ticked, and remember the hour is **UTC**, not local time. The Backup page shows the next run time.

**Nothing is being backed up at all.**
Backups do not include the `.eml` files by design — only the database. If you want copies of the raw mail as well, that is your object storage provider's job (R2 and S3 both offer versioning and lifecycle rules).

## Archive old mail

A backup protects the whole app. An **archive** is different: it copies your *older* mail to a backup storage target so you can keep the app small, and it can later bring that mail back or let you search it without restoring.

**What goes into an archive.** Mail older than the age you pick (1 to 10 years, or any number of days) in the mailboxes you own. By default these stay in the app: starred mail, mail from VIP senders, Drafts, Scheduled and Snoozed mail, mail with an open follow-up, and Spam and Bin. Each can be switched on for a run. Shared mailboxes are archived only by their owner.

**Copy or move.**
- *Copy* leaves everything where it is.
- *Move* copies each message, reads it back and checks its checksum, and only then removes it from the app. The copy on your mail server is **not** touched unless you also choose to move it to the server's Bin. A message that fails the check is kept and listed as failed.

**Where it goes.** Always a *backup* storage target (Settings > Storage), never the mail bucket. Each archive is a folder `archive/<number>/` holding the `.eml` files, a `manifest.json`, search index files (`index-1.jsonl.gz`, …) and a `config.json` with your labels, rules, filters, saved views, templates, contacts, businesses and identities. It never contains passwords, tokens or keys. The folder is self-describing, so another copy of the app can read it later.

**Before you run it.** *Preview* shows the number of messages, their total size and the oldest and newest dates. *Dry run* also lists the first few subjects, and changes nothing.

**Getting mail back.** *Search archive* looks through the index by subject, sender and date without restoring. *Download one message* gives you the `.eml`. *Restore* puts mail (all of it, a date range or a sender search) back in its original mailbox with its original date, read/starred state and labels. Mail already in the app is skipped, and a restore does not run filters, AI or notifications.

**Deleting an archive** removes its files from the storage target and needs you to type its name.

Every plan, run, completion, restore and deletion is written to the audit log.

### Step by step in the app

Open **Settings > Backup** and find the card **Archive old mail** (people who are not administrators find the same card under **Settings > Storage**).

1. **Archive mail older than** — pick 1 to 10 years, or **Other…** and type a number of months or years.
2. **Which mailboxes** — *All of mine*, or one mailbox.
3. **Where to** — a backup storage target. If the list says there is none, an administrator adds one in **Settings > Storage**.
4. **What to do** — *Copy only* (everything stays in the app) or *Move* (copy, check every file, then remove from the app). Move can also send the mail to the Bin on the mail server; that is off unless you tick it.
5. Tick-boxes: keep starred mail, keep VIP senders, include Spam and Bin.
6. Watch the line under the choices. It updates as you change them, for example *1 234 567 messages, 38.2 GB, from 2012 to 2023*.
7. **Dry run** lists the oldest messages the rule picks and changes nothing. **Run now** shows the numbers and the mode and asks you to confirm. Move asks a second time: type the word **MOVE**.
8. **Every month** — tick it to run the same rule on its own once a month. You get a notification each time a run finishes or fails. If the storage target has gone, the monthly rule switches itself off and tells you.

The **Archives** list under the card shows each run: date, rule, number of messages, size and a progress bar while it works. While an archive is running, **Settings > Health** also shows it.

- **Browse / search** looks through the archive index; **Download .eml** saves one message.
- **Restore…** brings back everything, a date range or the messages matching a search. Restored mail looks like normal mail.
- **Delete…** asks you to type the archive's name.

**Searched and found nothing?** When a search has no result and you have a finished archive, the list says *Older mail may be in an archive* with a **Search archives** button.

## Reference

**Environment**

| Variable | Meaning |
|---|---|
| `SEAMLESS_SECRET` | Encrypts backups and stored credentials. Keep a copy off the server. |
| `BACKUP_PREFIX` | Folder inside the bucket. Default `seamless/`. Always nested under the app folder. |
| `S3_BACKUP_BUCKET` | Bucket for backups. Falls back to `S3_BUCKET`. |
| `S3_BACKUP_ENDPOINT` / `_REGION` / `_ACCESS_KEY` / `_SECRET_KEY` / `_FORCE_PATH_STYLE` | Backup storage. Each falls back to its `S3_*` twin. |
| `S3_BUCKET` and friends | Where the mail blobs live. On a restored server these are optional — the backup knows. |

**Command line**

| Command | Does |
|---|---|
| `npm run restore -- --list` | List backups |
| `npm run restore -- --latest` | Restore the newest |
| `npm run restore -- --key <dir>` | Restore a specific one |
| `npm run restore -- --verify-only` | Check it reads back; change nothing |
| `npm run restore -- --prefix <p>` | Look under a custom prefix |
| `npm run restore -- --force` | Overwrite a database that still has users |
