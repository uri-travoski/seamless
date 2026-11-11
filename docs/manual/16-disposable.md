# Disposable addresses

A disposable address is an alias on **your own domain** (a mailbox added with *Own domain (Cloudflare Email Routing)*, see
[Accounts & providers](05-accounts-providers.md)). Give each sign-up its own one; if it starts getting junk you can stop it
without touching your real address.

## Create one
- **Settings → Disposable → + New address**, or **Disposable addresses… + New address** at the bottom of the top-right mailbox switcher.
- Pick the domain, a style (random `k7f2q9`, two words `quiet.river`, or your own prefix `bunnings.x7`), a label, and an expiry
  (1 day / 7 days / 30 days / never). The address is copied for you.
- In **Compose**, *Use a disposable address* next to From creates one and sends from it.

## What happens to mail
| Status | Mail sent to it |
| --- | --- |
| Active | Delivered to the Inbox with a chip showing the label; counted. You get a "mail to a disposable address" notification (switch it off per type in Settings → Notifications). |
| Paused | Stored, marked read and filed in Archive. No notification. *Resume* turns delivery back on. |
| Disposed | Dropped (the Cloudflare Worker refuses it at SMTP time; Seamless also drops it on arrival). Only a counter is kept. |

Find an address's mail with the search `disposable:<id>` (the **Mail** button in the table), or all of it with `is:disposable`.

## Dispose and undo
Open a message that came in on a disposable address and press **Dispose** next to its chip. An *Undo* toast appears, and you can
restore the address from the table for **30 days**. Tick several rows to dispose, pause or resume in bulk. An address with an
expiry is disposed automatically when the time comes.

## Leak alerts
The first sender's domain is remembered as the one you signed up with. When mail arrives from a **different** company's domain you get
a "may have been leaked" notification, once per domain. The table shows ⚠ next to such addresses.

## Replying
An active disposable address is one of your From identities. Replying to mail sent to it uses the disposable address as From and
goes out through the mailbox's sending provider, so your real address is never shown.

## Unknown addresses
A catch-all domain accepts anything. The inbox's *unknown address policy* (set with `PUT /api/push-inboxes/<token>` `{ "unknownPolicy": "reject" }`; no screen yet) decides what happens to mail for an address that is
neither your mailbox nor a disposable one: `deliver` (default) or `reject` (dropped).
