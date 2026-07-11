# Troubleshooting

**An account shows no mail** — Settings → Accounts → Edit → *Test connection*. For OAuth
accounts, disconnect/reconnect (Connect button) to refresh tokens. Sync errors appear in the
server console and Settings → Logs (kind: sync).

**Mail is not being classified** — check Settings → Logs (kind: classify). Rules only apply to
Inbox/Archive mail. Re-run everything with Settings → Rules → *Re-run rules on existing mail*.

**AI never runs** — Settings → AI: the *Classify* task must be enabled and mapped to a provider,
and the provider must pass *Test*. AI-routed mail without a working provider waits in Review.

**Retention deleted nothing** — it starts in dry run. Settings → Import & Retention: read the
dry-run log lines first, then untick dry run. The sweep runs hourly; *Run sweep now* forces it.

**Something was trashed that shouldn't be** — open Trash, move the message back: it is
permanently protected from the sweep afterwards. Give its label `keep` retention or add a
processor note so the sender is handled correctly next time.

**Safe delete refuses messages** — each message must have a checksum-verified archive copy.
Failures are logged as `safe_delete` warnings; the origin copy is left untouched.

**Phone cannot connect** — the facade ports (IMAP/SMTP shown in Settings → Devices) must be
reachable from the phone; over the internet put a TLS proxy in front or set
`FACADE_TLS_KEY`/`FACADE_TLS_CERT`. Username is your login email, password an app password.

**"no refresh token returned" when connecting Google** — remove Seamless from
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) and connect again
(Google only issues the refresh token on the first consent).

**Logs grow forever** — they auto-clear after the period in Settings → Import & Retention
(default 90 days), or Clear logs manually in Settings → Logs.
