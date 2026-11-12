# Setup recipes, click by click

Short numbered steps for features that are described in more detail on other pages. Every menu name below is what you
will see on screen.

## Undo send
1. **Settings → General**, scroll to **Sending and snoozing**.
2. Set **Undo send** to *Hold for 5, 10, 20 or 30 seconds* (or *Off — send immediately*).
3. Write a message and press **Send**. A countdown with **Undo** appears; press it to get the message back as a draft.

Scheduled (send-later) mail is not delayed. More: [Composing & sending](04-composing.md).

## Snooze
1. Hover a message and click the **clock**, or select it and press **b**.
2. Pick *Later today*, *Tomorrow*, *Next week*… or *Pick date and time…*.
3. See what is waiting under **Snoozed** in the sidebar.
4. To stop a conversation coming back early on a reply, untick **Settings → General → Snooze: bring a conversation back
   early when someone replies**.

## Follow-up reminders
1. In a new message open the **⋮** menu → **Remind me if no reply…** → choose 1, 2, 3 days, 1 week or your own number.
2. Send. If nobody you wrote to answers, you get a **No reply from…** notification.
3. The **Waiting for reply** pill in the row above the message list lists everything still pending.

## Phishing warnings
1. Nothing to switch on — every incoming message is checked.
2. A sender you trust that keeps being flagged: **Settings → Security → Trusted senders**, type the address or domain in
   **Add an address or domain**, press **Add**.
3. On a suspicious message use **Report phishing** to move it to Spam. See [Phishing](14-phishing.md).

## Health and alerts
1. **Settings → Health** shows a green/amber/red light for each panel.
2. Choose which problems ping you under **Settings → Notifications** (they appear in the bell and, if you allow it, as
   push).
3. Optional: point an uptime monitor at `https://your-seamless-address/healthz`.
4. To silence a mailbox you don't care about, press **Ignore** on its row in Health (or tick *Ignore this mailbox in
   health checks* when editing the mailbox).

## Backups (administrators)
1. First set up a **separate** bucket: **Settings → Storage** (see [Storage](17-storage.md)).
2. **Settings → Backup**, tick **Back up automatically**, and choose **Where it goes**, **How often** and **Keep last**.
3. Tick **Email me if a backup fails** if you want it.
4. Press **Back up now** and wait for the entry to appear under **Backups in storage**.
5. Test it with a restore drill — [Backup and restore](11-backup-restore.md).

## Storage (administrators)
1. **Settings → Storage.** Pick a **Provider**, then fill **Endpoint**, **Region**, **Bucket**, **Folder (prefix)**,
   **Access key** and **Secret key**.
2. Press **Test connection** and wait for all steps to go green before saving.
3. Keep mail and backups in different buckets. See [Storage](17-storage.md).

## Businesses and identities
1. **Settings → Businesses → Add**; fill the name, **Brand colour**, **Logo**, **Default signature** and **Disclaimer**,
   then **Save**.
2. In the same page add an **Identity** (a sending address) for the business and **Save**.
3. When writing, pick the identity in **From**; the signature changes with it. See [Businesses](18-businesses.md).

## Shared inbox
1. **Settings → Mailboxes**, find the mailbox and press **Share with…**.
2. Choose the person and a role (viewer, responder or manager).
3. They see it in their mailbox switcher under **Shared**. Assign and set status from the thread — [Shared mailboxes](19-shared-inbox.md).

## Quick replies
1. **Templates** (sidebar, or **Settings → Templates**) → create or open a template.
2. Tick **Pin as a quick reply** and **Save template**.
3. Open any message: the pinned replies appear as buttons above the reply box.

## Webhooks
1. **Settings → Integrations → Add webhook**.
2. Fill **Name** and **URL**, tick the **Events** you want and (optionally) **Only mail matching** a search.
3. **Save**, then use the delivery log on that row to check it arrived. A URL on your own network must first be added to
   the **Private-network allow-list** (admin).

## API tokens
1. **Settings → Integrations → New API token**.
2. Give it a **Name**, choose **Scopes**, and optionally **Expires after (days)**.
3. Press **Create token** and copy it now — it is shown once. Press **I've saved it**.

## Audit log
1. **Settings → Audit log** lists sign-ins, setting changes and other sensitive actions.
2. Filter by date with **From / To**; an admin sets **Keep entries for** and presses **Save**.

## Encryption
1. **Settings → Encryption → Your keys**: choose the identity and press **Create key**, or **Import a key** — or, under S/MIME,
   **Import your certificate (.p12)**.
2. Add other people's keys under **Contact keys** (S/MIME: **Add a contact’s certificate**).
3. When writing, click the shield (sign) and lock (encrypt) buttons on the compose toolbar. See [Encryption](23-encryption.md).

## Newsletters and Read later
1. Open a newsletter. In the bar above it press **Keep in Inbox**, **Read later** or **Unsubscribe**.
2. Read later items skip the Inbox (there is no sidebar entry for Read later at the moment).
3. **Settings → Newsletters** controls archiving after reading, how long Read later items are kept,
   and where unsubscribed senders' mail goes. See [Trash & retention](27-trash-retention.md).
