# Encryption (OpenPGP)

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
