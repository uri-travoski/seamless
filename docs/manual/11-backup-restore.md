# Backup and restore

Your mail bodies are already safe. Every message is archived as a raw `.eml` file in your object storage (R2, B2, MinIO), and those files are portable — any mail client can read them.

Everything else is not. Labels, threads, read and starred state, your rules, every AI decision and embedding, retention countdowns, contacts, app passwords and users live only in Postgres, on the server. If the server dies, that is what you lose: not the mail, but everything that makes it findable and everything the AI has learned.

Backup closes that gap. It writes the database to the same bucket the mail lives in, so one surviving bucket is enough to rebuild the whole instance.

## What a backup contains

A single encrypted file plus a plaintext manifest, written to `seamless/<timestamp>/` in your bucket. Backups always live under the `seamless/` app folder, so one bucket can hold backups from several apps without them mixing — anything you type in the prefix box is nested inside it (`nightly` becomes `seamless/nightly/`).

- **`data.ndjson.gz.enc`** — every table, gzipped, then AES-256-GCM encrypted with your `SEAMLESS_SECRET`.
- **`manifest.json`** — timestamp, row counts per table, size and checksum. Left readable so you can list and check backups without the secret.

The `.eml` blobs are not copied. They are already in the bucket, and the restored rows point straight back at them.

At a few thousand messages a backup is a couple of hundred kilobytes, because it stores the index rather than the mail.

## Turning it on

**Settings → Backup.**

- **Back up automatically** — off by default. Nothing runs until you tick it.
- **How often** — twice a day, daily, every 2 days, twice a week, or weekly.
- **At** — the UTC hour the run starts. Twice-daily also runs twelve hours later.
- **Keep last** — how many runs to retain. Older ones are deleted from the bucket automatically.
- **Where it goes** — the prefix inside your existing bucket. Defaults to `backup/`, alongside the `msg/` mail blobs.
- **Email me if a backup fails** — optional address, sent through your first connected account.

**Back up now** runs one immediately, whatever the schedule says.

Every run writes itself, then reads back what it wrote — checksum, then decryption, then a full parse — before reporting success. A backup that cannot be read is reported as a failure, not a success.

If the server is switched off through a scheduled slot, the run happens shortly after it comes back rather than waiting for the next slot.

## When a backup fails

Three things happen at once, so a silent failure is not possible:

- a **push notification** to every admin,
- an **email**, if you set an address,
- a **red banner** in Settings → Backup that stays until dismissed, and a line in **Settings → Logs** under `backup`.

## Restoring

There is no restore button in Settings, on purpose. Restoring replaces every table, and the situation that calls for it is a server that no longer exists — one you cannot log in to.

On the rebuilt machine, give Seamless the same `.env` it had before: the same `S3_*` pointing at the surviving bucket, and the same `SEAMLESS_SECRET`. Then either:

**From the browser.** Open Seamless. Because the database is empty it shows the first-run setup screen, and that screen lists the backups it can see in your bucket. Pick one, press Restore, then sign in with your old account.

**From the terminal.**

```bash
npm run restore -- --list      # what is in the bucket
npm run restore -- --latest    # restore the newest
npm run restore -- --key backup/2026-07-14T02-00-00-000Z/
npm run restore -- --latest --verify-only   # check it reads back, change nothing
```

The restore runs in one transaction. If anything goes wrong part-way, nothing is applied. It refuses to run against a database that still has users unless you add `--force`.

When it finishes, your mail, labels, rules, AI history and logins are all back, and the messages point at the `.eml` files that never moved.

## If you change the prefix, set it in the environment too

The prefix you type in Settings is stored in Postgres — the very thing a disaster destroys. A rebuilt server has no way to know you used anything other than the default `seamless/`, and will report no backups found while yours sit safely in the bucket.

If you use a custom prefix, put it in `.env` as well:

```
BACKUP_PREFIX=my-prefix/
```

Or pass it at restore time: `npm run restore -- --prefix my-prefix/ --list`.

## The one thing that can still lose you everything

`SEAMLESS_SECRET` decrypts the backups. **Keep a copy somewhere other than the server.** A password manager is fine; the server's own disk is not.

With the bucket but without the secret, the backups cannot be read — though your `.eml` files are still plain files in the bucket, so the mail itself is never held hostage.

## A drill is worth more than a backup

Once, after setting this up, prove it works rather than assuming:

```bash
npm run restore -- --latest --verify-only
```

That downloads the backup, checks the checksum, decrypts it with your secret and parses every row, without touching the database. If it prints a row count, the recovery path is real.
