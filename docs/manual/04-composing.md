# Composing & sending

Click **Compose** (or **Reply** / **Forward** on an open message). Compose windows dock in the corner so you can write several at once; use the header buttons to **minimize**, **maximize** to a full popup, or close (closing saves a draft).

## From, recipients, subject

- **From** — pick which account and identity to send as. If the account has **aliases**, they appear here too.
- When you **reply**, Seamless automatically picks the identity the message was delivered to (Delivered-To, then To/Cc), so you answer from the right address.
- **To / Cc / Bcc** — start typing to autocomplete from your addressbook (ranked by how often and how recently you have contacted someone). Click **Cc / Bcc** to reveal those fields.

## The editor

The formatting toolbar offers **bold**, **italic**, **underline**, **strikethrough**, text **color**, **highlight**, **bullet** and **numbered** lists, **alignment**, **links**, **inline images**, and **clear formatting**, plus **undo / redo**.

## Attachments

Attach files with the paperclip button, or **drag and drop** them onto the compose window. Attachments are listed with their size; remove one with its **×**.

## Send, or send later

- **Send** delivers immediately.
- The **caret** next to Send opens **Send later**: quick choices (in 1 hour, this evening, tomorrow morning, Monday) or a custom date/time. Scheduled mail waits under **Scheduled** and can be edited or cancelled until it fires.

## Undo send

After you press **Send**, the message is held for a few seconds (10 by default) and a bar at the bottom shows
**Sending in 10s… Undo**. Press **Undo** and the compose window comes back with everything as you left it —
recipients, text and attachments. Once the time is up the message goes out and can't be recalled.

Change the delay (Off, 5, 10, 20 or 30 seconds) in **Settings > General > Sending and snoozing**. Scheduled
(send-later) messages aren't delayed. If the server restarts while a message is being held, it is still sent once.

## Track opens

The **eye** on the formatting toolbar turns open tracking on or off for this message (filled = on). It's on by default; change the default in **Settings > General**. Drafts and scheduled mail remember the setting.

- Opens show as **👁 N** on your sent mail. Click it (or the notification) for the **open report**: total and real opens, first and last open, devices, a timeline, and every open with time (Perth), client and IP.
- Apple Mail Privacy Protection, Gmail's image proxy and corporate scanners fetch the pixel without a person reading it. Those are marked **automatic** and left out of the real-open count.
- **Track each recipient separately** (in the ⋮ menu by the Send button) sends every recipient their own copy with its own pixel, so the report shows *who* opened. Everyone still sees the full To/Cc.
- Mail to your own mailboxes is never tracked, nor mail to domains on your **never track** list (Settings > General).
- Many mail clients block images, so a tracked message may never register an open. Check Australian privacy and spam rules before tracking customers.

## Templates

**Templates** in the sidebar lists your templates by category. **Use** starts a new message from one; the toolbar's template button inserts one at the cursor; or type its **;shortcut** (e.g. `;quote`) followed by a space. **Save as template** is in the ⋮ menu by the Send button.

Placeholders fill themselves in: `{{recipient.first_name}}`, `{{recipient.name}}`, `{{recipient.email}}`, `{{sender.name}}`, `{{sender.business}}`, `{{date}}`, `{{date+7d}}` (any number of d/w/m/y), `{{subject}}`. Recipient placeholders wait until you send if the To field is still empty. `{{?Question}}` asks you when the template is inserted — e.g. `{{?Quote amount}}`.

## AI draft

When replying, **AI draft** writes a first draft of the reply for you (requires an AI *draft* provider under Settings > AI). Edit it before sending.

## Drafts

Closing a compose window with content saves a **draft** automatically; find it under **Drafts** and pick up where you left off.
