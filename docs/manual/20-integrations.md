# Integrations

Settings → **Integrations** lets Seamless tell other software when something happens in your mail.

## Webhooks

A webhook sends a signed HTTP `POST` to a URL you choose each time a chosen event happens.

1. **Settings → Integrations → Add webhook.**
2. Give it a name and the URL. Tick the events you want (`mail.received`, `lead.captured`, `send.failed`, …).
3. Optionally add **Only mail matching** — any search from the search box (`from:*@client.com.au subject:"timesheet"`, `is:vip`, `has:attachment`). It applies to events about a message; other events are skipped for a filtered webhook.
4. Choose **Include**:
   - *Metadata* — sender, recipients, subject, date, labels and ids.
   - *Body* — plus the plain text and HTML.
   - *Attachments* — plus each attachment as a download link.
   - *Raw* — plus a download link to the original `.eml`.
5. Save. The **signing secret** is shown **once**; copy it. **Rotate secret** makes a new one (the old one stops working immediately).

### What is sent

```json
{ "id": "evt_123", "type": "mail.received", "created_at": 1783500000000,
  "data": { "message": { "id": "m42", "from": [...], "subject": "…", "date": "…", "labels": ["Invoices"] } } }
```

Headers: `X-Seamless-Event`, `X-Seamless-Delivery` (delivery id), `X-Seamless-Timestamp` (unix seconds),
`X-Seamless-Signature: sha256=<hex>`.

### Checking the signature

The signature is `HMAC-SHA256(secret, timestamp + "." + rawBody)` in hex. Compute it over the **raw** request body
and compare in constant time. Reject requests whose timestamp is more than a few minutes old.

```js
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(ts + '.' + rawBody).digest('hex');
```

### Download links

Attachment and `.eml` links look like `/api/hooks/blob/<token>`. They need no login, work for **1 hour**, and
only for that one file. Fetch them promptly; ask for a redelivery if one has expired.

### Delivery, retries and the log

Your endpoint must answer `2xx` within 10 seconds. Anything else is retried after 1 minute, 5 minutes, 30 minutes,
2 hours, 6 hours and 12 hours (about 20 hours in all). After the last try the delivery shows **giving_up** and you get a
**"webhook gave up"** notification. Redirects are not followed.

**Deliveries** shows each attempt: status, HTTP code, attempts, the request body sent and the first 2 KB of the
response. **Redeliver** sends it again from the start. **Send test event** sends a `webhook.test` event once, with no retries.

### Private addresses (admins)

To stop a webhook being aimed at your internal network, Seamless refuses addresses that are loopback (`127.x`),
private (`10.x`, `172.16–31.x`, `192.168.x`), link-local (`169.254.x`), CGNAT (`100.64–127.x`), unique-local IPv6 or
multicast. The name is resolved by Seamless and the connection goes to that address, so a changing DNS answer can't
redirect it.

If the receiver is genuinely on your own network (for example another app on the same server), an admin can add its
host name, IP or CIDR range (such as `10.0.0.0/24`) under **Private-network allow-list**.
