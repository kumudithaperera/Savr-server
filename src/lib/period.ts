/**
 * Calendar-period keys and their TTLs, shared by every counter that resets on a
 * boundary rather than on a rolling window (the per-device monthly quota, the
 * per-route daily circuit breakers, the cache-hit stats).
 *
 * All of them are UTC. A local-time boundary would move the reset under a user
 * as they travel and, worse, would differ between this server and anything else
 * reading the same key.
 */

/** `YYYY-MM`, the bucket a monthly allowance is counted in. */
export function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM-DD`, the bucket a daily ceiling is counted in. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * TTLs deliberately outlive their period. The key already carries the period, so
 * a stale entry is never read - the slack just means a clock skew or a late
 * write can't expire the bucket someone is still counting in.
 */
export const MONTH_TTL_SECONDS = 35 * 24 * 60 * 60;
export const DAY_TTL_SECONDS = 48 * 60 * 60;
