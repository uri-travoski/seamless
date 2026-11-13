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

If the administrator has not set up push (below), the app checks for new mail about every 15 minutes instead, and shows the same notifications.

## Setting up push (administrator, once)

Push goes through Google's Firebase Cloud Messaging. It is free and needs a Google account. Seamless sends only a few words (sender, subject, a 100-character preview) — or nothing but "New mail" if the phone's owner chose to hide content.

1. Open the Firebase console (console.firebase.google.com) and **Add project**. You can turn Google Analytics off.
2. In the project, **Add app → Android**. The package name is `au.sam.seamless`. Download **google-services.json** and put it in `mobile/app/` before building the app (the app builds fine without it, but then it can only poll).
3. Open **Project settings → Service accounts** and press **Generate new private key**. A `.json` file downloads.
4. In Seamless go to **Settings → Integrations → Mobile push (Firebase)**, paste the whole contents of that file and press **Save key**. Seamless stores it encrypted and never shows it again.
5. Sign in on the phone, then press **Send test push to my phone**. A "Test push from Seamless" notification should arrive within a few seconds.

To turn push off, press **Turn off** in the same place.

## Troubleshooting

- **"Mobile push is not set up yet"** when pressing the test button — the key has not been saved (step 4).
- **"No phone is registered"** — sign in on the phone first; it registers itself after signing in and after allowing notifications.
- **Test push says Google did not accept it** — the key belongs to a different Firebase project than the one in the app's `google-services.json`, or the key was deleted in Firebase. Generate a new one and save it again.
- **Notifications stopped after a phone reset** — sign in again; the old registration is cleaned up automatically when Google reports the phone as gone.
- **The app says it was signed out** — someone pressed Sign out for that phone in Settings → Security, an administrator disabled the account, or the phone was not used for 90 days.
