# Trash & retention

Seamless can clear out mail you never needed, but it is cautious by design. This page explains exactly what is deleted,
when, and the **Dry run** switch that keeps it all safe while you learn.

Everything here lives in **Settings → Storage**, in the **Trash & retention** section at the bottom of the page. Every user sees it, not only administrators. (Search the settings for "trash", "deleted", "recycle bin", "bin" or "retention" to find it.)

## How the sweep works

Once an hour Seamless looks for mail that has been marked for removal — mail whose **label** has a retention countdown
(the orange `Nd` badge on a row; see [AI, rules & retention](06-ai-automation.md)). It then does two things:

1. **Moves expired mail to the Bin** (Trash). This is recoverable.
2. **Purges** mail that the sweep itself put in the Bin once it has been there longer than **Trash grace**.

It never touches: starred mail, mail you have already opened and marked "keep", VIP senders, protected labels,
anything you restored or moved yourself, Sent, Drafts, Spam or Scheduled.

## Dry run — what it means

**Dry run is ON by default.** With it ticked, the sweep **deletes nothing**. Instead it writes a line to **Settings →
Logs** for each message it *would* have trashed or purged ("DRY RUN: would trash …"). Read those lines for a few days;
when the list is only things you'd happily lose, untick the box. The page then shows a red *Live mode* note and the
sweep really moves mail to the Bin and purges old swept Bin items.

## Set it up

1. **Settings → Storage**, scroll to **Trash & retention**.
2. Leave **Dry run** ticked and check **Settings → Logs** after the next hour.
3. When you're happy, untick **Dry run — only log what would be deleted**.
4. Set **Trash grace (days before purge)** — default 30. Mail the sweep trashed is permanently removed after this many
   days.
5. Set **Auto-clear logs after (days)** — default 90 — to keep the Logs page tidy.
6. **Run sweep now** runs it immediately and prints the numbers.

## What is and isn't auto-purged

- **Auto-purged (once Dry run is off):** any message that was *moved to the Bin from inside Seamless* — by the sweep,
  by you pressing Delete, or by a filter — once it has sat there longer than **Trash grace**. The clock starts when it
  enters the Bin. Restoring a message from the Bin stops the clock and marks it "keep" for good.
- **Not auto-purged:** mail that was already in a Bin on the provider's side when Seamless first synced it, Spam, and
  Archive. These stay until you delete them yourself.
- Deleting from the Bin or Spam by hand is permanent and asks first.
- While **Dry run** is on nothing is purged at all, whoever put it in the Bin.

## Read later

Mail you move to **Read later** (newsletters) is trashed after **30 days** unless it is starred, snoozed or from a VIP.
Change or turn this off in **Settings → Newsletters** (retention tick-box and days). Read later items are
also covered by Dry run: with Dry run on they are logged, not trashed.

## Audit log

The [audit log](22-audit-log.md) is kept for **730 days** (two years) by default. Change it in **Settings → Audit log
→ Keep entries for → Save**. Only an administrator can change it; entries older than the limit are removed once a day.

## Limits & gotchas

- Backups: swept mail is still in your backup until the backup itself is pruned ([Backup and restore](11-backup-restore.md)).
- Logs: the sweep's decisions are in **Settings → Logs** until they age out.
- Opening a message and choosing **keep** (or starring it) cancels its countdown.
- There is no separate "Empty Bin" button: select the messages in the Bin and delete them, or wait for the grace period.
