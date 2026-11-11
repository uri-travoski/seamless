# Phishing and lookalike warnings

Seamless checks every message that arrives and warns you about the ones that look like scams. It never deletes or hides
anything by itself — it just tells you why it is suspicious.

## What you'll see

- A **shield** next to the message in the list.
- A banner above the message that lists, in plain English, what looks wrong.
- **High** warnings (red) also switch off the links in the message until you press **Enable links anyway**.
- A new-mail notification for a high-risk message reads **Possible phishing: <sender>**.

## What it looks for

| Warning | Meaning |
|---|---|
| Failed sender checks | The message failed SPF/DKIM/DMARC, so it may not really come from who it says. |
| Display-name trick | The name shows another website's address, or matches one of your contacts but the address is different. |
| Lookalike domain | The sender's domain is almost the same as yours or one you deal with (`0fficecleaners.com.au`, `pаypal.com` with a Cyrillic *a*). |
| First message about money | A stranger writing about an invoice, payment, bank or transfer. |
| Bank-detail change | Someone you don't know asking about BSB or account numbers. |
| Reply goes elsewhere | The Reply-To address is on a different domain (mailing services such as Mailchimp are ignored). |
| Risky attachment | Programs, scripts and web pages (`.exe`, `.js`, `.html`…), Office files with macros, or a zip that mentions a password. |
| Link that lies | A link whose text shows one website but goes to another. |

A single serious sign makes a **high** warning; weaker signs make a **medium** one.

## What you can do

- **Report phishing** moves the message to Spam.
- **This is safe** trusts that sender: the warning goes away and future messages from them are never flagged.
- **Settings > Security > Trusted senders** lists everyone you've trusted; you can remove them or add an address or a whole
  domain yourself.
- Search for them with `risk:high` or `risk:medium`.

Messages you sent, and drafts, are never checked.
