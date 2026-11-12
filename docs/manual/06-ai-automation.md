# AI, rules & retention

Seamless files and cleans up mail automatically. Every incoming message runs through a cascade, stops at the first confident answer, and everything is logged.

## The classification cascade

1. **Rules** (free, deterministic) — your rule table runs first, in order. Raw headers are first-class (mailing-list headers, `Precedence: bulk`, and so on).
2. **Teach the AI** (content similarity) — if you have taught the AI about an example email, similar mail is filed the same way. See the **Teach the AI** page.
3. **Embeddings** (learns from you) — new mail is compared to your own labelled history; a confident match applies that label.
4. **LLM** (the ambiguous slice) — a cheap model reads the message and returns a structured verdict: is it a real document, does it require action, is it worth keeping, and for how long. This is what separates a real invoice from a bare "payment processed" notice.
5. **Review** — anything below the confidence threshold lands in the **Review** lane for a one-tap decision. Seamless never guesses and deletes.

## Rules

**Settings > Rules** is a table of conditions and actions (label it, send it to the AI with a note, stop processing, and so on). Rules apply on arrival and can be **run over existing mail**. Edit with a **dry-run diff** against recent mail before going live.

## AI providers

**Settings > AI** connects any OpenAI-compatible endpoint(s), mapped per task: **classify**, **embed**, **summarize**, and **draft**. Without AI, deterministic rules still work and ambiguous mail simply waits in Review. A per-user monthly budget caps spend; over budget, only rules and embeddings run.

## Retention: keep only what is worth keeping

Every classified message gets a **disposition** and, if it is to be deleted, a **delete-at** date.

- Labels carry retention: **protected** (never auto-deleted), **keep** forever, or **delete after N days**.
- The classifier can set dynamic lengths (a 2-year warranty keeps for 2 years; statements longer).
- A nightly sweep moves due mail to **Trash** (a grace window), then purges. Protected labels are never touched, and mail you have manually marked unread is left alone.
- **Countdown badges** (`Nd`) show on mail that is scheduled to go; open it and keep it to cancel.
- **Dry run** (default on) logs what the sweep *would* do without deleting anything, until you switch it live in **Settings → Storage → Trash & retention**.

## Review lane

When the AI is unsure, mail appears under **Review** with one-tap keep / label / delete. Clearing Review trains the system.

## Preferences & learning

- **Preferences** — plain-English guidance ("newsletters I signed up for are worth keeping") injected into AI decisions, versioned with rollback.
- **Corrections** — relabel a message and the next similar one is right for free; repeated corrections on one sender are offered as a permanent rule.

## Import config & logs

- **Import** (Settings → Import) imports (and exports) a rules spreadsheet — labels arrive with their retention, rules start classifying immediately.
- **Logs** shows every classification and retention action, filterable, with auto-clear settings.
