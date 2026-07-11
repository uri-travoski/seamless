# Classification & retention

Every incoming message runs through a cheapest-first cascade:

1. **Your rules** (Settings → Rules) — sender, domain, subject, raw headers (List-Id,
   Precedence, Auto-Submitted). Free and instant; most mail stops here. A rule set to **AI**
   deliberately hands that sender to the AI (for senders that mix receipts with marketing).
2. **Similarity memory** — the message is compared against your own labelled history
   (embeddings). If its nearest neighbours agree, it gets their label with no AI call.
3. **AI verdict** — the LLM returns structured facts, never just a label: *is this a real
   itemised document? does ignoring it have consequences? is it worth keeping? how long?*
   That is how "payment processed" noise is deleted while the same subject with an itemised
   PDF is kept as a receipt.
4. **Review lane** — anything the AI is unsure about waits for a one-tap decision in the
   sidebar. Nothing is ever deleted on a guess.

## Retention

A label carries its retention (Settings → Labels): protected (never auto-deleted), keep forever,
or delete-after-N-days. The hourly sweep moves expired mail to Trash (recoverable 30 days), then
purges. Orange countdown badges show what is scheduled. Overrides, strongest first:

- **You** — marking a message unread, starring nothing needed: just mark unread; restoring from
  Trash also protects it permanently.
- **Processor notes** — open a message → note icon → *teach the AI about this sender*: fixed
  label, auto-mark-read, delete-after-N-days, "only if I never read it", plus free-text guidance
  the AI follows.
- **AI verdict** — can rescue actionable/real documents from a label's countdown, but never
  shortens one.
- **Label retention** — the default clock.

**Dry run** is ON until you turn it off (Settings → Import & Retention). Check Settings → Logs:
every line says exactly what would have been trashed.

## Preferences & corrections

Plain-English preferences (Settings → Rules, bottom) are injected into every AI decision —
"Shipping updates → To Delete". Editing bumps a version so old decisions stay auditable.
Every manual relabel updates the similarity memory instantly, and repeated corrections on one
sender produce a *make it a rule?* suggestion.
