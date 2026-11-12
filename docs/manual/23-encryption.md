# Encryption (OpenPGP and S/MIME)

Seamless can sign, encrypt, verify and decrypt mail with **OpenPGP** (PGP/MIME, RFC 3156), so it works with
Thunderbird/Enigmail, GnuPG, Proton and other OpenPGP mail apps.

## Server-side mode (what is built)

Your **private key lives on this server**, encrypted with the server secret (and locked with your passphrase too if you
set one when creating it). Seamless does the cryptography for you in the browser session you are logged in to.

Trade-offs, honestly:

- The server operator (and anyone who has the server secret and the database) can use an **unprotected** key. Give the key
  a passphrase if that matters; the passphrase is asked for when you send or open mail and is **never stored**.
- Encrypted mail is **decrypted when you open it** and is not stored decrypted: it is not searchable by its content, and the
  list shows no preview text for it. (Subject and sender are not encrypted in OpenPGP and stay searchable.)
- A message you send with a passphrase-protected key is sent immediately (it skips the "Undo send" hold, which would
  otherwise have to keep your passphrase on disk).
- **Browser-only decryption** (the private key never reaching the server) is a separate, larger feature and is **not built
  yet**. Autocrypt headers are not built either.

## Your keys — Settings → Encryption

- **Create key**: pick an identity (a sending address) and optionally a passphrase. Seamless makes a modern curve25519 key.
- **Import a key**: paste an armored key. A private key becomes one of yours; a public key becomes a contact key.
- **Export public**: download the `.asc` to give to people so they can encrypt to you.
- **Delete** a key. Without your private key you can no longer read mail that was encrypted to it.

## Keys of the people you write to

A contact key can arrive three ways:

1. **Import** it in Settings → Encryption.
2. **From mail**: when a message has a public key attached (`.asc`), a bar above the message offers **Import key**. A mailed key
   is only ever imported as a contact key, never as one of yours.
3. **Look up** (WKD, Web Key Directory): Seamless asks `openpgpkey.<domain>` and then `<domain>` for the address's key. This
   also happens automatically in the compose window when you turn Encrypt on and a recipient has no key yet.

Looking up on **keys.openpgp.org** is **off by default** (it tells that server who you write to). Turn it on under
Settings → Encryption. A key is only accepted if it really lists the address you asked for.

## Writing

In the compose toolbar, next to the tracking eye, are two buttons:

- **Sign** (shield): needs a key for the From address. Hover a greyed-out button to see why it is unavailable.
- **Encrypt** (padlock): needs a public key for **every** recipient (To, Cc and Bcc). If one is missing, the button is
  disabled and the tooltip names the recipient. The message is also encrypted to **your own key** so your Sent copy stays readable.

You can use both at once (signed, then encrypted). Open tracking is switched off for signed or encrypted messages (a
tracking pixel would break the signature or defeat the point of encrypting). Drafts are saved readable, not encrypted.

## Reading

A bar above the message shows what Seamless found:

- **Verified signature from …** — the signature is good and the signer's key is in your key ring.
- **Signed, but … unverified** — there is a signature, but you do not have the sender's key. Import it to verify.
- **Bad signature** — the message was changed after signing, or the signature does not match. Do not trust it.
- **Encrypted — decrypted for you** — Seamless decrypted it with your key. If your key has a passphrase, the bar asks for it.

Both PGP/MIME messages and older "inline" messages (`-----BEGIN PGP MESSAGE-----` in the body, or a clear-signed body) are handled.
Seamless does not check keys against the web of trust: "verified" means the signature matches a key in **your** key ring.


# S/MIME

Seamless also signs, verifies, encrypts and decrypts with **S/MIME** (CMS, RFC 8551), the standard built into Outlook, Apple Mail
and Thunderbird. Like OpenPGP it works in server-side mode: your private key is stored encrypted with the server secret.

## Your certificate — Settings → Encryption → S/MIME

- **Import your certificate (.p12)**: choose the identity (sending address), the `.p12` / `.pfx` file and the file's password.
  The certificate must be valid for that address. Files protected with old RC2 / 3DES encryption are not read: re-export
  with AES (with OpenSSL 3, just leave out `-legacy`).
- **Add a contact's certificate**: paste a PEM certificate. You rarely need to: certificates of people who send you
  **signed** mail are collected automatically (only when the signature is valid and the certificate matches the From address).
- **Export certificate** gives you the public certificate; **Delete** removes it (deleting your own means you can no longer read
  mail encrypted to it).

## Writing

When you have a certificate for the From address, two more toggles appear in the compose toolbar next to the OpenPGP ones:

- **Sign** (seal): a detached SHA-256 signature (`multipart/signed`, `application/pkcs7-signature`).
- **Encrypt** (padlock with key): AES-256 encryption (`application/pkcs7-mime; smime-type=enveloped-data`) for every recipient
  and for yourself. It needs a certificate for **every** recipient; the tooltip names who is missing. Only RSA certificates can be encrypted to.

Use S/MIME **or** OpenPGP for one message, not both (turning one on turns the other off). Open tracking is off for S/MIME mail.

## Reading

A bar above the message shows **S/MIME signed by <name> <address>, issuer <issuer> — not checked against a trust store**, a
bad-signature warning if the message was altered, or an "encrypted — decrypted for you" note. The signature is only called
verified when the certificate's address matches the sender. **Seamless does not decide whether the issuer is trustworthy**:
a self-made certificate looks the same as one from a public authority, so check the issuer yourself for important mail.
Encrypted mail is decrypted when you open it, held in memory only and not searchable by its content.
