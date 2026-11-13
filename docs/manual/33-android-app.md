# Seamless for Android

A small Android app for your Seamless server. It looks and feels like the Gmail app, but it works with all your mailboxes at once and with the same email address and password you use on the web. Everything (mail, labels, mailbox groups, settings) comes from the server after you sign in; the only thing the app asks for is the server address.

> The app is being built step by step. This page describes the server side that is ready now (sign-in, phones list, push) and what the app does; screens are added as they land. Right now the app can connect to your server and sign in; the mailbox itself arrives in the next updates.

## Install

1. Get the APK file from your administrator (or build it from the `mobile/` folder of the project).
2. Copy it to your phone and open it. Android asks once to allow installing from that source.
3. Open **Seamless** and type the server address, for example `https://mail.example.com`. A server on your home network can use `http://192.168.x.x:4900`; anywhere else the address must start with `https://`.

## Signing in

On first launch type the server address and press **Check**: the app shows the server's name and version so you know it is the right one. Then use your Seamless email and password. A wrong password or an unreachable server gives a plain-words message. Open the menu (top left) and choose **Log out** to sign the phone out. If you turned on two-factor sign-in you are asked for the 6-digit code (or a recovery code) too. The phone stays signed in for **90 days after you last used it** — every time you open the app the clock restarts.

Your phone shows up in **Settings → Security → Where you're signed in** as *Seamless for Android — your phone's name*. Press **Sign out** there and the phone is signed out immediately (the app returns to its sign-in screen and stops getting notifications). Signing out inside the app does the same.

## The mailbox selector

At the top right the app has a **mailbox selector** instead of an account picker. Choose **All mailboxes (Unified)**, one of your **categories** (Work, Personal, Disposable… the same ones as the web switcher) or a single mailbox. The choice filters the list, search, counts and the "From" address when you write a message.

## Notifications

- **New mail** — one notification per message, grouped per mailbox. It follows the same rules as the web app: Settings → Notifications, VIPs, quiet hours and muted mailboxes.
- **Critical alerts** — when a mailbox stops working you get a red, high-priority notification on its own channel, even if you turned new-mail notifications off. See [Critical alerts](31-alerts.md).
- **Hide message content** (in the app's notification settings) shows only "New mail" instead of the sender and subject. The server then never sends the text to Google's push service at all.
- Viewing mode sends no mail notifications, because no mail is received. See [Viewing old mail](30-viewing-old-mail.md).

If the administrator has not set up push (below), the app checks for new mail about every 15 minutes instead, and shows the same notifications. Settings → Notifications → **Check now** looks straight away.

Each mail notification shows the sender, subject and the start of the message, with the mailbox name, and has **Mark as read**, **Archive**, **Delete** and **Reply** buttons. Tapping it opens the conversation; a critical alert opens the alert details. Swiping a notification away only hides it — the message stays unread. When you read a message on another device (or the web), its notification disappears from the phone.

The first time you sign in, the app explains why it wants to notify you and then asks Android for permission (Android 13 and later). If you said no, Settings → Notifications shows a line that opens Android's settings. Android also lists three notification channels (New mail, Critical alerts, Background sync) where you can change sound and vibration. A "Compose" shortcut is available by long-pressing the app icon.

## Setting up push (administrator, once)

Push goes through Google's Firebase Cloud Messaging. It is free and needs a Google account. Seamless sends only a few words (sender, subject, a 100-character preview) — or nothing but "New mail" if the phone's owner chose to hide content.

1. Open the Firebase console (console.firebase.google.com) and **Add project**. You can turn Google Analytics off.
2. In the project, **Add app → Android**. The package name is `au.sam.seamless`. Download **google-services.json** and put it in `mobile/app/` before building the app (the app builds fine without it, but then it can only poll).
3. Open **Project settings → Service accounts** and press **Generate new private key**. A `.json` file downloads.
4. In Seamless go to **Settings → Integrations → Mobile push (Firebase)**, paste the whole contents of that file and press **Save key**. Seamless stores it encrypted and never shows it again.
5. Sign in on the phone, then press **Send test push to my phone**. A "Test push from Seamless" notification should arrive within a few seconds.

To turn push off, press **Turn off** in the same place.

## The mailbox on the phone

- **Top bar:** the menu button, a **Search mail** pill, and a round button at the right showing the mailbox you are looking at. Tap it to choose **All mailboxes**, a **category**, or one **mailbox**. Unread counts are shown, and a red dot marks a mailbox that has a sync problem. The phone remembers your choice.
- **Chips** under the bar: All, Unread, Attachments, plus your pinned smart views.
- **The list:** unread mail is bold; you see the sender, subject, a preview, the time, the star, a paperclip for attachments and your labels. When the list mixes mailboxes, a small coloured dot shows which one a message came to. Pull down to refresh; more mail loads as you scroll (50 at a time).
- **Swipe** a row right to archive it, left to delete it. A bar at the bottom offers **Undo**.
- **Long-press** a row to select several. The top bar then offers Archive, Delete, Mark read/unread, and a menu with Label, Snooze, Move and Select all.
- **Search:** tap the pill. You get recent searches, suggestions from your contacts and labels, and the same operators as the web app (`from:`, `has:attachment`, `label:` and so on). The tune button opens **Search options** (from, to, subject, words, size, dates). The number of results is shown above the list.
- **Banners:** a red banner appears at the top when a critical alert is open; tap it for details and a **Fix it** link. A grey notice appears when the server is in Viewing mode.

Opening a message arrives in a later update.

## Reading a conversation

Tap a message to open it. The subject sits at the top with its label chips (tap a chip to see that label). Older read messages are collapsed to one line; the newest and any unread ones are open. Tap the sender row to collapse or expand, and "to me ⌄" for the full From / To / Date.

- **Toolbar:** archive, delete, mark unread, labels (tick or untick labels, or type a new one and tap Create), snooze, and ⋮ for Move and Report spam. The star is on each message.
- **Pictures:** remote images are hidden. "Show images" loads them for this message; "Always from this sender" remembers the sender on this phone only. Inline pictures in the message always show.
- **Links:** tapping a link first shows the real address. Open it or Cancel. Links to files on the phone and other unusual kinds are blocked. JavaScript never runs in messages.
- **Zoom:** pinch to zoom; text reflows to the screen width. Dark mode follows the app theme.
- **Attachments:** tap one to "Save to…" (you choose where, no storage permission needed) or "Open with…".
- **Invitations:** a card with Accept / Maybe / Decline, as in the web app.
- **Warnings and badges:** the phishing warning from the server, and read-only OpenPGP / S-MIME badges.
- **"Filed by AI · why?"** shows how the message was filed; "Wrong? Fix it" lets you pick the right label (Undo is offered).
- A message is marked read about 1.5 seconds after you open it. Reply, Reply all and Forward are at the bottom (writing mail arrives in the next app update; they are off in Viewing mode).

## Troubleshooting

- **"Mobile push is not set up yet"** when pressing the test button — the key has not been saved (step 4).
- **"No phone is registered"** — sign in on the phone first; it registers itself after signing in and after allowing notifications.
- **Test push says Google did not accept it** — the key belongs to a different Firebase project than the one in the app's `google-services.json`, or the key was deleted in Firebase. Generate a new one and save it again.
- **Notifications stopped after a phone reset** — sign in again; the old registration is cleaned up automatically when Google reports the phone as gone.
- **The app says it was signed out** — someone pressed Sign out for that phone in Settings → Security, an administrator disabled the account, or the phone was not used for 90 days.

## The menu (drawer)

Open it with the menu button or by swiping from the left edge. It shows, top to bottom:

- **Your name and the server** you are signed in to.
- **Folders** in the same order as the web app's sidebar (Inbox, Starred, Drafts, Scheduled, Snoozed, Sent, Spam, Archive, Bin), with the unread count for Inbox and Spam. Change the order in the web app (drag folders in the sidebar) and the phone follows. Templates are edited in the web app only.
- **Labels**, with a colour square, name and unread count. Labels inside other labels are indented. Tap one to see its mail. Labels you hid in the web sidebar stay hidden.
- **Smart views** – your saved searches such as *Waiting for reply*.
- **Settings**, **Help** and **Log out**.

### Labels

**Manage labels** lists every label. Tap one to rename it, pick another colour or move it inside another label; tap the bin to delete it (the messages stay, only the label is removed). **New label** makes one. These are the same labels as on the web: a change on the phone shows up there and the other way round. Labels other people shared with you are listed too, read-only.

When someone shares labels from their mailbox with you, a banner appears above the list: **Accept**, **Reject** or **Decide later**.

## Writing mail

Tap **Compose** on the list (it is greyed out, with a note, when the server is in Viewing mode). The message opens full screen:

- **From** starts as your default address, or the mailbox you are looking at; tap it to pick another of your addresses. The identity's signature is added when you send.
- **To / Cc / Bcc** become chips as you type a comma, press next, or tap a suggestion from your contacts. Tap the arrow to show Cc and Bcc.
- The body is plain text with a small toolbar: **bold** (`**text**`), _italic_ (`_text_`) and bullet lists (`- item`); they are sent as formatted HTML.
- **Attach** (paperclip) opens Android's file picker; files over the server's limit are refused with a message. **Schedule** (clock) sends at a date and time you choose.
- **Send** holds the message for your undo-send delay. A bar shows "Sending… 8s" with **Undo**; Undo brings the message back into the editor.
- Leaving with writing in progress asks **Save draft / Discard / Keep editing**. Drafts are also saved automatically when you leave the app or pause for a while, and open again when you tap them in Drafts.
- **Reply, Reply all and Forward** (bar under a conversation) fill in the recipients, subject and quoted text, and reply from the address the message was sent to.
- With no connection, Send shows "No connection" and keeps your message; nothing is queued behind your back.

Other apps can open Seamless too: tapping an email address (`mailto:` link) or **Share → Seamless** starts a new message with the address, subject, text or files filled in.

## Settings on the phone

- **Notifications:** new mail on/off, critical alerts on/off, hide message content, a switch per mailbox to mute it (kept on the server, so the web app agrees) and a shortcut to Android's own channel settings.
- **Swipe right / left:** archive, delete, mark read/unread, star, or nothing.
- **Conversation view**, **Default "From"** (which of your addresses new messages start from; by default the mailbox you are looking at), **Undo send delay** (the server setting, shared with the web app).
- **Signature:** shown for information; edit it in the web app.
- **Theme:** match the phone, light or dark.
- **About:** app version, server address and version, open-source licences, and **Sign out**.
