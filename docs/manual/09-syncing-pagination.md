# Fetching, syncing & pagination

## How syncing works

Seamless keeps a live connection to each account and receives new mail in near real time — usually within seconds of it arriving. As a safety net it also re-checks each account about every 45 seconds, and if a connection drops it reconnects automatically with a backoff. Gmail and Microsoft accounts sync the same way over their authenticated connection.

You do not need to refresh manually; new mail appears on its own. The small **dot** in the top bar (left of the mailbox switcher) is **green** while your browser is connected live to the server, and **amber** while it is offline or reconnecting. Hover it for the details.

## The refresh button

The **refresh** button (circular arrows) in the sidebar's footer bar, next to the show/hide-sidebar button, checks **all** of your mailboxes for new mail immediately. It is handy after your computer wakes from sleep, after a network change, or whenever you just want to be sure you are up to date. It nudges the existing connections rather than reconnecting, so it is cheap even with many accounts.

## Pagination

The number next to the mailbox name (for example "Inbox 321") is the **total** count of mail in that view — all of it, not just the first page.

Seamless loads mail in pages of 120 and fetches the next page automatically as you scroll. There are no page buttons — just keep scrolling and more rows fill in (you may briefly see "Loading…" placeholders on a page that is still being fetched). This keeps even a mailbox with tens of thousands of messages fast.

Remember that **search covers everything**, not just the pages you have scrolled to — see **Searching your mail**.
