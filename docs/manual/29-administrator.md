# Administrator tools and storage limits

## Who is the administrator?

The **first account created** when Seamless was set up is an **admin**. An admin can make other people admins too. Everyone else is a **member**. In **Settings → Users** your own role is written under the heading ("Signed in as … (admin)"). Members do not see the user list at all, and the server refuses every admin action from a member.

Admins can manage people. They can **not** read other people's mail: each user's mailboxes, labels and filters belong to that user only (unless the owner shares a mailbox, see [Shared mailboxes](19-shared-inbox.md)).

## Settings → Users (admins only)

The table shows, for each person: name and email, role, number of mailboxes, **storage used / limit**, and when they last signed in. A grey "Disabled" tag or a blue "Temporary password" tag appears next to the name when it applies.

### Add a user
1. **Settings → Users → Add user**.
2. Type their email and name, and a **temporary password** (at least 8 characters).
3. Leave **They must choose their own password at first sign-in** ticked (recommended).
4. Pick **Member** or **Admin**, and a **storage limit in GB** (empty = no limit). The box starts with the instance default.
5. **Create user**, then tell them the temporary password.

### Edit
**Edit** changes the name, the role and the storage limit.

### Reset a password
1. **Reset password** on their row.
2. Type a temporary password (at least 8 characters) and press **Reset password**.
3. They are signed out everywhere. At their next sign-in they see only a "choose your own password" screen and cannot use Seamless until they have done it. The new password must differ from the temporary one.

You cannot reset your own password here; use **Change my password** at the top of the page.

### Disable / Enable
**Disable** signs the person out everywhere, stops them signing in (they see "This account has been disabled"), blocks their API tokens and **stops their mailboxes syncing**. Nothing is deleted. **Enable** turns everything back on and syncing restarts.

### Sign out everywhere
Ends every browser and device session of that person. (For your own row, the browser you are using stays signed in.)

### Delete
Removes the person with their mailboxes, mail cache and settings. The mail at the provider is untouched.

### Safety rules
- You cannot demote, disable or delete the **last active administrator** (a disabled admin does not count). Make someone else an admin first.
- You cannot disable or delete yourself.
- Every one of these actions is written to the [Audit log](22-audit-log.md) with who did it and to whom. Passwords are never recorded.

## Add a mailbox for someone else
1. **Settings → Users**, find the person, **Add mailbox**.
2. The usual *Add a mailbox* steps appear (address, provider, incoming, outgoing, test). A line at the top says whose mailbox it is.
3. When you save, the mailbox belongs to **that person**, not to you. Its passwords are stored encrypted like any other. It is written to the Audit log as "account.add_for_user".

Members can still add their own mailboxes in **Settings → Mailboxes**. Only admins can add one for somebody else.

## Storage limits

A limit is a number of gigabytes per person. **Used** is the size of all mail in that person's own mailboxes (attachments are part of the message, so they are included once). It is recalculated about every 5 minutes.

- **Per person:** *Edit* → *Storage limit*.
- **Default for new people:** under the table, *Default storage limit for new users*. It is copied to each new user at creation; later changes to the default do not alter existing people.
- The bar turns **amber from 80 %** and **red at 100 %**.

### What the alerts look like
A background check runs every 30 minutes.
- **At 80 %** the person gets a notification "Your mailbox space is 83% used". Every admin gets "name@example.com is 83% full".
- **At 100 %** the person gets "Your mailbox space is full" and every admin gets "name@example.com has used all of their mailbox space".
- You get **one notification per level** — it does not repeat every 30 minutes. Once usage drops **below 75 %** the alerts re-arm and can fire again.
- They follow the normal rules in **Settings → Notifications** (rows "Mailbox space 80% used" and "Mailbox space full"), including push.

**A limit only warns.** At 100 % Seamless does **not** refuse incoming mail, block sending, or delete anything. The warning is there so you can free space, ask for a bigger limit, or move to larger storage ([Storage](17-storage.md)).

### Your own space
Every user can see their usage under **Settings → Storage → Your mailbox space**.

## If something goes wrong
- *"This account has been disabled"* at sign-in: an admin disabled it; ask them to press **Enable**.
- Forgot your own password and you are the only admin: sign in is impossible; restore access from the server (see [Troubleshooting](10-troubleshooting.md)) — this is why a second admin is a good idea.
