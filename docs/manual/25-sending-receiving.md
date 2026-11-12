# Sending & receiving mail

## Does Seamless run its own mail server?

**No.** Seamless is a mail *client* that lives on your server. It does not accept mail from the internet on port 25 and
it has no MX record of its own. That means:

- **Receiving** works by Seamless *collecting* mail from somewhere that already receives it: an IMAP mailbox (Gmail,
  Microsoft, Fastmail, MXroute, Stalwart, your host), a POP3 mailbox, or mail **pushed** to Seamless by a Cloudflare Email
  Worker for your own domain.
- **Sending** works by handing the message to an outgoing server: the mailbox's own SMTP server, an SMTP relay, or an API
  provider (SendGrid, Brevo, Amazon SES, Mailgun, Postmark).
- The IMAP/SMTP/CardDAV ports Seamless offers ([Devices & contacts](08-devices-contacts.md)) are for **your own phone
  and desktop mail apps** to talk to Seamless. They are not for the public internet and do not receive outside mail.
- You cannot point a domain's MX record straight at Seamless. To receive a domain's mail you need one of: a mailbox
  provider (e.g. [MXroute](24-mxroute.md)), Cloudflare Email Routing + the Worker (below), or a mail server you run
  yourself (such as Stalwart) which Seamless then reads over IMAP.

DNS (MX, SPF, DKIM, DMARC) always belongs to whoever receives or sends the mail. Seamless never changes your DNS; its
**Check DNS** button only reads it ([Accounts & providers](05-accounts-providers.md)).

## Recipe 1 — Gmail or Microsoft account

1. **Settings → Mailboxes → Add mailbox.** The wizard has seven steps: Address, Provider, Incoming, Outgoing, Test,
   Categories, Identity. Move with **Next** and **Back**.
2. *Address:* type the address and pick a colour, then **Next**. The provider is detected from the address.
3. *Provider:* choose **Gmail / Google Workspace** or **Outlook / Microsoft 365**.
4. *Incoming:* press **Connect Gmail** or **Connect Microsoft / Outlook** and approve access in the window that opens.
   (The first time on a new server an admin must enter the Google/Azure app credentials in the same box.)
5. *Test:* **Test incoming** and **Test outgoing** should both go green.
6. Press **Add mailbox**. For Gmail leave **Save a copy in this mailbox's Sent folder** off — Gmail does it itself.

## Recipe 2 — Any IMAP mailbox (Fastmail, iCloud, your host…)

1. **Settings → Mailboxes → Add mailbox**, enter the address, **Next**.
2. *Provider:* click your provider's card, or **Other (IMAP/SMTP)** to type the servers yourself.
3. *Incoming:* keep **IMAP** and fill **IMAP server**, **Port** (usually 993), **Security** (SSL/TLS), **Username** and
   **Password**. iCloud, Yahoo and Gmail-with-2FA need an *app-specific password*.
4. *Outgoing:* fill **SMTP server**, **Port** (465 with SSL/TLS, or 587 with STARTTLS) and **Security**. Keep **Same
   username and password as incoming** ticked unless your provider uses different ones.
5. *Test:* press **Test incoming** and **Test outgoing**; tick *Also send a test message* to prove sending.
6. Press **Add mailbox**. Mail starts arriving within a minute.

## Recipe 3 — A generic SMTP relay for sending

Use this when the mailbox's own SMTP is limited, or you want several mailboxes to send through one service.

1. **Settings → Sending → Add provider.**
2. **Type:** *SMTP relay*. Pick a **Preset** (Gmail, Outlook / 365, iCloud, Zoho, Fastmail, Brevo SMTP, SendGrid SMTP,
   Amazon SES SMTP, Mailgun SMTP) or *Custom* and fill **Host**, **Port**, **User name**, **Password**; tick **Use TLS
   from the start (port 465)** for port 465.
3. Give it a **Name**, then **Save**, then press **Test** next to it.
4. **Settings → Mailboxes →** edit the mailbox → **Send through** → choose the provider → **Save changes**.

## Recipe 4 — SendGrid, Brevo, Amazon SES, Mailgun, Postmark

Same pattern as Recipe 3 but with the provider's own **Type** in step 2:

| Type | What you enter | Where you get it |
|---|---|---|
| SendGrid | **API key** (needs the "Mail Send" permission) | SendGrid → Settings → API Keys |
| Brevo | **API key** | Brevo → SMTP & API |
| Amazon SES | **Region**, **Access key ID**, **Secret access key**, optional **Configuration set** | AWS IAM user allowed `ses:SendEmail` |
| Mailgun | **API key**, **Sending domain**, **Region** (US/EU) | Mailgun → Sending → Domains |
| Postmark | **Server token**, **Message stream** (default `outbound`) | Postmark → your server → API Tokens |

Then **Test** (it checks the key without sending), **Check DNS** on the provider (type your domain; SPF/DKIM/DMARC
should be green), and set the mailbox's **Send through** as above. The From address or its domain must be verified at the
provider. Optionally choose a fallback provider under **If this fails (rate limit, outage), try**.

## Recipe 5 — Your own domain via Cloudflare Email Routing (push)

For receiving a domain whose DNS is on Cloudflare, with no mail server.

1. **Settings → Mailboxes → Own domain (Cloudflare Email Routing).**
2. Enter a **Name**, the main address, the domain(s), and the transport to send with (Recipe 3 or 4 first).
3. Copy the **endpoint, token and secret** shown — the secret appears once.
4. Follow the on-screen steps to deploy the Worker (`workers/inbound/` in the repo) and set Cloudflare's catch-all
   rule to *Send to a Worker*.
5. Press **Send test**, then send a real email to an address at the domain.

Needs your Seamless to be reachable from the internet at its public address. Full detail: [Accounts & providers](05-accounts-providers.md).

## Recipe 6 — POP3

**Settings → Mailboxes → Add mailbox → POP3** and fill server, port, security, username, password. POP3 has no folders
on the server, so Inbox/Sent/Trash exist only inside Seamless. See [Accounts & providers](05-accounts-providers.md).

## Everyday checks

- Send a message to yourself and right-click the message and choose **View original**: look for `spf=pass`, `dkim=pass`, `dmarc=pass`.
- **Settings → Health → Sending** shows failures in the last 24 hours.
- A message that can't be delivered comes back as a **Not delivered** banner ([Bounces](05-accounts-providers.md)).

## Limits & gotchas

- No outside server can deliver mail "to Seamless" directly. Only the Cloudflare push route does anything like it.
- Sending quota limits belong to your provider; Seamless's **Daily limit** field is stored but not enforced.
- A wrong password fails at the *Sign in* step of the test, and the Health page turns the mailbox red.
