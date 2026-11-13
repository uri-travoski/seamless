# App access / review notes

Play requires a working login for the reviewer ("App access" → "All or some functionality is restricted" → provide credentials). Seamless needs a server, so run a small public demo.

## Demo server (":4902-style")
1. On a machine with a public https address (a small VPS or a tunnel such as `cloudflared tunnel` — your choice, not done by the build), start the stack: `docker-compose -f stack/docker-compose.dev.yml -p seamless-demo up -d`.
2. Create a separate database and bucket so nothing real is on it: `PORT=4902 DATABASE_URL=postgres://…/seamless_demo S3_BUCKET=seamless-demo PUBLIC_URL=https://demo.example.com npm start` (in `server/`).
3. Open the address, create the admin **play-reviewer@demo.test** with password **`<a throw-away password>`**, add a GreenMail mailbox (IMAP `localhost:3144`, SMTP `localhost:3026`, user `play-reviewer@demo.test`) and send a few sample mails to it (`swaks` or the GreenMail web UI). No 2FA on this account.
4. Set the privacy contact; keep the server up for the whole review (days).

## Text for the Play Console "App access" box
> Seamless is a client for a self-hosted mail server. To review: open the app, enter the server address `https://demo.example.com`, press Check, then sign in with email `play-reviewer@demo.test` and the password given in the credentials field. The mailbox contains sample mail. No other steps or 2FA are needed. Push notifications are optional and off on the demo server.

Replace the placeholders with the real demo address and password before submitting (they are not stored in the repo).
