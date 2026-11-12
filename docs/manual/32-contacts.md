# Contacts

Seamless keeps an addressbook for you. It fills itself as you write to people, you can add and organise people by hand, and it syncs to your phone over CardDAV. Everything is under **Settings > Contacts**.

## How autocomplete works

Start typing in **To / Cc / Bcc** and Seamless suggests people as you type:

- It matches **any word of the name**, the **email address** and the **organisation** ("plumb" finds Maria at Swan Plumbing).
- People you write to often and recently come first.
- Each suggestion shows a small initial, the name, the email and the organisation.
- Type a name and press **Tab, Enter or comma** to take the highlighted person.
- **Paste** a list such as `Jane Doe <jane@x.com>, "Smith, Bob" <bob@y.com>, ann@z.com` and it is split into one chip per person.
- Type or pick a **group name** and it expands into everyone in that group (see below).
- **Other contacts** (people Seamless saved for you automatically) are listed under their own heading, and only while auto-save is on.
- **Typo guard:** if you type an address you have never used and the name matches someone you already know with a different address — or the address is one or two letters away from a known one — the chip turns amber with a `!`. Hover it to see who you probably meant.

## Auto-save (like Gmail)

The moment you send, everyone in To, Cc and Bcc is saved. When you reply, the person you replied to is saved too. A small "Saved Jane to contacts" message with **Undo** appears — Undo removes only that automatically created contact, and Seamless will not re-add that address on its own afterwards.

Never saved automatically: `no-reply` / `do-not-reply` addresses, your own addresses and aliases, and senders of mailing-list or bulk mail. Nothing is saved in **Viewing mode**.

Mail you send from another app (your phone, Thunderbird) is picked up within ten minutes by a background check.

### Turning it off

**Settings > Contacts > "Automatically save people I write to or reply to".** Off means *no new contacts are created* — the ones you already have stay. The sub-option **"Also save senders I reply to"** controls only the reply case (on by default). To clean up, use **Delete all auto-saved contacts** (it asks first; contacts you added, edited or kept with **Keep** are not touched).

## Managing contacts

- **Add contact** — name, organisation, several emails (with Work / Home / Other labels), phone numbers, groups, notes.
- **Filters:** All, My contacts, Auto-saved, Hidden, Business (has an organisation). **Sort:** most used, recent, name.
- **Keep** turns an auto-saved contact into one of "My contacts"; editing a contact does the same.
- Click a name to open its card: all addresses, phones, how often you wrote, and your **recent conversations** with them (with shortcuts to search mail from / to them).
- **Select** several contacts to hide, delete, make "My contact", add to or remove from a group, or export just those.
- **Merge duplicates** lists pairs that share a name or an address; you confirm each merge. Nothing is lost: all emails, phones and groups are kept and the counts are added up.
- In the reading pane, a sender who is not saved shows **Add to contacts**; hover a sender's name for a small card with what Seamless knows.
- **Rebuild from mail** rescans your sent mail and replies (it does not undo your edits).

## Groups

Create groups under **Settings > Contacts > Groups**, then add people to them from the contact editor or by selecting several contacts. In **To**, type the group's name: it expands into all its members (hidden contacts are skipped). Groups sync to phones as vCard *categories*.

## Import and export

**Export** (all, the current filter, a group, or the selected contacts) in:

| Format | For |
|---|---|
| vCard 3.0 (.vcf) | Apple Contacts, Android, Outlook, Thunderbird |
| Google Contacts CSV | Gmail / Google Contacts |
| Outlook CSV | Outlook (up to three emails per person) |
| Generic CSV | spreadsheets: name, emails, phones, organisation, notes, groups |
| JSON | scripts and backups |

**Import** accepts .vcf (several people per file; vCard 2.1, 3.0 and 4.0; photos are ignored), Google CSV, Outlook CSV, Apple/Thunderbird CSV and any other CSV. UTF-8 and UTF-16 files, comma or semicolon separated, are detected. You always see a **preview** first: how many are new, how many already exist, how many are invalid, which groups will be created, and for CSV a **column mapping** you can change. Choose what happens to people you already have (same email):

- **Skip** them,
- **Merge** into the existing contact (adds emails, phones and groups, fills empty fields), or
- **Only fill empty fields**.

Groups, labels or categories in the file become Seamless groups. After importing you get a report, and the rows that were skipped can be downloaded as a CSV. A bad row never stops the rest of the file.

### Moving to Seamless

- **From Gmail / Google Contacts:** contacts.google.com → Export → *Google CSV* (or vCard) → import the file here.
- **From Outlook:** File → Open & Export → Import/Export → Export to a file → Comma Separated Values (or export contacts as vCard) → import it here.
- **From an iPhone / iCloud:** icloud.com/contacts → select all → Export vCard → import the .vcf.
- **From Android:** Contacts app → Settings → Export → .vcf file → import it here.
- **From Thunderbird:** Address Book → Tools → Export → CSV or vCard.

## On your phone

Add a CardDAV account (Settings > Devices explains how) and the same contacts — including their groups — appear in your phone's Contacts app. See [Devices & contacts](08-devices-contacts.md).

## Good to know

- Contacts are private to your login. In a shared mailbox the addressbook stays your own.
- Hidden contacts stay in Seamless but are left out of autocomplete and CardDAV.
- Contacts and groups are included in backups and in archives ([Backup and restore](11-backup-restore.md), [Viewing old mail](30-viewing-old-mail.md)).
