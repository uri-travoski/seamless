/** Re-ingest the Cloudflare Worker's spool: raw mail it saved before posting, in case the post failed (F-24). */
import { getInbox, ingestPush } from '../transport/inbound/push.ts';
import { makeStore } from '../s3.ts';
import { activeTarget, toS3Config } from './targets.ts';
import type { BlobStore } from '../s3.ts';

export interface SpoolResult { found: number; ingested: number; skipped: number; failed: number }

/** Worker keys look like `<epoch>-<inbox token>-<rand>.eml`. */
export function tokenFromKey(key: string): string | null {
  const name = key.split('/').pop() ?? '';
  const m = name.match(/^\d+-(.+)-[^-]+\.eml$/);
  return m ? m[1] : null;
}

export async function reingestSpool(store?: BlobStore & { bucket?: string }, prefix?: string): Promise<SpoolResult | null> {
  if (!store) {
    const t = await activeTarget('spool');
    if (!t) return null;
    store = makeStore(toS3Config(t)); prefix = t.prefix;
  }
  const res: SpoolResult = { found: 0, ingested: 0, skipped: 0, failed: 0 };
  const keys = (await store.list(prefix ?? '')).filter((k) => k.endsWith('.eml'));
  res.found = keys.length;
  for (const key of keys) {
    const token = tokenFromKey(key);
    const inbox = token ? await getInbox(token) : null;
    if (!inbox) { res.skipped++; continue; }
    try {
      const raw = await store.get(key);
      // same path as a live push: disposable rules and Message-ID+sha256 dedupe apply, so repeating is safe
      const r = await ingestPush(inbox, raw, null);
      if (r.status === 202) res.ingested++; else if (r.status === 500) res.failed++; else res.skipped++;
    } catch { res.failed++; }
  }
  return res;
}
