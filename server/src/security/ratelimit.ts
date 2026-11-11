/**
 * Small in-process rate limiter (fixed window per key, LRU-capped so a flood of distinct
 * keys can't grow memory without bound). One process serves an instance, so in-memory is
 * enough; a restart forgives everyone, which is acceptable for these limits.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private limit: number, private windowMs: number, private maxKeys = 50_000) {}

  /** Count one hit for `key`. Returns false once the key is over the limit for this window. */
  hit(key: string, now = Date.now()): boolean {
    const e = this.peekEntry(key, now);
    e.count++;
    this.hits.delete(key);           // re-insert: Map order = recency
    this.hits.set(key, e);
    if (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return e.count <= this.limit;
  }

  /** True when the key is already over the limit (without counting a hit). */
  blocked(key: string, now = Date.now()): boolean {
    return this.peekEntry(key, now).count >= this.limit;
  }

  reset(key: string): void { this.hits.delete(key); }

  clear(): void { this.hits.clear(); }

  private peekEntry(key: string, now: number) {
    let e = this.hits.get(key);
    if (!e || now > e.resetAt) e = { count: 0, resetAt: now + this.windowMs };
    return e;
  }
}

/** Login / setup / 2FA: 10 attempts per 15 minutes, counted per IP and per email. */
export const authLimiter = new RateLimiter(10, 15 * 60_000);

/** Tracking pixel: 30 recorded hits per minute per token. */
export const pixelLimiter = new RateLimiter(30, 60_000);

/** Same IP hitting the same pixel within 60 s: stored once more but not re-broadcast. */
export const pixelDedupe = new RateLimiter(1, 60_000);

/** Push-inbound endpoint: 20 bad signatures per 15 minutes per IP+token, then 429. */
export const ingestFailLimiter = new RateLimiter(20, 15 * 60_000);

/** Push-inbound endpoint: 600 accepted posts per minute per token. */
export const ingestLimiter = new RateLimiter(600, 60_000);

/** REST v1 (T5 F-37): 600 calls per minute per API token, then 429. */
export const apiLimiter = new RateLimiter(600, 60_000);
