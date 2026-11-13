# Health

**Settings > Health** is one page that shows whether everything is working. A green dot means fine, amber means
worth a look, red means something needs fixing. The page refreshes itself every 30 seconds.

## The panels

- **Mailboxes** — for each mailbox: connected, paused or can't connect; when it last synced; how many messages arrived in the
  last 24 hours. **Re-sync** restarts that mailbox's connection. If a Gmail or Microsoft mailbox's sign-in has stopped working
  it says so — reconnect it in **Settings > Mailboxes**.
- **Sending** — failed sends in the last 24 hours and 7 days, messages scheduled for later, and messages being held for Undo.
- **Background tasks** — undo-send, snooze and reminder timers run as small background tasks. This shows how many are waiting,
  and lists any that failed with the reason, so you can **Retry** or **Dismiss** them. A task more than five minutes late turns
  the panel red.
- **AI** — whether any AI provider is set up. To check one actually answers, use **Test** in **Settings > AI**.

Admins also see:

- **Mail storage** — whether the mail bucket can be written to and read from, how fast, and roughly how much mail is in it.
  **Check now** tests again.
- **Backups** — whether backups are on, when the last one finished, and when the next is due. Red if the last one failed or
  none has succeeded for more than twice the usual gap.
- **Server** — version, how long it has been running, database size, memory and free disk space.

## AI line

The AI card shows **AI: 12 waiting · 0 failed · last verdict 2 min ago**. *Waiting* is mail not yet looked at, *failed* is mail the AI could not judge
(it waits in Review). After a change of AI provider it may add **re-learning N**: your learned examples are kept and quietly re-read with the new
provider in the background. If mail has waited more than 30 minutes while the provider keeps failing, the line turns red and a critical
**AI backlog stuck** alert is sent (see Alerts). **Retry now** puts failed mail back in the queue and runs the AI immediately.

## Alerts

Seamless raises a notification (bell, and push if you allow it) when something turns red: a mailbox can't sync, a mailbox
sign-in has stopped working, backups are overdue, mail storage is unreachable, or a background task failed for good. The same
problem alerts at most once every 6 hours so you aren't nagged. Choose which ones push in **Settings > Notifications**.

For the problems that matter most — a mailbox that has stopped working, a revoked sign-in, failing backups, unreachable storage — set up
**critical alerts** (SMS, Telegram or email to another address, plus a red pinned notification): see [Critical alerts](31-alerts.md).
If none is set up, a red banner at the top of this page says so.

## Watching from outside

Point an uptime monitor (UptimeRobot, Uptime Kuma, a cron job with `curl`) at:

```
https://your-seamless-address/healthz
```

It needs no sign-in and answers `200` with `{"ok":true,...}` when the server and its database are up, or `503` when the
database can't be reached. It deliberately reveals nothing else.

## Database cleanups

Health shows a cleanup that keeps failing as a critical alert. The cleanups themselves (old logs, finished jobs, expired tokens, orphaned files, vacuum) and their log live in **Settings → Storage → Database maintenance**: see [Database maintenance](34-database-maintenance.md).
