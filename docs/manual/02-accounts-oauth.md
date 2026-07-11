# Accounts: Gmail, Microsoft, Apple, IMAP

## Gmail / Microsoft (OAuth)

One-time setup (admin): register an OAuth app, then everyone on this instance can connect.

**Google** — [console.cloud.google.com](https://console.cloud.google.com) → create a project →
*APIs & Services → Library* → enable **Gmail API** → *Credentials → Create credentials → OAuth
client ID → Web application*. Add the redirect URI shown in Settings → Accounts → *Set up Google
app* after saving. Paste the client ID + secret into Seamless.

**Microsoft** — [portal.azure.com](https://portal.azure.com) → *App registrations → New*.
Supported account types: *any org directory + personal Microsoft accounts*. Add a **Web**
redirect URI (shown after saving in Seamless). Under *API permissions* add delegated
`IMAP.AccessAsUser.All` and `SMTP.Send`. Create a client secret; paste ID + secret into Seamless.

Then: Settings → Accounts → **Connect Gmail** / **Connect Microsoft** → approve in the popup.
Sync starts immediately; sending goes through the provider so SPF/DKIM stay intact.

## Apple / iCloud

iCloud requires an app-specific password: [appleid.apple.com](https://appleid.apple.com) →
Sign-In & Security → App-Specific Passwords. Then *Add IMAP account* with:
IMAP `imap.mail.me.com:993` TLS, SMTP `smtp.mail.me.com:587` (uncheck TLS = STARTTLS),
user = your full iCloud address, password = the app-specific password.

## Traditional IMAP

Any server works: host/port/TLS for IMAP + SMTP. *Test connection* checks both before saving.
Aliases you add are used for reply-from matching — replies automatically come from the address
the message was delivered to.

## Learn from Gmail

On a connected Gmail account, **Learn** analyses your existing labels: consistent senders become
deterministic rules, mixed senders (PayPal, Google Play) are routed to the AI, and your entire
labelled history seeds the similarity memory — so day one behaves like it already knows you.

## Safe delete

Per account (Settings → Accounts → *Safe delete*): once a message is verifiably archived
(checksum-checked copy in your storage) and older than the grace window, Seamless removes it at
the provider — freeing quota. Origin Trash mode keeps the provider's own ~30-day recovery as a
second net. The local copy is the permanent record and is never deleted by sync.
