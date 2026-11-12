# Teach the AI

Teach the AI is the fastest way to make Seamless handle a kind of mail the way you want — you just describe it in plain English, and future **similar** messages are handled the same way automatically.

## How to use it

1. Open any email that is a good example.
2. Click the **Teach the AI** button (the sparkle icon) in the reading-pane toolbar.
3. In one sentence, say what the email is and how to handle emails like it. For example:
   - "This is a product warranty. Label these Warranties and keep them for 2 years."
   - "Newsletter I signed up for. Label it Reading, mark it read, and delete after 7 days if I never open it."
4. Click **Continue**. The AI reads your instruction and shows **what it understood** — the label to file under, and any actions (delete after N days, mark read).
5. Choose the label: the AI proposes a **new** label name and offers the closest **existing** labels — pick whichever you want, or **No label**.
6. Click **Save & apply to future mail**.

## How it matches future mail

Teach the AI learns from the **content** of the example, not just the sender. When new mail arrives that is similar in meaning to what you taught, Seamless files it the same way — even from a different sender. Unrelated mail is left alone.

Retention rides on the **label**: if you said "keep 1 year", the label is created (or updated) with that retention, so anything filed there follows the same rule.

## How it differs from other tools

- **Rules** (Settings > Rules) are exact and deterministic — match a sender, a keyword, or a header. Use rules when you want a precise, predictable match.
- **Teach the AI** is fuzzy and semantic — "handle emails like this one". Use it when the pattern is about *meaning*, not a fixed string.
- **Private notes** are just personal reminders on a single email; they do not change how mail is handled.

## Managing what you have taught

Each thing you teach is remembered as an instruction tied to the example. It applies until you remove it. Re-teaching on a similar email updates the instruction rather than duplicating it.

## Why is this here?

Open a message the AI or a rule filed. Under the sender line you will see a quiet link such as **Filed by AI · 92 % · why?**
(or *Filed by a rule*, *Filed by similar mail*, *Fixed by you*). Click it to see the reason, the rule or the similar example that matched,
the model and the date. Nothing appears on list rows, and nothing appears for mail that is still waiting for the AI or that you filed by hand.

## Fix a wrong decision

In the same box press **Wrong? Fix it**:

1. Choose the right label (or *No label*), and optionally *Keep* or *Delete after N days*.
2. Leave **Remember this for similar mail** ticked (the default). The corrected message becomes a labelled example the AI trusts more than its own
   older guesses, so the next similar message follows your choice. Untick it for a one-off fix.
3. Optionally write **why**. It is saved as a line of guidance (Settings → Rules → Teach the AI) and changes how the AI treats that sender.

A toast offers **Undo**. After you have fixed mail from the same sender to the same label three times, the app offers **Make this a rule**.
Moving or labelling a message by hand counts as a correction as well (no prompt). Settings → Rules → **Corrections** lists everything you have
corrected; **Remove** undoes one.

A message you fixed is marked as handled by you: the AI will not touch it again. If you chose *Delete after N days*, it is still swept after N days.
