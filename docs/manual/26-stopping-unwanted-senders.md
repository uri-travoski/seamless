# Stopping unwanted senders

Seamless gives you four tools. None of them can stop a message being **delivered to your provider** — they act after
the mail has arrived in Seamless. That is explained under *What can't be stopped* below.

| Tool | Best for | Where the mail goes |
|---|---|---|
| **Block sender** | One annoying address | Spam |
| **Filter on a domain** | Everyone at a company | Whatever you choose (Spam, Bin, Archive) |
| **Unsubscribe** | Newsletters and marketing lists | Bin (or Archive – your choice) |
| **Disposable addresses** | Sign-ups you don't trust | Dealt with per address |

## Block one sender

1. Open the message (or right-click it in the list).
2. Choose **Block sender** from the message menu.
3. The message moves to **Spam** straight away and a filter called *Block name@example.com* is created.

From then on mail from **exactly that address** goes to **Spam** (you will find it under **Spam** in the sidebar, not in
the Inbox). The filter is listed in **Settings → Filters**; delete it there to unblock. Blocking an address does not block
other addresses at the same company — use a domain filter for that.

## Block a whole domain

1. **Settings → Filters → Add filter**.
2. **Name:** for example *Block company.com*.
3. Under **When a new message matches** keep **all**, then set the condition to **from** · **contains** · `@company.com>`.
   (The "from" field is checked as `Name <address>`, so the closing `>` makes it match the domain exactly and not, say,
   `@company.com.au`.)
4. Under **Do:** choose **move to** → **junk** (Spam). Use **move to trash** to send it to the Bin instead.
5. Leave **Stop processing further filters when this one matches** ticked and **Enabled** ticked, then **Save filter**.
6. Optional: press **Run now** next to the filter to apply it to mail you already have.

## Unsubscribe from a newsletter

1. Open the newsletter. A bar appears above it: **Keep in Inbox · Read later · Unsubscribe**.
2. Press **Unsubscribe**. Seamless uses the sender's own unsubscribe method: a one-click request when the sender supports
   it, otherwise it sends the unsubscribe email for you from the address the newsletter was delivered to. If the sender only
   offers a web page, Seamless gives you the link to finish in your browser.
3. Seamless adds a filter called *Unsubscribed: sender* and the bar changes to "You unsubscribed from …". Future mail
   from that sender goes to the **Bin** — or to **Archive** if you change **Settings → Newsletters → After
   unsubscribing, move the sender's future mail to**.

Only genuine newsletters (mail with a list-unsubscribe header) show the bar. Unsubscribing from a sender that ignores
requests is why the filter exists: whether or not they stop, you stop seeing it.

## Disposable addresses

If you own a domain set up through *Own domain (Cloudflare Email Routing)*, give each sign-up its own address under
**Settings → Disposable → + New address**. If one starts getting junk, **Dispose** it: mail to it stops reaching your
Inbox, with **Undo** if you change your mind. See [Disposable addresses](16-disposable.md).

## What can't be stopped

- **Before delivery.** Seamless does not receive mail directly from the internet for Gmail, Microsoft or IMAP mailboxes
  — your provider does, and Seamless collects it afterwards. A blocked sender's message still reaches your provider first
  and is then filed away by Seamless. It never appears in your Inbox, but the provider's own spam rules (Gmail's
  "Block", for example) are what stop it reaching their server. If you need that, block the sender there as well.
- **Look-alike addresses.** A sender can use a new address tomorrow. Block the domain, or label the mail with
  **Teach the AI** ([Teach the AI](07-teach-the-ai.md)).
- **Spam in Spam.** Mail in Spam is kept until you empty it; searching excludes it unless you add `in:spam`.
