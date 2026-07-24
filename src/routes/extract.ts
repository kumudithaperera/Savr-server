import { createHash } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { InstagramScraper } from '../services/apify.js';
import type { RecipeParser } from '../services/gemini.js';
import type { TikTokScraper } from '../services/tiktok.js';
import type { WebScraper } from '../services/web.js';
import { atCapacity, quotaExceeded } from '../lib/errors.js';
import { normalizeRecipe } from '../lib/normalize.js';
import type { Store } from '../lib/store.js';
import type { ExtractedRecipe } from '../lib/types.js';
import { assertHttpUrl, detectPlatform } from '../lib/url.js';

const DEVICE_ID_HEADER = 'x-morsel-device-id';

/** Limits applied to metered (AI) extractions. Web & blog links skip all of them. */
export interface ExtractLimits {
  monthlyDeviceExtractionLimit: number;
  globalDailyExtractionLimit: number;
  extractCacheTtlDays: number;
}

interface ExtractDeps {
  instagramScraper: InstagramScraper;
  tiktokScraper: TikTokScraper;
  webScraper: WebScraper;
  parser: RecipeParser;
  store: Store;
  limits: ExtractLimits;
}

/** Picks the scraper for a link's origin. */
function scraperFor(
  platform: ReturnType<typeof detectPlatform>,
  deps: ExtractDeps,
) {
  if (platform === 'instagram') return deps.instagramScraper;
  if (platform === 'tiktok') return deps.tiktokScraper;
  return deps.webScraper;
}

/**
 * Whether this link costs us an AI extraction. Instagram/TikTok need a paid
 * scrape plus heavy Gemini parsing; web & blog pages are cheap and unlimited on
 * every plan. Mirrors `isMeteredExtractionUrl` in the app so the two tallies
 * agree (`Morsel/lib/recipes/url.ts`).
 */
function isMetered(platform: ReturnType<typeof detectPlatform>): boolean {
  return platform === 'instagram' || platform === 'tiktok';
}

/** Stable per-URL cache key. Hashed to keep keys short and opaque. */
function cacheKey(url: string): string {
  return `cache:extract:${createHash('sha256').update(url).digest('hex')}`;
}

/**
 * The calling install, as sent by the app (a hashed ANDROID_ID). Unauthenticated
 * and therefore forgeable — it meters honest users and survives a reinstall,
 * which is the realistic abuse case. Requests without one share a single bucket
 * so an omitted header is not a free pass.
 */
function deviceIdOf(request: FastifyRequest): string {
  const raw = request.headers[DEVICE_ID_HEADER];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value.slice(0, 128) || 'unknown';
}

/** Calendar-month key, matching the app's month-based reset. */
function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const MONTH_TTL_SECONDS = 35 * 24 * 60 * 60;
const DAY_TTL_SECONDS = 48 * 60 * 60;

/**
 * Registers `POST /extract`. The pipeline: validate URL -> serve from cache if
 * we've seen this link -> meter (global circuit breaker, then per-device monthly
 * quota) for Instagram/TikTok only -> pick the scraper -> parse + estimate macros
 * -> normalize -> cache -> return ExtractedRecipe. Error mapping is handled
 * centrally.
 */
export function registerExtractRoute(app: FastifyInstance, deps: ExtractDeps): void {
  const { store, limits } = deps;
  const cacheTtlSeconds = limits.extractCacheTtlDays * 24 * 60 * 60;

  app.post<{ Body: { url?: unknown } }>('/extract', async (request) => {
    const url = assertHttpUrl(request.body?.url);
    const platform = detectPlatform(url);

    // A cache hit costs nothing, so it must not consume the caller's quota or
    // the daily budget. This is also what neuters "hammer one link" abuse.
    const cached = await store.getJson<ExtractedRecipe>(cacheKey(url));
    if (cached) {
      request.log.info({ url, platform, cacheHit: true }, 'extract served from cache');
      return cached;
    }

    const metered = isMetered(platform);
    const deviceId = deviceIdOf(request);
    const now = new Date();

    if (metered) {
      // Global ceiling first: when the service is out of budget for the day,
      // nobody spends, regardless of their personal allowance.
      const today = await store.incrWithTtl(`g:day:${dayKey(now)}`, DAY_TTL_SECONDS);
      if (today > limits.globalDailyExtractionLimit) {
        request.log.warn({ today }, 'global daily extraction ceiling reached');
        throw atCapacity(
          "Morsel is at capacity today. Please try again tomorrow - blog & website links still work.",
        );
      }

      // Then the caller's own monthly allowance. Read before the work so a user
      // over the cap never triggers a paid scrape.
      const used = await store.getJson<number>(`q:dev:${deviceId}:${monthKey(now)}`);
      if ((used ?? 0) >= limits.monthlyDeviceExtractionLimit) {
        throw quotaExceeded(
          `You've used all ${limits.monthlyDeviceExtractionLimit} AI extractions this month. Blog & website recipes are still unlimited.`,
        );
      }
    }

    const scraped = await scraperFor(platform, deps).scrape(url);
    const parsed = await deps.parser.parse(scraped.caption);
    const recipe = normalizeRecipe(url, platform, scraped, parsed);

    await store.setJson(cacheKey(url), recipe, cacheTtlSeconds);
    // Charged only on success, so a failed extraction never burns an allowance.
    // The global counter above is incremented up front instead, because a failed
    // attempt still costs us money upstream.
    if (metered) {
      await store.incrWithTtl(`q:dev:${deviceId}:${monthKey(now)}`, MONTH_TTL_SECONDS);
    }

    return recipe;
  });
}
