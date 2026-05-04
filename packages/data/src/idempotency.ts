// Redis-backed idempotency wrapper with 24h TTL.
// In-memory fallback when SMAYA_REDIS != "1".
//
// Contract: callers compute a stable key (e.g. `mcp:voice-call:c01:run42`) and the
// wrapper returns the previous result if seen, or runs once and caches.

const TTL_MS_DEFAULT = 24 * 60 * 60 * 1000;

export interface IdempotencyStore {
  getOrPut<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<{ value: T; replayed: boolean }>;
  /** For tests / introspection. */
  has(key: string): Promise<boolean>;
}

export class InMemoryIdempotency implements IdempotencyStore {
  private cache = new Map<string, { value: unknown; expiresAt: number }>();

  async getOrPut<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<{ value: T; replayed: boolean }> {
    const now = Date.now();
    const existing = this.cache.get(key);
    if (existing && existing.expiresAt > now) {
      return { value: existing.value as T, replayed: true };
    }
    const value = await compute();
    this.cache.set(key, { value, expiresAt: now + ttlMs });
    return { value, replayed: false };
  }
  async has(key: string): Promise<boolean> {
    const e = this.cache.get(key);
    return !!e && e.expiresAt > Date.now();
  }
}

export class RedisIdempotency implements IdempotencyStore {
  private clientPromise: Promise<unknown> | null = null;

  private async client(): Promise<{ get: (k: string) => Promise<string | null>; set: (k: string, v: string, opts: { PX: number }) => Promise<unknown>; exists: (k: string) => Promise<number> }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const redis = await import("redis").catch(() => null);
        if (!redis) throw new Error("redis package not installed; SMAYA_REDIS=1 requires it");
        const url = process.env.REDIS_URL ?? "redis://localhost:6379";
        // @ts-expect-error redis exports createClient
        const c = redis.createClient({ url });
        await c.connect();
        return c;
      })();
    }
    return (await this.clientPromise) as never;
  }

  async getOrPut<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<{ value: T; replayed: boolean }> {
    const c = await this.client();
    const cached = await c.get(key);
    if (cached) return { value: JSON.parse(cached) as T, replayed: true };
    const value = await compute();
    await c.set(key, JSON.stringify(value), { PX: ttlMs });
    return { value, replayed: false };
  }
  async has(key: string): Promise<boolean> {
    const c = await this.client();
    return (await c.exists(key)) === 1;
  }
}

let singleton: IdempotencyStore | null = null;

export function getIdempotency(): IdempotencyStore {
  if (singleton) return singleton;
  singleton = process.env.SMAYA_REDIS === "1" ? new RedisIdempotency() : new InMemoryIdempotency();
  return singleton;
}

export function setIdempotency(s: IdempotencyStore): void {
  singleton = s;
}

export const IDEM_TTL_MS = TTL_MS_DEFAULT;
