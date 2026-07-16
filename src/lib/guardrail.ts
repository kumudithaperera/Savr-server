import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Lightweight, dependency-free protection for the expensive routes (`/extract`,
 * `/improve`) so random callers can't run up our Apify/Gemini spend:
 *
 *  1. Shared-secret header — the app sends `x-morsel-app-key`; requests without
 *     the matching value are rejected 401. (Baked into the app, so not a true
 *     secret, but it stops trivial `curl` abuse.)
 *  2. Per-IP rate limit — a fixed-window in-memory counter. Fine for the current
 *     single-instance backend; if we ever run multiple instances this becomes
 *     per-instance and should move to a shared store.
 *
 * This is intentionally NOT a per-user quota — the 50/mo cap is still enforced
 * client-side (see Morsel/lib/recipes). Full server-authoritative per-user
 * quotas are deferred until there's traction (see the extraction-limits roadmap).
 */

const PROTECTED_PATHS = new Set(['/extract', '/improve']);
const APP_KEY_HEADER = 'x-morsel-app-key';

interface RateLimitOptions {
  /** Max requests allowed per IP within the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

const DEFAULT_RATE_LIMIT: RateLimitOptions = { max: 30, windowMs: 60_000 };

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Builds an `onRequest` hook enforcing the shared secret + per-IP rate limit on
 * the protected paths. Other routes (e.g. `/health`) pass through untouched.
 */
export function createRequestGuard(
  appSharedSecret: string,
  rateLimit: RateLimitOptions = DEFAULT_RATE_LIMIT,
) {
  const buckets = new Map<string, Bucket>();

  function rateLimited(ip: string, now: number): boolean {
    const bucket = buckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(ip, { count: 1, resetAt: now + rateLimit.windowMs });
      return false;
    }
    bucket.count += 1;
    return bucket.count > rateLimit.max;
  }

  // Occasionally evict stale buckets so the map can't grow unbounded.
  function sweep(now: number): void {
    if (buckets.size < 1000) return;
    for (const [ip, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(ip);
    }
  }

  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split('?')[0];
    if (!PROTECTED_PATHS.has(path)) return;

    if (appSharedSecret) {
      const provided = request.headers[APP_KEY_HEADER];
      if (provided !== appSharedSecret) {
        await reply.status(401).send({ code: 'unauthorized', message: 'Invalid or missing app key.' });
        return;
      }
    }

    const now = Date.now();
    sweep(now);
    if (rateLimited(request.ip, now)) {
      await reply
        .status(429)
        .send({ code: 'rate_limited', message: 'Too many requests. Please try again shortly.' });
    }
  };
}
