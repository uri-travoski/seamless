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
See *Mail to an address you have not created* above. The policy used to be settable only through the API (`PUT /api/push-inboxes/<token>`); it now has a screen, and `reject` is shown as *Drop it*.
