/** Brief write pause used while a storage migration flips to the new bucket (F-27). */
let paused = false;
export const setWritesPaused = (v: boolean) => { paused = v; };
export const writesPaused = () => paused;

/** Ingest calls this first: waits (≤ maxMs) while the switch is in progress, then carries on. */
export async function waitIfPaused(maxMs = 30_000): Promise<void> {
  const until = Date.now() + maxMs;
  while (paused && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}
