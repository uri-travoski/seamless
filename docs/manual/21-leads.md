# Leads

Seamless can turn the notification emails your websites send (a quote form, a contact form, an ad lead form) into
**leads**: one row per enquiry, with the person's name, email, phone, suburb, service and message pulled out for you.

Open **Leads** in the sidebar (under Labels). Set it up in **Settings → Leads**.

## Set up your first lead source

1. **Settings → Leads.** If you have no sources yet you will see **Add lead source**; otherwise use the same button at the
   bottom of the list.
2. **Name:** something you will recognise, e.g. *Office Cleaners website*.
3. **Which mail is a lead? (search):** the search that matches your website's notification emails. Open one of those
   emails first and note who it comes from and what the subject says, e.g.
   `from:wordpress@officecleaners.com.au subject:"New quote request"`.
4. **Business:** pick the business the website belongs to (or leave **None**). Create businesses under **Settings →
   Businesses**.
5. Press **Test against recent mail**. Seamless lists the latest messages the search matches and shows what it would read
   from each: name, email, phone, suburb, service. Nothing is saved yet.
   - Nothing listed? The search is too narrow — loosen the subject or check the sender.
   - Columns blank or wrong? The form email is unusual; add or set up an AI provider (**Settings → AI**) and test again.
6. When the test looks right, leave **Enabled** ticked and press **Add source**.
7. Submit a test enquiry on your website. Within a minute a **New lead** notification appears and the lead is in
   **Leads** in the sidebar.

Only mail that arrives *after* the source exists is captured. To change the search later, press **Edit** beside the source.

## Lead sources

A lead source says *which mail is a lead*. It is an ordinary search, the same language as the search box:

```
from:wordpress@officecleaners.com.au subject:"New quote request"
```

- `from:`, `to:`, `subject:` (a piece of the subject line) and plain words all work.
- Pick the **business** the website belongs to; leads are grouped by it.
- **Test against recent mail** shows the latest messages the search matches and exactly what would be read from each
  one (name, email, phone, suburb, service). Nothing is saved while testing — use it until the columns look right.
- Only new mail that arrives in an Inbox is captured. Old mail is not turned into leads.

Works with the notification emails of WordPress forms, Contact Form 7, Gravity Forms, Elementor, WPForms, Wix,
Squarespace, Google Ads lead forms and Facebook lead ads. Seamless reads "Label: value" lines and form tables. If the
form email has neither an email address nor a phone number, and you have an AI provider set up (Settings → AI), the
AI is asked to read it instead. If the email has no address in the body, the message's Reply-To address is used. The
website's own sender address is never used as the lead's address.

Australian phone numbers are tidied to international form: `0412 345 678` → `+61412345678`,
`(08) 9381 1234` → `+61893811234`. Anything else is kept as written.

## The Leads page

- Filters: business, status, service, date, and a search box. They are kept in the address, so you can bookmark a view.
- **Status** (new, contacted, quoted, won, lost, spam) can be changed right in the table.
- **Reply** opens a new message addressed to the lead's own email (not the website's form address), sent as the
  business's identity when one is set up.
- Click a row for the detail panel: every field that was found, the message, and a link to the original form email.
- **Repeat enquiry**: the same email or phone within 30 days is merged into the existing lead instead of making a
  second row, and the lead shows a "repeat" badge.
- Every lead also adds the person to your contacts, using their address.

## Stats

The **Stats** tab shows, per month, business and source: how many leads, how many you won (and the percentage), and the
**median time to first reply**. The first reply is the first message you send to the lead's email after the enquiry
arrived — sent from Seamless or from any other app that puts a copy in the Sent folder. Sending a reply also moves a
"new" lead to "contacted".

## Notifications and other apps

Each new lead (and each repeat enquiry) raises a **New lead** notification. It also fires the `lead.captured` event,
so a webhook (Settings → Integrations) can send it to a CRM, a spreadsheet or BizBooks. The event carries the parsed
fields: `name`, `email`, `phone`, `suburb`, `service`, `details`, `source`, `businessName`, `repeat`.
