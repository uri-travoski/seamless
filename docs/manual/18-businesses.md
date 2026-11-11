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
