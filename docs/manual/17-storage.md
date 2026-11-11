# Storage

**Settings → Storage** (admins only) is where you choose the buckets Seamless uses. There are three roles:

| Role | What it holds |
|---|---|
| **Mail** | the raw `.eml` of every message and attachment |
| **Backups** | the encrypted database backups |
| **Inbound spool** (optional) | a copy of every email the Cloudflare Worker receives, saved *before* it is delivered to Seamless |

Providers with a ready-made form: Cloudflare R2, Backblaze B2, Amazon S3, Wasabi, DigitalOcean Spaces, Hetzner Object Storage, MinIO, or any other S3-compatible service. Pick one and the endpoint pattern is shown (for example R2: `https://<accountid>.r2.cloudflarestorage.com`, region `auto`).

## The connection test

Pressing **Test connection** (or **Test again** on a saved target) runs these checks and shows each result:

1. Reach the server (DNS and TLS)
2. Sign in and find the bucket
3. Write a 1 KB test object
4. Read it back and compare it byte for byte
5. List the folder
6. Delete the test object — if this is refused you get a **warning**, not a failure, because backup retention and clean-up need delete permission
7. Speed (average time per request)

Nothing is saved unless the test passes. Editing credentials re-tests before saving; leave a key field blank to keep the stored one. Credentials are encrypted and never shown again — only the last four characters of the access key.

## Backups need their own bucket

A backup stored in the same bucket as your mail is lost together with it. Seamless therefore refuses a backup target that points at the mail bucket unless you tick **I accept using the same bucket**.

## Which setting wins

1. `S3_*` variables in the server's environment (the operator wins; Settings → Storage shows a notice when this is the case)
2. The active target saved here
3. The server's built-in defaults (or the bucket a restored backup remembers)

If you already have mail stored, a new mail target is saved but **not** switched on — moving mail to another bucket needs a migration (next section), so nothing is stranded.

## First run

The setup screen has an optional **Choose where mail is stored** box. Leave it off ("Skip — use the server's settings") to keep the defaults; you can come back to this page any time.

## Re-ingest spool

If you set up a spool, **Settings → Health → Mail storage → Re-ingest spool** reads every saved email from it and delivers it again. It is safe to press more than once: messages already received are skipped.

## Moving to another bucket

Add the new bucket as a storage target first (it is tested when you save it), then **Settings → Storage → Moving to another bucket → Move to another bucket…**. The same works for backups.

1. Pick what to move and where. You see how many objects and roughly how long it will take.
2. **Start.** Seamless makes a list of everything, copies it in batches (you can leave the page; it carries on, and carries on after a server restart), then checks the copy: every object's size, a checksum on a sample (10 % plus the newest 1000, or every object if you tick *Check every object byte by byte*), 20 random messages are opened from the new bucket and compared with the database, and the counts must match.
3. **Switch over.** Mail is held for a few seconds (at most 30) while anything that arrived during the copy is copied and checked, then Seamless starts using the new bucket. Admins get a notification when it finishes or fails.

If the check finds a problem the migration stops with **Stopped — nothing was switched**; use *Retry failed objects* (which copies them again) or *Cancel*.

**Your old bucket is kept for 14 days and never deleted automatically.** Until then *Switch back to …* copies anything new back to the old bucket and switches to it again. After 14 days *Clean up old storage* appears; it deletes the old copies only after you type the old bucket's name.

If the server's environment names the mail bucket (`S3_*`), that still wins after a restart. Remove those variables to keep the new bucket.
