# MXroute

[MXroute](https://mxroute.com) is a mail hosting service: it gives you **mailboxes on its own servers** for your own
domain. Seamless does not replace it. You connect Seamless to each MXroute mailbox as an ordinary IMAP/SMTP mailbox, and
read and send from Seamless while MXroute does the receiving and delivering.

## Before you start

You need, from your MXroute welcome email or control panel:

- your **server name**, e.g. `yourserver.mxrouting.net` (use the exact name MXroute gave you);
- the **mailbox address**, e.g. `sam@yourdomain.com`, and its **password** (create the mailbox in MXroute's control
  panel, DirectAdmin, if you haven't).

## Receive and send with one mailbox

1. **Settings → Mailboxes → Add mailbox.**
2. *Address:* type the full MXroute address (`sam@yourdomain.com`), pick a colour, **Next**.
3. *Provider:* click **Other (IMAP/SMTP)**.
4. *Incoming:* keep **IMAP** and fill in
   - **IMAP server:** your MXroute server, e.g. `yourserver.mxrouting.net`
   - **Port:** `993`  **Security:** SSL/TLS
   - **Username:** the **full address** (`sam@yourdomain.com`) — not just `sam`
   - **Password:** the mailbox password.
5. *Outgoing:* fill in
   - **SMTP server:** the same server name
   - **Port:** `465` with **Security** SSL/TLS (or `587` with STARTTLS)
   - leave **Same username and password as incoming** ticked.
6. *Test:* press **Test incoming** (every line should be green: DNS, Connect, Security (TLS), Sign in, List folders) and
   **Test outgoing**. Tick **Also send a test message to this address** to prove sending.
7. *Categories* and *Identity*: set a **Signature** if you like (and **Aliases** for other addresses that deliver into
   this mailbox). Press **Add mailbox**.

Sending uses the mailbox's own SMTP by default, so you need nothing under **Settings → Sending**. (If you would rather
send everything through one relay, add an *SMTP relay* under **Settings → Sending** and choose it under **Settings →
Mailboxes →** edit the mailbox **→ Send through**.)

## DNS — what MXroute needs and what Seamless does

Your domain's **MX, SPF and DKIM** records are given to you by MXroute (in its control panel, DirectAdmin → *Email
Manager → DKIM Keys* and the DNS instructions in your welcome email). **You add them at the company that hosts your DNS**
(Cloudflare, your registrar…). Seamless does **not** create or change DNS records and has no way to.

To check they are right:

1. **Settings → Sending**. If you don't yet have any provider listed, add the *SMTP relay* above with your MXroute
   details — **Check DNS** is a button on a provider row.
2. Press **Check DNS** on that row, type your domain (add the DKIM selector MXroute gave you under *DKIM selectors* if
   it isn't found), and press **Check**.
3. **SPF**, **DKIM** and **DMARC** should be green; **MX** is shown for information. Fix red rows at your DNS host and
   check again later — DNS changes can take a while.

## Test it

1. Compose a message to **yourself** (the MXroute address) and send.
2. It should arrive in the Inbox. Right-click it → **View original**.
3. Look in the headers for `spf=pass`, `dkim=pass` and `dmarc=pass` in the *Authentication-Results* line. A fail means
   a DNS record is missing or wrong.
4. Also send one to an address at another provider (Gmail, for instance) and confirm it lands in the Inbox, not Spam.

## Limits & gotchas

- MXroute's webmail, spam filters, forwarders and quotas are managed in **MXroute's control panel**, not in Seamless.
- Seamless collects mail over IMAP, so a blocked sender (see [Stopping unwanted senders](26-stopping-unwanted-senders.md))
  is still delivered to MXroute first and then filed by Seamless. Use MXroute's own filtering to refuse mail before
  delivery.
- Each MXroute mailbox is added separately.
- Seamless can't create mailboxes, domains or forwarders on MXroute.
- Server names, ports and the DirectAdmin menu names come from MXroute — if its instructions differ from this page,
  follow MXroute. (Not checked against a live MXroute account.)
