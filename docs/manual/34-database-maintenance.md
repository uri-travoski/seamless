# Database maintenance

*Administrators only. Settings → Storage → Database maintenance.*

Seamless keeps itself tidy. Logs, finished background jobs, expired sign-ins and similar leftovers are removed on a schedule, so the database
stays small and searches stay fast. **None of the defaults touch your mail, contacts, labels, rules or anything else you created.**

## What each cleanup does

| Task | What it removes | Default schedule |
|---|---|---|
| Expired sessions | Sign-ins that expired or were revoked | every 6 hours |
| Finished jobs | Background jobs done more than 7 days ago, failed more than 30 days ago | daily |
| Stopped disposable addresses | Addresses stopped for more than 6 months (with their leftover Bin mail) and expired unknown-address quarantine | daily |
| Seen-uid tables | Remembered message ids for mail the provider no longer holds, older than 60 days. Never while the message is still on the server (POP3 "leave on server", catch-all "leave") | weekly |
| Events | The notification event log, older than 90 days | weekly |
| Notifications | Read ones older than 90 days, unread ones older than 180. Open alerts are never touched | weekly |
| Resolved alerts | Alerts that are resolved *and* read, older than 90 days. Open alerts stay for as long as the problem lasts | weekly |
| Webhook deliveries | Delivered ones older than 30 days, failed or given-up ones older than 60 | weekly |
| Processing logs | Rule, filter and AI log lines older than 60 days | weekly |
| Tracking opens | Raw open rows older than a year are folded into one summary row per message: the open count and last-open time stay | monthly |
| Bounces | Bounce records older than 180 days | monthly |
| Stale devices | Phones and browsers registered for push that were not seen for 90 days | weekly |
| Dead API tokens | Tokens revoked or expired more than 90 days ago | monthly |
| Orphan rows | Search, attachment-text, vector, label and AI rows that point at messages that no longer exist | weekly |
| Orphan files | Objects in the mail bucket and upload files that no message references, older than 7 days. **The weekly run only reports.** | weekly report, delete on request |
| Statistics (ANALYZE) | Nothing — refreshes the statistics the database uses to plan queries | weekly |
| Vacuum | Cleans dead rows on tables with more than 20 % dead rows or after a big delete. Does not block anything | monthly, or on demand |
| Rebuild bloated indexes | Rebuilds indexes that are more than 40 % empty space (`REINDEX CONCURRENTLY`, no blocking) | quarterly, or on demand |
| Reclaim disk (VACUUM FULL) | Rewrites bloated tables so disk space goes back to the system. **Locks each table while it runs** | manual only |
| Audit log | Entries older than the audit retention (730 days) | daily |

Every schedule, retention number and the on/off switch can be changed in the table. Changing a schedule re-plans the next run at once.

## How the cleanups behave

* They delete in small batches (at most 5,000 rows at a time) with a short pause between, so the app stays responsive.
* Only **one** maintenance task runs at a time, instance-wide. If another is running, the second is logged as *skipped*.
* They are skipped while a **backup**, **mail archive**, **archive import** or **storage migration** is running, and retried half an hour later.
* Each statement has a time limit, so a stuck cleanup cannot hold a lock for long.
* If a task fails **twice in a row**, the administrators get a [critical alert](31-alerts.md) ("Database cleanup … keeps failing"). It clears itself after the next success.

## The buttons

* **Preview** (per task): shows how many rows and roughly how many bytes the task would free, and changes nothing. It is written to the log as a preview.
* **Run now** (per task): runs it immediately.
* **Run all safe cleanups**: runs every cleanup above except orphan files, vacuum, reindex and VACUUM FULL.
* **Analyze now**: refreshes statistics.
* **Vacuum now**: vacuums the tables that need it.
* **Find orphaned files**: lists unreferenced files with their sizes. **Delete these** removes exactly that list after a confirmation, re-checking each file first: anything that a message started to use in the meantime, or that is younger than 7 days, is kept. Tick **delete automatically** on the Orphan files row only if you want the weekly run to delete as well.
* **Rebuild bloated indexes**: rebuilds indexes with more than 40 % bloat. The button shows how many there are.
* **Reclaim disk (VACUUM FULL)**: offered with a warning; the button turns up a count when tables are more than 30 % bloat. Use it at a quiet time: mail is unavailable for the seconds or minutes each table is locked. It never runs by itself.

## The top card

The database size, the ten biggest tables (size, rows, share of dead rows) and, per task, the last run (when, rows removed, space freed) and the next run. "Freed" for deletions is an estimate from the average row size: the space is reused by new data straight away, and returned to the system only by VACUUM FULL.

## Reading the log

The **Maintenance log** lists every run: automatic or manual (and who pressed the button), preview or real, result (*ok*, *failed*, *skipped* and why), rows removed, bytes freed and duration. Filter by task, automatic/manual, status and date; **Export CSV** downloads what is filtered. Manual runs, settings changes and the log export are also written to the [audit log](22-audit-log.md) (`maintenance.run`, `maintenance.settings`, …).

## When to use what

* Nothing, normally. The schedule is enough.
* After deleting a large amount of data (a big import cleaned out, a mailbox removed): **Run all safe cleanups**, then **Vacuum now**.
* Searches have become slow: **Analyze now**, then **Rebuild bloated indexes**.
* The disk is nearly full and the database is much bigger than its data: look at the dead-rows column, then **Reclaim disk** at a quiet time.
* The mail bucket is bigger than your mail: **Find orphaned files**.
