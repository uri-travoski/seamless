/** In-process "something big is running" flags. Maintenance skips itself while any is set (T10.3). */
const busy = new Map<string, number>();

/** Mark `what` busy until the returned function is called. Safe to nest/overlap. */
export function markBusy(what: string): () => void {
  busy.set(what, (busy.get(what) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (busy.get(what) ?? 1) - 1;
    if (n <= 0) busy.delete(what); else busy.set(what, n);
  };
}

export const busyNow = (): string[] => [...busy.keys()];
