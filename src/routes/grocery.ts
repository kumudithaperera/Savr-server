import type { FastifyInstance } from 'fastify';

import { foodProfileCacheKey } from '../lib/ai-cache.js';
import { countAi } from '../lib/ai-stats.js';
import { atCapacity, HttpError, rateLimited, unprocessable } from '../lib/errors.js';
import { deviceIdOf } from '../lib/grants.js';
import { DAY_TTL_SECONDS, dayKey } from '../lib/period.js';
import type { Store } from '../lib/store.js';
import type { FoodProfileDto, FoodProfiler } from '../services/food-profiles.js';

/**
 * Grocery list: shopping weights for foods the app's own table doesn't know
 * (`POST /grocery/profiles`), so "3 cups okra" can be bought as "300 g".
 *
 * Asked per food, never per recipe, and every answer is cached for everyone:
 * what a cup of okra weighs doesn't change, so once anyone's list has asked,
 * nobody's does again. A food the model couldn't weigh is cached too, for
 * less time, so a one-off key isn't asked about on every list.
 */

export interface GroceryDeps {
  store: Store;
  /** Omitted = the route answers 503 and the app keeps its built-in table. */
  foodProfiler?: FoodProfiler;
}

export const GROCERY_LIMITS = {
  maxKeys: 30,
  maxKeyLength: 40,
  /** Requests per install per day. A list only asks about new foods, once. */
  deviceDaily: 20,
  /** Model calls per day for everyone; past it, the app simply keeps cups. */
  globalDaily: 300,
} as const;

const PROFILE_TTL_SECONDS = 365 * 24 * 60 * 60;
const UNKNOWN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Lower-case words, spaces, hyphens and apostrophes: what a canonical key looks like. */
const KEY_PATTERN = /^[\p{L}][\p{L} '-]*$/u;

/** A cached answer: null is "asked, couldn't weigh it". */
type Cached = { profile: FoodProfileDto | null };

/** Validates the body into distinct normalized keys. Exported for tests. */
export function parseKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw unprocessable("'keys' must be an array.");
  if (raw.length > GROCERY_LIMITS.maxKeys) {
    throw unprocessable(`'keys' must not exceed ${GROCERY_LIMITS.maxKeys} entries.`);
  }
  const keys = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') throw unprocessable("'keys' must be strings.");
    const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key || key.length > GROCERY_LIMITS.maxKeyLength || !KEY_PATTERN.test(key)) {
      throw unprocessable('Each key must be a short food name.');
    }
    keys.add(key);
  }
  return [...keys];
}

export function registerGroceryRoutes(app: FastifyInstance, deps: GroceryDeps): void {
  const { store, foodProfiler } = deps;

  app.post<{ Body: { keys?: unknown } }>('/grocery/profiles', async (request) => {
    if (!foodProfiler) throw new HttpError(503, 'unavailable', 'Food weights are unavailable right now.');
    const keys = parseKeys(request.body?.keys);

    const profiles: Record<string, FoodProfileDto | null> = {};
    const missing: string[] = [];
    for (const key of keys) {
      const cached = await store.getJson<Cached>(foodProfileCacheKey(key));
      if (cached) profiles[key] = cached.profile;
      else missing.push(key);
    }
    if (keys.length > missing.length) await countAi(store, 'foodProfileCacheHit', keys.length - missing.length);
    if (missing.length === 0) return { profiles };

    // Charged per request that reaches the model, before the call: a failed
    // call is still billed (see `/improve`). Cache hits cost nothing.
    const day = dayKey(new Date());
    const mine = await store.incrWithTtl(`q:food:${deviceIdOf(request)}:${day}`, DAY_TTL_SECONDS);
    if (mine > GROCERY_LIMITS.deviceDaily) {
      throw rateLimited('Too many food lookups today. Please try again tomorrow.');
    }
    const today = await store.incrWithTtl(`g:day:food:${day}`, DAY_TTL_SECONDS);
    if (today > GROCERY_LIMITS.globalDaily) {
      request.log.warn({ today }, 'global daily food profile ceiling reached');
      throw atCapacity('Food weights are at capacity today.');
    }

    await countAi(store, 'foodProfile');
    const answered = await foodProfiler.profile(missing);
    for (const key of missing) {
      const profile = answered[key] ?? null;
      profiles[key] = profile;
      try {
        const cached: Cached = { profile };
        await store.setJson(foodProfileCacheKey(key), cached, profile ? PROFILE_TTL_SECONDS : UNKNOWN_TTL_SECONDS);
      } catch {
        // the cache is an optimisation
      }
    }
    return { profiles };
  });
}
