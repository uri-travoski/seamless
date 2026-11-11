# Security

## Two-factor sign-in

**Settings > Security > Set up authenticator app** shows a QR code. Scan it with any authenticator app (Google Authenticator, 1Password, Authy, Microsoft Authenticator…), type the 6-digit code, and two-factor is on. You then get **10 recovery codes** — save them somewhere safe; each works once if you lose your phone. A used code can't be used again, and the same 6-digit code can't be reused within its 30 seconds.

From then on, signing in asks for your password and then a code (or a recovery code). Turn it off, or get new recovery codes, from the same page (your password is asked first).

An admin can tick **Require two-factor sign-in for every user**; anyone without it is taken to Settings > Security after signing in.

**Passkeys** arrive once the server is reached over HTTPS — browsers only offer them on secure sites.

## Sessions

**Where you're signed in** lists every browser and device with its IP and last activity. **Sign out** ends one; **Sign out everywhere else** ends all but the one you're using. Sessions end on their own after 30 days without use, and after 90 days at most.

## What the server does for you

- Ten wrong sign-ins within 15 minutes (from one address, or for one account) blocks further tries for the rest of the window.
- Behind HTTPS the session cookie is `Secure` and `__Host-` prefixed, and strict security headers (CSP, frame and referrer policy, HSTS) are sent.
- The open-tracking pixel accepts at most 30 hits a minute per message, so a forwarded email can't flood the database.
