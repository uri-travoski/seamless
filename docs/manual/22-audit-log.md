# Audit log

**Settings → Audit log** is a permanent record of who did what on this server. Admins see everyone's entries;
everyone else sees only their own.

## What is recorded

| Group | Actions |
|---|---|
| Sign-in | `login.ok`, `login.failed` (wrong password or wrong second-factor code) |
| Security | two-factor on/off, recovery codes regenerated, "require 2FA" policy, session revoked, password changed, user added/removed |
| Mailboxes | account added / changed / removed, outbound transport created / changed / deleted / assigned |
| Storage and backup | storage target created / changed, migration started / paused / resumed / cancelled / finished, backup settings, backup run, restore, export, import |
| Automation | rule and filter created / changed / deleted / run, suggestions accepted |
| Integrations | webhook created / changed / deleted / secret rotated, allow-list changes, API token created / deleted |
| Sharing | mailbox share granted / revoked |
| Mail | bulk delete of more than 50 messages, disposable address stopped / started / kept / blocked |
| Encryption | PGP key generated / imported / deleted, S/MIME certificate imported / deleted |
| Other | newsletter unsubscribe, attachment re-index started, audit export, retention change |
| API | one `api.call` entry per REST v1 call (route and status, never the data) |

Each entry has the time (shown in your time zone), who (a person, an API token, or the system), the action, the
target, the IP address and browser, and a few details. **Passwords, secrets, tokens and keys are never stored**: any
detail whose name contains `pass`, `secret`, `token` or `key` is replaced with `[redacted]`.

## Looking things up

Filter by person (admins), action (type the start, e.g. `login` or `webhook.`), target (e.g. `account:3`) and date
range. Click a row for the full details. Results come 50 to a page.

**Export CSV** downloads what the current filters show (up to 5,000 rows). Exporting is itself recorded as
`audit.export`.

## Can it be changed?

No. The database refuses any edit or delete of an audit entry, even from the server's own code. The only way entries
leave is the daily clean-up, which removes entries older than the **retention** (default **730 days**; admins can
change it at the bottom of the page). The clean-up is recorded as `audit.prune`. The audit log is part of the backup,
and a restore brings it back.
