import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Store } from './store.js';

/**
 * Lightweight, dependency-free protection for the routes that spend something on
 * our behalf - `/extract` and `/improve` (Apify/Gemini), plus `/image-search`
 * and `/nutrition`, which hold the Pexels and USDA keys the app used to ship in
 * its bundle:
 *
 *  1. Shared-secret header — the app sends `x-morsel-app-key`; requests without
 *     the matching value are rejected 401. (Baked into the app bundle, so not a
 *     true secret, but it stops trivial `curl` abuse. Play Integrity attestation
 *     is the real fix — see the extraction-limits roadmap.)
 *  2. Per-IP rate limit — a fixed window held in the shared store, so it
 *     survives the cold starts and redeploys of a free Render instance and stays
 *     correct if we ever run more than one instance.
 *
 * This runs as an `onRequest` hook, which fires *before* body parsing, so it can
 * only do URL-independent checks. The per-device monthly quota and the global
 * daily circuit breaker need the link to tell a metered Instagram/TikTok URL
 * from an unlimited web one, so they live in the extract route instead.
 */

const PROTECTED_PATHS = new Set(['/extract', '/improve', '/image-search', '/nutrition']);
const APP_KEY_HEADER = 'x-morsel-app-key';

/**
 * Constant-time secret comparison. `!==` leaks the length of the matching prefix
 * through response timing, which is enough to recover a secret byte by byte given
 * enough samples. Length is compared first (and unavoidably leaks) because
 * `timingSafeEqual` throws on mismatched buffer lengths.
 */
function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface RateLimitOptions {
  /** Max requests allowed per IP within the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { max: 30, windowMs: 60_000 };

/**
 * Builds an `onRequest` hook enforcing the shared secret + per-IP rate limit on
 * the protected paths. Other routes (e.g. `/health`) pass through untouched.
 */
export function createRequestGuard(
  appSharedSecret: string,
  store: Store,
  rateLimit: RateLimitOptions = DEFAULT_RATE_LIMIT,
) {
  const windowSeconds = Math.ceil(rateLimit.windowMs / 1000);

  async function rateLimited(ip: string, now: number): Promise<boolean> {
    // Bucket by window start so each window gets its own self-expiring key.
    const windowStart = Math.floor(now / rateLimit.windowMs);
    const count = await store.incrWithTtl(`rl:ip:${ip}:${windowStart}`, windowSeconds);
    return count > rateLimit.max;
  }

  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split('?')[0];
    if (!PROTECTED_PATHS.has(path)) return;

    if (appSharedSecret) {
      const provided = request.headers[APP_KEY_HEADER];
      if (!secretMatches(provided, appSharedSecret)) {
        await reply.status(401).send({ code: 'unauthorized', message: 'Invalid or missing app key.' });
        return;
      }
    }

    if (await rateLimited(request.ip, Date.now())) {
      await reply
        .status(429)
        .send({ code: 'rate_limited', message: 'Too many requests. Please try again shortly.' });
    }
  };
}
