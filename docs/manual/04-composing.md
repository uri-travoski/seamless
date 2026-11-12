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

## Follow-up reminders

Ask to be told if nobody answers.

- **While writing:** the **⋮** menu in the compose window > **Remind me if no reply…** > 1, 2, 3 days, 1 week or your own
  number of days. A small "Remind in 2d" tag shows in the footer.
- **On something you already sent:** open the message in **Sent** (or right-click it) > **Follow up…**.
- When the time comes: if someone you wrote to has replied, nothing happens. Otherwise you get a **No reply from Bob**
  notification (or "Opened 3× but no reply from Bob" if you tracked it). The sent message shows a banner with
  **Follow up now** (opens a reply) and **Remind me again**.
- **Waiting for reply** (the **Waiting for reply** smart view in the filter row above the message list) lists every sent message that still has a reminder.
- Only a reply from one of the people you wrote to counts — a reply from someone else doesn't. **Cancel reminder** is in the
  banner and the right-click menu.

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

### More variables

`{{original.subject}}`, `{{original.date}}` (the message you are replying to), `{{today}}`, `{{sender.first_name}}`, `{{business.name}}` (also `.short_name .phone .website .abn .address`) and `{{identity.name}}` / `{{identity.email}}` come from the From identity. When you reply through a quick reply, `{{recipient.*}}` is the person you are answering. A variable Seamless doesn't know stays visible and highlighted so you notice it.

## Quick replies

Pin a template (Templates → edit → **Pin as a quick reply**) and it appears as a chip under the message you are reading — up to five, in your pin order, only those for the business of the identity you would reply from (or with no business set). Click a chip to open a reply with the template filled in.

- **Safe to send directly** turns the chip into a one-click send through the normal undo-send countdown. It only sends when the template has no AI parts and every variable filled in; the server checks this again.
- **`{{ai: "write two friendly sentences about the timing"}}`** asks your AI *draft* provider (Settings → AI) to write that part from the conversation (one call per placeholder, 20 s limit). The result is highlighted so you can review it. A template with AI parts can **never** be sent directly. With no AI provider, or if the call fails, the placeholder is left highlighted for you to fill in.
- **Kind: marketing** adds an unsubscribe line (`{{unsubscribe}}` where you put it, otherwise at the end): a link that emails the sending identity with the subject "unsubscribe". You handle those replies yourself — there is no automatic list management.
- Each use counts towards the template's usage and "last used".

## AI draft

When replying, **AI draft** writes a first draft of the reply for you (requires an AI *draft* provider under Settings > AI). Edit it before sending.

## Drafts

Closing a compose window with content saves a **draft** automatically; find it under **Drafts** and pick up where you left off.
