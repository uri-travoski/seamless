# Getting started

Seamless is your own mail system: it syncs every account you connect, archives each message as a
raw `.eml` file in your storage, classifies everything with rules + AI, and keeps only what is
worth keeping. Phones and desktop mail apps connect to Seamless itself.

## First 10 minutes

1. **Connect an account** — Settings → Accounts. Use *Connect Gmail / Microsoft* (OAuth) or *Add
   IMAP account* for Apple/iCloud (app-specific password) and traditional servers.
2. **Import your rules spreadsheet** — Settings → Import & Retention → choose the `.xlsx` →
   Preview → Apply. Labels arrive with their retention (e.g. Sale = delete after 10 days),
   rules start classifying immediately.
3. **Enable AI** — Settings → AI. Add a provider (any OpenAI-compatible endpoint) and map the
   *Classify* task (recommended: `gemini-2.5-flash-lite`) and *Embeddings*
   (recommended: Ollama with `nomic-embed-text`). Without AI, deterministic rules still work;
   AI-routed mail waits in the **Review** lane.
4. **Watch the logs** — Settings → Logs shows every classification and what the retention sweep
   *would* delete. Retention starts in **dry run**: nothing is deleted until you switch it live
   in Settings → Import & Retention.

## The philosophy

- **Delete by default, but never silently.** Everything gets a disposition. Mail with a countdown
  shows an orange badge ("10d"). Mark a message unread to protect it forever.
- **It is always safe to keep too long, never safe to delete too early.** Deletions go to Trash
  first (30-day grace), protected labels are never touched, and every action is logged.
- **Every correction teaches it.** Relabel a message and similar mail lands right next time;
  after three corrections on one sender you are offered a permanent rule.
