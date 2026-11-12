# Critical alerts — be told when a mailbox stops working

A mailbox can quietly stop receiving mail: a password changed, a sign-in was revoked, the server is unreachable, storage is full.
Seamless watches for this and sends a **critical alert** — to your phone, Telegram or an outside email address, and in the app as a
**red, pinned** notification.

Open **Settings > Alerts** (under *Security*). Search for "alert", "sms", "twilio" or "telegram" in Settings search to find it.

## You must set up at least one channel

When a new installation is set up, the wizard has a step called **Alerts** after you create the administrator account. It cannot be
skipped until you have added one channel **and its test message arrived**. You can add more later.

Why it matters: if the only way you hear about a broken mailbox is an email, the broken mailbox may be the thing that stops the email.

On an existing installation, a red banner reads "No alert channel set up — you will not be told if a mailbox stops working" until a
channel passes its test. The same banner is shown on the **Health** page.

A channel counts as **set up** only after you press **Send test** (or **Save and send test**) and the message was accepted. If you change
its settings, it has to be tested again.

## What triggers an alert

| Problem | When |
|---|---|
| Mailbox stopped working | The mailbox fails to sync 3 times in a row, or has had no successful sync for 15 minutes while failing |
| Sign-in revoked or expired | A Gmail/Microsoft mailbox's sign-in no longer works — reconnect it in Settings > Mailboxes |
| Sending keeps failing | 3 or more messages failed to send within an hour |
| Mail storage unreachable | The storage bucket does not answer (administrators) |
| Backups failing or overdue | The last backup failed, or none has completed for too long (administrators) |
| Storage almost full | A user reaches 95 % of their storage limit (that user and the administrators) |
| Cloudflare inbox silent | A push inbox that normally receives mail has had nothing for 48 hours |

The numbers can be changed (by an administrator) in **Settings > Alerts > When to alert**. Mailboxes you set to "ignore" in Health never alert.
Alerts about a **shared mailbox** go to its owner and its managers; a channel an administrator marks "for the whole team" also hears about
shared mailboxes and server problems.

## What you receive

* **One message** when the problem starts, on every channel that is set up. If one channel is down the others still get it, and the
  failed one is retried a few times with growing gaps.
* A **reminder** every 6 hours (changeable; 0 = never) while the problem is still there and you have not marked the alert read.
* A one-line **"Fixed: …"** message when the problem goes away by itself.
* Quiet hours do **not** apply to critical alerts.

## Red and pinned in the app

* Critical alerts are **red** (in every theme, light and dark) and sit **above** ordinary notifications in the bell and on the Notifications page.
* A red **"N critical"** pill appears in the top bar while any alert is unread. Click it to see them.
* An alert stays until the problem is **fixed** *and* you have read it. When the problem fixes itself, the alert stays, marked **Fixed**, until you press **Mark read**.
  You can also press **Mark read** on a problem that is still open; reminders stop, and it is still tracked.
* **Mark all read** on the notifications page does **not** touch alerts: each one has its own **Mark read** button.
* Click an alert to go to the mailbox's Health page.

## Setting up each channel

### Telegram (free, quick)

1. In Telegram, chat with **@BotFather** and send `/newbot`. Choose a name; BotFather replies with a **token** like `123456789:AA…`.
2. Open a chat with your new bot and send it any message (for example "hi").
3. In Seamless: **Add a channel > Telegram**, paste the token, press **Find my chat** and choose your chat (or type the chat id).
4. **Save and send test**. A message should arrive in Telegram.

For a group: add the bot to the group, send a message there, then use **Find my chat**.

### SMS via Twilio

1. Create an account at twilio.com and get a phone number that can send SMS to your country (Console > Phone Numbers).
2. From the console home page copy the **Account SID** (starts with `AC`) and the **Auth Token**.
3. In Seamless: **Add a channel > SMS via Twilio**, enter the SID, token, your Twilio number as **From** (like `+15551234567`) — or a **Messaging Service SID** — and your own mobile as **Send to** in international format.
4. **Save and send test**.

*Trial accounts:* Twilio only lets a trial account text numbers you have **verified** in the console (Phone Numbers > Verified Caller IDs), and adds
"Sent from your Twilio trial account" to each message. Upgrade the account to remove both limits. Some countries need a registered sender id or number; Twilio's console tells you.

### SMS from your own phone (phone as the SMS server)

An Android phone with a SIM runs a small app that sends SMS when it receives a web request. Seamless calls it.

1. Install an SMS-gateway app on the phone. Presets are provided for **SMS Gateway for Android** (turn on its *Local server*; it shows an address like `http://192.168.1.50:8080` and a username and password) and for gateways that take a simple `POST /message` with a token or a form. *(The presets follow each app's documentation but have not been checked against the live apps — if the test fails, switch to "Custom" and edit the body template.)*
2. **The phone and the Seamless server must be able to reach each other**: same home/office network, a VPN such as Tailscale/WireGuard, or a tunnel.
3. In Seamless: **Add a channel > SMS via my phone**. Pick the preset, enter the address (including the path, e.g. `http://192.168.1.50:8080/message`), the username/password or token, and your number.
4. **Seamless refuses private addresses by default** (to stop it being used to probe your network). The first test will say so and offer **Allow 192.168.1.50** — an administrator presses it (it adds the phone to the allow-list in Settings > Integrations). Then test again.
5. The body template uses `{{to}}` for the number and `{{message}}` for the alert text.

### Email to an outside address

1. **Add a channel > Email** and type an address on another provider, one you read on your phone.
2. The message is sent through one of your **other, healthy** mailboxes — never the one that is failing. If every mailbox is failing, the email is skipped and the other channels carry the alert.
3. Email alerts are switched off on a Viewing-mode copy (it sends no mail); the other channels still work.

## Testing

* **Send test** on a channel sends one message to just that channel.
* **Send test alert** raises a pretend alert that goes through the whole path — red notification, every channel — and then counts as fixed.
* **Recent alerts** at the bottom of the page lists what was raised and how each channel's delivery went.

## Privacy

Tokens and passwords are stored encrypted and are never shown again; leave a secret field blank when editing to keep the saved one.
Alert messages contain the mailbox address and the type of problem, not mail content.
