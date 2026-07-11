# AI-Native Email Rules for Your Webmail Client — Design

A step-by-step build, tuned to your goals:
- **Accurate labelling** with the cheapest possible AI spend.
- **Keep only what's worth keeping** — receipts *with real invoices*, warranties, statements, tickets, legal/tax docs — and let everything else expire.
- **Gets smarter with use** — every correction improves it, with *no* code changes.
- **Reuses the spreadsheet** you already have as the config source.
- **Bootstraps from a real Gmail account** — read its labelled mail, infer rules, import them.

---

## 0. Guiding principles

1. **Delete-by-default.** The system's job is a near-empty inbox. Everything is assigned a *disposition* at classification time; the default is "delete after N days" unless it's proven worth keeping.
2. **Cheapest tier first.** A cascade (rules → embeddings → cheap LLM → human) where each email escalates only if the tier below isn't confident. Most mail never reaches the LLM, so cost stays near zero.
3. **Every correction is training data.** A user moving/deleting an email feeds back automatically. Cost *drops* as usage grows because more work shifts to free tiers.
4. **Config-as-data.** Rules, labels, preferences, retention all live in tables (seeded from your spreadsheet), editable without deploys.
5. **Explainable + dry-runnable.** Store *why* (reason + confidence); let users preview a rule/preference against real mail before it goes live. This is what makes people trust automation instead of fighting it.

---

## 1. Ingestion & the email lifecycle

Classify **once, at ingestion, in an async worker** — never in the request path, never repeatedly.

```
SMTP/IMAP delivery ─▶ store raw msg (state=received) ─▶ enqueue
                                                          │
                          ┌───────────────────────────────┘
                          ▼
                   classification worker ─▶ writes labels + disposition (state=classified)
                          │
                          ▼
                   UI updates live (websocket)
```

**Lifecycle states:** `received → pending → classified → {kept | scheduled_delete | needs_review}`. Re-classification (after a rule/preference change) is just re-enqueuing — you set `state=pending` and it flows again.

Two things that were painful in the Gmail/Apps-Script version disappear here:
- **You can remove and change labels freely.** (Apps Script could only *add* — which is exactly why fixing a mislabel meant manual surgery.)
- **Retention is a cron over your DB**, not a fragile scheduled search-and-trash.

---

## 2. Data model (your spreadsheet → tables)

Your sheet's tabs map almost one-to-one to tables. Build an importer that reads the `.xlsx` and seeds these — and an exporter back to `.xlsx` so power users can bulk-edit config in a spreadsheet (a genuinely nice feature you already have the format for).

| Spreadsheet tab | Table |
|---|---|
| Labels | `labels` |
| Rules | `rules` |
| Preferences | `preferences` |
| Settings (retention rows) | `retention_policies` |
| Settings (Add To Delete, thresholds…) | `user_settings` |
| Forwarding Accounts / Out | `routes` |

```sql
labels(id, user_id, name, parent_id,
       keep_default BOOL,           -- replaces the "Add To Delete to labels" hack:
       default_retention TEXT,      --   'keep' | 'delete' | 'keep_1y' | 'keep_2y' | 'keep_3y'
       protected BOOL)              -- never auto-deleted

rules(id, user_id, enabled, ord,
      match_field TEXT,             -- from | from_domain | to | subject | body | header | list_id
      match_value TEXT, exclude TEXT,
      action TEXT,                  -- 'label:<name>' | 'ai'  (ai = delegate to LLM)
      stop BOOL, note TEXT, source TEXT)   -- source: 'manual' | 'imported' | 'suggested'

preferences(id, user_id, enabled, guidance TEXT, version INT, active BOOL)

emails(id, user_id, message_id, from_addr, from_domain, subject,
       headers JSONB, snippet, has_real_attachment BOOL,
       state TEXT, disposition TEXT, delete_at TIMESTAMP)

email_labels(email_id, label_id, applied_by TEXT, confidence REAL)  -- applied_by: rule|embedding|ai|user

ai_decisions(email_id, model, output JSONB, confidence REAL, reason TEXT, cost, created_at)

corrections(id, user_id, email_id, from_label, to_label, kind, created_at)  -- the gold

email_vectors(email_id, embedding VECTOR(384))   -- pgvector; the "memory"
```

Notice `labels.keep_default`/`default_retention` — a label *carries* its retention. Tagging something `Sale` or `Service Notifications` inherently means "delete"; tagging `Receipts` means "keep". Cleaner than the additive To-Delete trick, and it's what drives §4.

---

## 3. The classification cascade (step by step)

The worker runs these in order and **stops at the first confident answer**.

### 3a. Deterministic rules — free, instant, and your unfair advantage: **raw headers**

Owning the mail server means you see headers Gmail's API hides — and they're the strongest "is this a real thing or an automated notice" signals *before any AI*:

| Header | Signal |
|---|---|
| `List-Unsubscribe`, `List-Id` | marketing / newsletter → `Sale` |
| `Precedence: bulk`, `Auto-Submitted: auto-generated` | machine notification, *not* a personal actionable email |
| `Authentication-Results` / DKIM / SPF | trusted sender identity (and spoof detection) |
| `Return-Path` mismatch vs `From` | forwarded/relayed — reconstruct the true origin |

So a rule row can match `header: List-Id present → Sale`, or the classic `from_domain → label`. Run the user's rule table in `ord` order; `stop=true` on match ends it. This alone resolves the large majority of mail. Rules whose action is `ai` fall through to the LLM (your "mixed sender" case — Google Play, AliExpress).

### 3b. Embedding similarity — cheap, and it *learns automatically*

For anything rules don't settle: embed the email (subject + snippet + key headers) with a small model (local `bge-small`/`e5-small`, or a cheap embeddings API), and query `email_vectors` for the nearest already-labelled emails.

```
neighbors = vector_search(embed(email), k=10)
if top_neighbor.similarity > 0.88 and neighbors_agree(top_k):
    return label = top_neighbor.label, confidence = similarity
```

This is the *correct* way to "learn from my labels": no LLM call, and the moment a user corrects a label, the next similar email is classified right — for free. It quietly absorbs each user's taste. (It's also what makes the Gmail bootstrap in §7 so powerful — you seed this index with their entire labelled history on day one.)

### 3c. Cheap LLM — only the genuinely novel/ambiguous slice

This is where your hard cases live: *"is 'processing your payment' a receipt or just a notice"*, *"does this need action or is it noise"*. Give the model everything you can cheaply extract — and because you own the stack, that includes **attachment text**:

- truncated body + the decisive headers
- **extracted PDF/attachment text** (an itemised invoice is a decisive "real document" signal)
- the user's active **preferences** (§5)
- the 2–3 nearest labelled neighbours as few-shot examples

Demand **structured output** (JSON mode / function calling), and — critically — don't ask for one label. Ask for **orthogonal fields**:

```json
{
  "category": "receipt | statement | notification | marketing | travel | personal | ...",
  "is_real_document": true,        // itemised invoice/receipt/statement present (inline or attached)?
  "requires_action": false,        // ignoring it has consequences?
  "worth_keeping": true,           // reference value beyond ~a week?
  "retention": "keep_1y",          // keep | delete | keep_1y | keep_2y | keep_3y
  "warranty_months": 24,           // if a product receipt mentions/implies a warranty
  "confidence": 0.0,
  "reason": "<= 12 words"
}
```

Splitting these fields is what cleanly solves your examples:
- **Terms-of-Service email** → `notification, requires_action:false, worth_keeping:false → delete`.
- **"Your account will be suspended"** → `requires_action:true → keep` (never auto-delete an actionable warning).
- **"Payment processed", no attached invoice** → `is_real_document:false → delete`.
- **"Payment processed" *with* an itemised invoice PDF** → `is_real_document:true → Receipts, keep`.
- **Product receipt "2-year warranty"** → `worth_keeping:true, warranty_months:24 → keep_2y`.

### 3d. Human review — when confidence is low

Below a threshold, **don't guess** — drop it into a "review" lane in the UI for a one-tap decision. That tap is the highest-value training signal you get (§6). Silent wrong-guessing is what erodes trust; asking is what builds it.

### Orchestration

```
for email in queue:
    r = rules_match(email)                 # 3a
    if r and r.action != 'ai' and r.stop: apply(r); continue
    e = embedding_match(email)             # 3b
    if e.confidence > KEEP_THRESHOLD: apply(e); continue
    a = llm_classify(email, prefs, neighbors)   # 3c
    if a.confidence >= CONF_THRESHOLD: apply(a)
    else: queue_for_review(email)          # 3d
```

Cache LLM decisions by `(from_addr + normalised_subject + content_hash)` so near-identical mail (all those forwarded copies!) classifies **once**.

---

## 4. "Only keep what's worth keeping" — the retention engine

This is the heart of what you want, and it's a first-class subsystem, not a side effect.

**Every classified email gets a `disposition` + `delete_at`.** Default is delete. It becomes "keep" only via one of:

- **The keep set** (worth-keeping categories): real receipts/invoices, warranties, financial statements, tax/company/legal docs, tickets & bookings, visa/immigration, contracts.
- **`is_real_document = true`** (from attachment parsing / itemised-content detection) — the guard that stops bare "payment processed" notices from masquerading as receipts.
- **`requires_action = true`** — actionable mail is never silently deleted.
- **A label whose `keep_default = true`** (from §2).

**Dynamic retention length** comes from the classifier: a product receipt with `warranty_months:24` → `delete_at = received + 24mo` (this *is* your Keep-1/2/3-year system, automated). Statements → 7 years. Tickets → event date + buffer. Marketing/notifications → 7–60 days.

**The engine itself** is a nightly cron:
```sql
UPDATE emails SET state='trashed'
WHERE disposition='delete' AND delete_at < now()
  AND NOT EXISTS (protected label on this email);
```
Move to a recoverable **Trash** (30-day grace), never hard-delete on a first pass. Keep a `protected` class (statements, invoices, legal, staff/PII, anything actionable) that the sweep can never touch — a safety net for classifier mistakes.

> Design rule: it is always safe to keep too long, never safe to delete too early. Bias thresholds accordingly, and make "delete" reversible.

---

## 5. Preferences & prompts — versioned and testable

Your "prompts saved and added later" idea is exactly right; natively it's a proper subsystem:

- **Table of plain-English guidance** (global defaults + per-user overrides), injected into the LLM prompt at classification time. (This is your Preferences tab, verbatim.)
- **Versioned + rollback.** Editing a preference bumps a version; you can revert. Store which preference-version produced each `ai_decision` so you can audit "why did labelling change last Tuesday?"
- **Dry-run before commit.** The killer feature: user writes/edits a rule or preference → system re-runs it against their **last N emails** and shows a diff of what *would* change — *before* it goes live. (You'll recognise why this matters — half the pain in a live system is not knowing whether an edit did what you meant.)

---

## 6. The feedback loop — how it gets smarter

Every manual correction (`corrections` table) fires three things:

1. **Update the embedding index immediately** → similar mail is right next time, for free. (Biggest, cheapest win.)
2. **Detect patterns → suggest rules.** "You've moved 5 emails from `xiaomi.com` to Sale — make it a rule?" One tap promotes a fuzzy, paid AI decision into a free deterministic rule. Over time your `rules` table grows and LLM calls shrink.
3. **Accumulate a training set.** Once you have enough corrections, fine-tune a small local classifier (or a distilled model) to replace the cheap-LLM tier for common cases — driving cost toward zero.

Net effect: **usage makes it cheaper and more accurate**, because work migrates rules ← embeddings ← LLM over time.

---

## 7. Bootstrapping from an existing Gmail (the "learn my rules" feature)

This productizes *exactly* the manual process from this project (scan a Gmail, find which senders map to which labels, generate rules) — as a one-click onboarding step.

**Step 1 — Connect (read-only).** OAuth with `gmail.readonly`. Fetch all user labels (`labels.list`) and, per label, a sample of messages (`messages.list?labelIds=…`) reading sender, domain, subject, headers, snippet, and the *full label set* on each message.

**Step 2 — Analyse.** Build the signal maps:
- **Sender → label consistency.** For each sender/domain, the distribution of labels its mail carries. A sender that lands ≥ ~90% in one label → a **high-confidence deterministic rule** (`from_domain → label`).
- **Mixed senders.** Senders spanning several labels (Google Play, AliExpress, PayPal) → *don't* make a fixed rule; flag them **`action = ai`** (content-judged), and generate a preference describing the split.
- **Subject / keyword patterns.** Tokens that correlate strongly with a label ("receipt", "statement", "terms of service") → keyword rule candidates.
- **Header patterns.** `List-Id` present ↔ a marketing/sale label, etc.

**Step 3 — Propose & preview.** Present the generated rules (mapped to your Rules schema) for review, each with a **dry-run** showing which of their real emails it would catch and how many it agrees/disagrees with. User accepts/edits/rejects.

**Step 4 — Seed the memory (the real magic).** Embed **every labelled email** and load `email_vectors` with `(vector, their_label)`. Now the similarity classifier (§3b) has the user's *entire labelling history* as ground truth from minute one — so even senders/patterns no explicit rule captured are classified by nearest-neighbour to what they've actually done. This is the difference between "here are some starter rules" and "the system already thinks like you."

**Step 5 — Map labels.** Reconcile their Gmail labels to the client's label tree (with `keep_default`/retention inferred from category), then import approved rules → `rules`, guidance → `preferences`.

```
Result of onboarding:
  • deterministic rules for consistent senders
  • ai-routing + preferences for mixed senders
  • an embedding index pre-loaded with their whole labelled history
  • a label tree with sensible keep/delete defaults
→ accurate from day one, and it only sharpens with use.
```

---

## 8. Cost, privacy, ops

- **Cache** LLM decisions by content-hash (dedupes forwarded copies and near-identical mail).
- **Per-user AI budget** with graceful fallback to rules-only when exceeded — no runaway bills.
- **Self-hosted model option.** Since you'd be sending mail content to a model, offer a local classifier (small open model via vLLM/Ollama; embeddings local). For a *webmail product*, "your mail is never sent to a third-party AI" is a real differentiator, not a footnote.
- **Explainability UI.** Show the stored `reason` + `confidence` as a "why this label?" tooltip, and always let the user override. Automation people can *see into* is automation they trust.

---

## 9. Suggested build order

1. **Rules + retention, no AI.** Ingestion worker, rules table, label tree with keep/delete defaults, the nightly retention cron + recoverable trash. This alone is already better than what we built on Gmail.
2. **LLM fallback + preferences.** Add the cheap-LLM tier with structured output and the versioned/dry-runnable preferences. Now the hard "receipt vs notice / action vs noise" cases work.
3. **Embeddings + feedback loop.** Add the vector tier and wire corrections → index + rule suggestions. Now it *learns*.
4. **Gmail bootstrap + fine-tuning.** Ship the onboarding importer (§7); once corrections accumulate, distil a local model to shrink LLM spend further.

Each phase is independently useful, and every later phase makes the system cheaper and smarter than the last.
