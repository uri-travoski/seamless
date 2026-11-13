# Data safety form — answers

**Does the app collect or share user data?** Yes (processed on the user's own server; see below).
**Is all data encrypted in transit?** Yes — https is required except on private home-network addresses chosen by the user.
**Can users request deletion?** Yes — Sign out removes the session and push registration; account/mail deletion is done by the server's administrator (privacy policy names the contact).
**Ads?** No. **Analytics?** No. **Data sold?** No.

| Data type | Collected | Shared | Purpose | Notes |
|---|---|---|---|---|
| Email address | Yes | No | App functionality, account management | Used to sign in to the user's own server; never sent to the developer |
| Emails (messages, attachments) | Yes | No | App functionality | Fetched from and sent to the user's own server only; "processed", not stored by the developer |
| Contacts (names/addresses in the user's address book on the server) | Yes | No | App functionality | Autocomplete when writing; device contacts are NOT read |
| Device or other IDs (FCM token) | Yes | **Yes — Google (Firebase Cloud Messaging)** | App functionality (push notifications) | Optional: only when the administrator configures push; also stored on the user's server |
| Files and docs (attachments the user picks) | Yes | No | App functionality | Via the system picker; sent only to the user's server |
| Location, health, financial, photos/videos (own access), audio, calendar, SMS/call log, web history | No | — | — | — |

Security practices: data encrypted in transit; the developer receives no data; session cookie stored in encrypted storage; no backup of app data (`allowBackup=false`).
Declarations: not designed for children; no financial features; no health features; not a VPN; no accessibility-service use.
