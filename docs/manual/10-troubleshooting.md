# Troubleshooting

## An account will not connect

- Double-check the IMAP/SMTP host, port, and TLS setting.
- For Gmail, iCloud, or any provider with two-factor auth, use an **app-specific password**, not your normal one.
- For OAuth (Gmail / Microsoft), make sure the instance's app credentials are set up (the wizard covers this) and re-authorize the account.
- **Settings > Logs** shows sync errors with the exact message.

## New mail is not showing up

- Check the connection indicator says **Live**. If it says Offline, the connection is reconnecting.
- Open the **menu** (top-right, right of the bell) and choose **Check all mailboxes for new mail**.
- Check the dot in the top bar: green means the browser is connected live; amber means it is reconnecting.
- Confirm the account is enabled under Settings > Mailboxes (its card shows a status pill — OK, Syncing, Error or Paused — and the last error).

## Images are not loading

Remote images are blocked by default for privacy. Click **Load images** on a message to show them once, or turn on **Always load remote images** in **Settings > General**.

## The AI is not labelling mail

- Make sure a provider is configured and the **classify** (and ideally **embed**) tasks are mapped under **Settings > AI**.
- Check you are not over the monthly AI budget — over budget, only rules and embeddings run.
- Ambiguous mail waits in **Review** by design; clear it to train the system.

## Mail is being deleted / not deleted as expected

- Retention starts in **dry run** — nothing is actually deleted until you switch it live in **Settings > Import & Retention**. The Logs show what the sweep *would* do.
- Deletions go to **Trash** first; open Trash and **Restore**.
- Protected labels and manually-unread mail are never swept.

## Backups are failing

- Open **Settings > Logs** and filter to `backup` — the `ERROR` line names the cause. Expired storage credentials and a full object store are the usual two.
- If the Backup page shows **"Cannot reach your storage bucket"**, the endpoint or keys are wrong. Note that Seamless *creates* a bucket that does not exist, so a typo in the bucket name quietly makes a new empty one rather than failing.
- A scheduled backup that never runs: check **Back up automatically** is ticked, and remember the hour is **UTC**.
- Everything else — restoring, a lost prefix, a wrong secret, bodies that will not open after a restore — is covered in **Backup and restore**.

## A phone or desktop mail app will not connect

- Use an **app password** from **Settings > Devices**, not your main password.
- Use the exact host and ports shown on the Devices screen, and make sure the app password has the right scope (IMAP/SMTP/CardDAV).

## Push notifications

Enable native push under **Settings > General > Push notifications**, then choose which kinds push in **Settings > Notifications**. It works best when Seamless is installed as an app (PWA).

## Still stuck

**Settings > Logs** is the first place to look — sync, classification, retention, sending, and facade activity are all recorded there, filterable by kind.
