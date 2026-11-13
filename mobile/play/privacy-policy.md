# Privacy policy — Seamless for Android

The live version is served by every Seamless server at `GET /privacy` (public). The instance owner sets the contact line with the setting `privacy_contact` (admin: `PUT /api/mobile/privacy-contact {"contact": "…"}`). Use that URL in the Play Console.

Summary of the text: the app is a client for the user's own Seamless server; mail, contacts and attachments are processed on that server and are not sent to the developer or any third party; the phone stores an encrypted session cookie and settings, removed on sign-out or uninstall; optional push uses Google Firebase Cloud Messaging (device token, and notification text unless "hide message content" is on); no ads, analytics or tracking; deletion via sign-out, account deletion via the server's administrator.
