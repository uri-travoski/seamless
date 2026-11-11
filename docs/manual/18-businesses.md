# Businesses and identities

If you run more than one business from the same inbox, a **business** keeps each one's branding together: a logo, a
brand colour, contact details and a signature. Open **Settings → Businesses**.

## Businesses

Choose **New business** and fill in:

- **Name** and a **short name**.
- **Brand colour** — shown as a small chip next to the business's identities.
- **Phone**, **website**, **ABN** and **address**.
- **Logo** — PNG, JPEG or a plain SVG, up to 512 KB. Save the business first, then upload the logo. SVGs that contain
  scripts, links or embedded objects are refused.
- **Default signature** and **disclaimer**. The disclaimer is added under every signature for this business.

### Signature variables

| Variable | Replaced with |
|---|---|
| `{{business.name}}` `{{business.phone}}` `{{business.website}}` `{{business.abn}}` `{{business.address}}` | the business details |
| `{{identity.name}}` `{{identity.email}}` | the identity you send from |
| `{{logo}}` | the logo, sent inline with the message |

Unknown variables are left as they are. The **Preview** under the editor shows the rendered signature as you type.

## Identities

Every mailbox has an identity for its main address and one for each alias. They are created and removed for you when
you add a mailbox or change its aliases. Under the businesses list, **Identities** lets you edit each one:

- **Display name** — the name recipients see.
- **Business** — which business this address belongs to.
- **Reply-to** — replies go here instead of the From address.
- **Bcc me** — send yourself a blind copy.

An identity can also have its own signature, which takes the place of the business's default.

Deleting a business keeps its identities; they just become unassigned. Logos and businesses are private to your login.

## Sending from an identity

In the composer, the **From** list is grouped by business and a coloured dot shows the business colour. Picking a
different From address swaps the signature block (you can edit it like normal text; if you delete it, it comes back only when you change
the From address). Replying uses the address the mail was
delivered to, with that address's signature. Display name, reply-to and "Bcc me" come from the identity; if the
identity has its own outgoing server (an outgoing transport chosen for it), that one is used instead of the mailbox's.

## Wrong-business warning

When you press Send, Seamless looks at the last 12 months of mail you sent to each recipient's company domain
(free-mail domains such as gmail.com are ignored). If you have written there at least three times and 70% or more of
those were from a different business, you are asked: "You usually email @client.com.au from Office Cleaners R Us.
Send from Swan Office Cleaners anyway?" You can switch the From address or send anyway. To stop the warning for one
person, turn on **don't warn** for that contact (Contacts API field `noBusinessGuard`).
