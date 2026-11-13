# Disposable addresses

A disposable address is an alias on **your own domain**. Give each sign-up its own one; if it starts getting junk you can
stop it without touching your real address. Mail reaches Seamless by one of two routes (you can use both, on different domains):

| Route | How it works | Set up in |
| --- | --- | --- |
| **Catch-all mailbox** | Your email provider (MXroute, Migadu, Fastmail, cPanel/DirectAdmin…) delivers *every* address of the domain into one mailbox. Seamless reads that mailbox by IMAP (new mail arrives at once) or POP3 (checked every 2 minutes) and routes each message. | Settings → Disposable → **Add a catch-all domain** |
| **Cloudflare route** | Cloudflare Email Routing hands each message to a small Worker that posts it to Seamless. See [Accounts & providers](05-accounts-providers.md). | Settings → Mailboxes → *Own domain (Cloudflare Email Routing)* |

## Set up a catch-all mailbox, step by step
1. **At your provider**, add the domain and make its catch-all (also called default address, wildcard alias or “*@domain”)
   deliver to **one dedicated mailbox**. Point the domain's MX records at the provider. Use a mailbox that holds nothing
   else: Seamless takes it over and no longer lists it as a normal mailbox.
2. In Seamless add that mailbox in **Settings → Mailboxes** (IMAP, or POP3 if IMAP is not offered) and run its connection test.
3. **Settings → Disposable → + Add a catch-all domain.** Pick your provider (the screen shows its steps), the mailbox, the
   domain, and what to do with each message after it is saved:
   - **Move it to “Seamless processed”** (IMAP only, the default; the folder is cleaned after 14 days — change it on the mailbox card),
   - **Leave it** on the provider, or
   - **Delete it** from the provider (POP3: leave or delete).
   Seamless only moves or deletes the provider's copy after the message is stored and checked; if anything fails the copy stays and is tried again.
4. Press **Send a test mail**. Seamless sends a mail from one of your other mailboxes to a random address on the domain
   (`seamless-test-…@yourdomain`) and tells you when it came through the catch-all. Nothing from the test is stored.
5. Create addresses as below. A health line on the mailbox card shows the last check; if the mailbox stops syncing you get the usual
   *mailbox is not syncing* alert (see [Health and alerts](28-setup-recipes.md)).

How Seamless finds the address a message was sent to: it reads `Delivered-To`, `X-Original-To`, `Envelope-To` and `X-Envelope-To`
(in that order), then the To and Cc lines. The first address that is one of your disposable addresses, or is on a catch-all domain, wins.
That works for Bcc, mailing-list mail and forwarded mail.

## Mail to an address you have not created
Each domain has a policy (Settings → Disposable → *Where disposable mail arrives*; it applies to the Cloudflare route too):
- **Keep out of sight for a week** (default for a catch-all domain): the message is held under *Unknown addresses*. **Create this address**
  turns it into a real disposable address and delivers what was held; **Block** drops everything sent to it. Held mail is discarded after 7 days.
- **Deliver to the Inbox**: it arrives like any other mail (the default for the Cloudflare route, as before).
- **Drop it**: discarded; nothing is stored.

## Create one
- **Settings → Disposable → + New address**, or **Disposable addresses… + New address** at the bottom of the top-right mailbox switcher.
- Pick the domain, a style (random `k7f2q9`, two words `quiet.river`, or your own prefix `bunnings.x7`), a label, and an expiry
  (1 day / 7 days / 30 days / never). The address is copied for you.
- Disposable addresses are for **receiving only**. There is no "send from a disposable address" any more (see *Replying*).

## What happens to mail
| Status | Mail sent to it |
| --- | --- |
| Active | Delivered to the Inbox with a chip showing the label; counted. You get a "mail to a disposable address" notification (switch it off per type in Settings → Notifications). **Deleted after a week** unless you keep it (below). |
| Stopped | Goes to the **Bin**, marked read, with no notification and no Inbox entry — but only while **both** limits hold: fewer than **100** mails stored and less than **15 days** since you pressed Stop. Whichever comes first ends it; from then on mail is **deleted on arrival** (nothing stored, nothing counted, nothing logged). Bin mail is emptied by the normal [Trash retention](27-trash-retention.md). |

Stop and Start replace the old Pause, Resume, Dispose and Undo. **Start** delivers to the Inbox again but does not bring old Bin mail back by
itself (restore it from the Bin if you want it). **Stop** again later begins a fresh 15 days and a fresh 100. If the domain is on the Cloudflare route
you can tick **Reject at the door** (Settings → Disposable → *Where disposable mail arrives*): the Worker then refuses mail to a stopped address at SMTP
time and nothing is stored at all (off by default).

Find an address's mail with the search `disposable:<address or part of it>` (or `disposable:<id>`; the **Mail** button in the table), all of it with
`is:disposable`, and mail that came to a stopped address with `is:stopped`.

## Stop and Start
- In the reading pane, next to the address chip: **Stop this address** (an *Undo* toast starts it again). A stopped address shows **Start**.
- Right-click a message in the list (or ⋮ → More): **Stop this address**.
- **Settings → Disposable**: a Stop / Start button per row; tick several rows to stop or start in bulk. An address with an expiry is stopped automatically
  when the time comes.

## The one-week rule and Keep
Every message that arrives on an active disposable address is **deleted after 7 days** (change it in Settings → Disposable, 1–90 days): the daily
sweep moves it to the Bin, and the Bin empties as usual. The message shows **Deleted in 3 days** with a **Keep** button, in the reading pane and in the
list row; right-click → **Keep** works too. **Keep** protects that one message for good. **Keep all from this address** (reading pane, or the table) keeps everything
already received and everything that arrives later. This rule is not affected by *Dry run* in the Trash settings. There is no digest or reminder
email about expiring mail — only the countdown on the message.

## Automatic cleanup
There is no "Delete address" button. Addresses that have been **stopped for more than 6 months** (183 days; change it or enter 0 for never) are removed
automatically, together with the mail of theirs that is still in the Bin and their leak-alert state. If mail arrives for a deleted address later, it is
handled as an unknown address (see below). Settings → Disposable shows this rule in one line.

## Leak alerts
The first sender's domain is remembered as the one you signed up with. When mail arrives from a **different** company's domain you get
a "may have been leaked" notification, once per domain. The table shows ⚠ next to such addresses. Leak alerts only read incoming mail, so they are unaffected by Stop.

## Replying
Seamless never sends *from* a disposable address. If you reply to mail that arrived on one, the reply uses your normal identity (your default mailbox) and a one-line
warning shows above the message: "This reply will come from <your address>, not the disposable one". Use the From picker if you want a different identity.
Stop, Start, Keep and Block are written to the [audit log](22-audit-log.md).

## Unknown addresses
See *Mail to an address you have not created* above. The policy used to be settable only through the API (`PUT /api/push-inboxes/<token>`); it now has a screen, and `reject` is shown as *Drop it*.
