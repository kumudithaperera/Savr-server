/**
 * Small key/value store for the guardrail counters and the extraction cache.
 *
 * Backed by Upstash Redis over its REST API (plain `fetch`, no client library)
 * so counters survive the cold starts and redeploys that are constant on a free
 * Render instance. When `UPSTASH_REDIS_REST_URL` is unset the store falls back
 * to an in-memory map, which keeps local dev and the test suite working with no
 * account and no network.
 *
 * Every method **fails open**: a store outage logs a warning and behaves like a
 * cache miss / zero count rather than blocking extraction. The backstop against
 * runaway spend is the vendor-side spend cap (Apify account limit, Gemini quota),
 * which cannot fail open. See `server/README.md`.
 */

export interface Store {
  /**
   * Atomically increments `key` and returns the new count, setting `ttlSeconds`
   * on first write so the window/period expires on its own. Returns 0 if the
   * store is unreachable (fail-open: the caller treats it as "no usage yet").
   */
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>;
  /** Reads and parses a JSON value, or null when missing/unreadable. */
  getJson<T>(key: string): Promise<T | null>;
  /** Stores a JSON value with a TTL. Best-effort; failures are swallowed. */
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<void>;
}

export interface StoreConfig {
  /** Upstash REST endpoint, e.g. https://eu1-xxx.upstash.io. Empty = in-memory. */
  upstashUrl: string;
  /** Upstash REST bearer token. */
  upstashToken: string;
}

type Warn = (message: string) => void;

// --- in-memory fallback ---------------------------------------------------

interface Entry {
  value: string;
  expiresAt: number;
}

/**
 * Process-local stand-in for Redis. Values are evicted lazily on read plus a
 * cheap sweep once the map grows, so a long-running dev server can't leak.
 */
function createMemoryStore(): Store {
  const entries = new Map<string, Entry>();

  function read(key: string, now: number): string | null {
    const entry = entries.get(key);
    if (!entry) return null;
    if (now >= entry.expiresAt) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  }

  function sweep(now: number): void {
    if (entries.size < 1000) return;
    for (const [key, entry] of entries) {
      if (now >= entry.expiresAt) entries.delete(key);
    }
  }

  return {
    async incrWithTtl(key, ttlSeconds) {
      const now = Date.now();
      sweep(now);
      const current = read(key, now) == null ? undefined : entries.get(key);
      const next = (current ? Number(current.value) : 0) + 1;
      entries.set(key, {
        value: String(next),
        // Keep the original expiry once the key exists, matching EXPIRE ... NX.
        expiresAt: current ? current.expiresAt : now + ttlSeconds * 1000,
      });
      return next;
    },
    async getJson<T>(key: string) {
      const raw = read(key, Date.now());
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async setJson(key, value, ttlSeconds) {
      entries.set(key, {
        value: JSON.stringify(value),
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    },
  };
}

// --- Upstash REST ---------------------------------------------------------

interface UpstashResult {
  result?: unknown;
  error?: string;
}

function createUpstashStore(config: StoreConfig, warn: Warn): Store {
  const endpoint = config.upstashUrl.replace(/\/$/, '');
  const headers = {
    authorization: `Bearer ${config.upstashToken}`,
    'content-type': 'application/json',
  };

  /** Runs one or more Redis commands in a single round trip. */
  async function pipeline(commands: (string | number)[][]): Promise<UpstashResult[]> {
    const response = await fetch(`${endpoint}/pipeline`, {
      method: 'POST',
      headers,
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      throw new Error(`Upstash responded ${response.status}`);
    }
    return (await response.json()) as UpstashResult[];
  }

  return {
    async incrWithTtl(key, ttlSeconds) {
      try {
        // EXPIRE ... NX only sets the TTL when the key has none, so the window
        // expires a fixed time after the *first* increment rather than sliding.
        const [incr, expire] = await pipeline([
          ['INCR', key],
          ['EXPIRE', key, ttlSeconds, 'NX'],
        ]);
        const count = Number(incr?.result);
        // NX needs Redis 6.2+ and isn't in Upstash's documented command list. If
        // it's rejected, fall back to a plain EXPIRE on the first increment only
        // — without this a rejected NX would leave the key with no TTL at all,
        // so counters would never reset and old windows would accumulate.
        if (expire?.error && count === 1) {
          await pipeline([['EXPIRE', key, ttlSeconds]]);
        }
        return Number.isFinite(count) ? count : 0;
      } catch (err) {
        warn(`[store] INCR ${key} failed, allowing the request: ${(err as Error).message}`);
        return 0;
      }
    },
    async getJson<T>(key: string) {
      try {
        const [get] = await pipeline([['GET', key]]);
        if (typeof get?.result !== 'string') return null;
        return JSON.parse(get.result) as T;
      } catch (err) {
        warn(`[store] GET ${key} failed, treating as a miss: ${(err as Error).message}`);
        return null;
      }
    },
    async setJson(key, value, ttlSeconds) {
      try {
        await pipeline([['SET', key, JSON.stringify(value), 'EX', ttlSeconds]]);
      } catch (err) {
        warn(`[store] SET ${key} failed, continuing without caching: ${(err as Error).message}`);
      }
    },
  };
}

/**
 * Builds the store for the current environment: Upstash when configured,
 * otherwise an in-memory map (local dev and tests).
 */
export function createStore(config: StoreConfig, warn: Warn = console.warn): Store {
  if (!config.upstashUrl || !config.upstashToken) {
    return createMemoryStore();
  }
  return createUpstashStore(config, warn);
}
