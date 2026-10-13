import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { InstagramScraper } from '../services/apify.js';
import type { DeepSeekRecipeParser, DeepSeekResult } from '../services/deepseek.js';
import type { RecipeParser } from '../services/gemini.js';
import type { VideoRecipeParser } from '../services/gemini-video.js';
import type { TikTokScraper } from '../services/tiktok.js';
import type { WebScraper } from '../services/web.js';
import { assessCaption, assessCompleteness } from '../lib/completeness.js';
import { resolveEntitlement } from '../lib/entitlement.js';
import { HttpError, atCapacity, quotaExceeded, unprocessable } from '../lib/errors.js';
import { deviceIdOf } from '../lib/grants.js';
import { mergeRecipes } from '../lib/merge.js';
import { normalizeRecipe } from '../lib/normalize.js';
import { DAY_TTL_SECONDS, MONTH_TTL_SECONDS, dayKey, monthKey } from '../lib/period.js';
import type { DiscoverIndexer } from '../lib/discover-indexer.js';
import type { Store } from '../lib/store.js';
import type { Supabase } from '../lib/supabase.js';
import type { ExtractedRecipe, ParsedRecipe, ScrapedPost } from '../lib/types.js';
import { validateExtractedRecipe } from '../lib/validate.js';
import {
  assertExtractableUrl,
  assertHttpUrl,
  cacheKeyFromShortcode,
  canonicalCacheKey,
  detectPlatform,
} from '../lib/url.js';

/** Limits applied to metered (AI) extractions. Web & blog links skip all of them. */
export interface ExtractLimits {
  monthlyDeviceExtractionLimit: number;
  /** Applied instead of the above when the install holds a Plus grant. */
  plusDeviceExtractionLimit: number;
  globalDailyExtractionLimit: number;
  extractCacheTtlDays: number;
}

interface ExtractDeps {
  instagramScraper: InstagramScraper;
  tiktokScraper: TikTokScraper;
  webScraper: WebScraper;
  /** Level 2: Gemini text parser, used when DeepSeek is unavailable or insufficient. */
  parser: RecipeParser;
  /** Level 1: DeepSeek text parser - cheap, tried first to hold down Gemini usage. */
  deepseekParser?: DeepSeekRecipeParser;
  /** Level 3: Video-understanding parser for multimodal fallback. */
  videoParser?: VideoRecipeParser;
  /** Whether video fallback is enabled. Default: true if videoParser is provided. */
  videoFallbackEnabled?: boolean;
  store: Store;
  limits: ExtractLimits;
  /** Subscription lookup behind the cap; unconfigured = redeem codes only. */
  supabase: Supabase;
  /** Copies each fresh extraction into Discover's search index. Absent = off. */
  indexer?: DiscoverIndexer;
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

/**
 * Extraction-output version, mixed into every cache key.
 *
 * Entries live for a year (`extractCacheTtlDays`), so without this a change to
 * the Gemini prompt or to normalization would be invisible for every post that
 * had already been extracted - the old output keeps being served until the TTL
 * runs out. **Bump this whenever the prompt or normalization changes.** Old
 * entries are simply orphaned and expire on their own.
 *
 * v2: prompt now preserves the source language and original ingredient names,
 * and refuses to invent a recipe (`isRecipe`), so v1 entries include both
 * silently-translated recipes and hallucinated ones.
 */
const EXTRACT_VERSION = 'v2';

/**
 * Cache key for a canonical post identity (see `canonicalCacheKey`). Hashed to
 * keep keys short and opaque.
 */
export function cacheKey(canonical: string): string {
  const versioned = `${EXTRACT_VERSION}:${canonical}`;
  return `cache:extract:${createHash('sha256').update(versioned).digest('hex')}`;
}

/** Monthly cache hit/miss counters, so the cache's payoff is measurable. */
const STATS_TTL_SECONDS = 60 * 24 * 60 * 60;
export const statsKey = (kind: 'hit' | 'miss', now: Date) =>
  `stats:${kind}:${monthKey(now)}`;

/** Monthly video fallback counters for tracking usage and success rate. */
export const fallbackStatsKey = (kind: 'triggered' | 'success' | 'failed', now: Date) =>
  `stats:fallback:${kind}:${monthKey(now)}`;

/** Monthly DeepSeek (Level 1) counters for tracking usage and success rate. */
export const deepseekStatsKey = (kind: 'triggered' | 'success' | 'insufficient' | 'failed', now: Date) =>
  `stats:deepseek:${kind}:${monthKey(now)}`;

/**
 * Level 1: Attempts DeepSeek text-based extraction - tried first since it's
 * the cheapest of the three levels. Returns the result with a sufficiency
 * assessment, or null if DeepSeek is unavailable.
 */
async function tryDeepSeekExtraction(
  deps: ExtractDeps,
  scraped: ScrapedPost,
  primaryParsed: ParsedRecipe | null,
  request: { log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void } },
  now: Date,
  store: Store,
): Promise<DeepSeekResult | null> {
  if (!deps.deepseekParser) {
    return null;
  }

  // Only call DeepSeek if there's meaningful text to analyze
  if (!scraped.caption.trim()) {
    request.log.info({}, 'DeepSeek skipped: no text available');
    return null;
  }

  await store.incrWithTtl(deepseekStatsKey('triggered', now), STATS_TTL_SECONDS);
  request.log.info({}, 'triggering DeepSeek text extraction (Level 1)');

  try {
    const result = await deps.deepseekParser.parseText(
      scraped.caption,
      primaryParsed ?? undefined,
    );

    if (result.recipe.isRecipe === false) {
      request.log.info({}, 'DeepSeek: text does not contain a recipe');
      await store.incrWithTtl(deepseekStatsKey('insufficient', now), STATS_TTL_SECONDS);
      return result;
    }

    if (result.sufficient) {
      await store.incrWithTtl(deepseekStatsKey('success', now), STATS_TTL_SECONDS);
      request.log.info(
        {
          confidence: result.confidence,
          ingredientCount: result.recipe.ingredients.length,
          stepCount: result.recipe.steps.length,
        },
        'DeepSeek extraction sufficient',
      );
    } else {
      await store.incrWithTtl(deepseekStatsKey('insufficient', now), STATS_TTL_SECONDS);
      request.log.info(
        {
          confidence: result.confidence,
          missing: result.missing,
        },
        'DeepSeek extraction insufficient, may need video fallback',
      );
    }

    return result;
  } catch (err) {
    request.log.warn(
      { error: (err as Error).message },
      'DeepSeek extraction failed',
    );
    await store.incrWithTtl(deepseekStatsKey('failed', now), STATS_TTL_SECONDS);
    return null;
  }
}

/**
 * Level 3: Attempts video fallback extraction when text-based extraction is insufficient.
 * Returns null if video fallback is disabled, unavailable, or fails.
 */
async function tryVideoFallback(
  deps: ExtractDeps,
  scraped: ScrapedPost,
  primaryParsed: ParsedRecipe | null,
  request: { log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void } },
  now: Date,
  store: Store,
): Promise<ParsedRecipe | null> {
  const videoFallbackEnabled = deps.videoFallbackEnabled ?? Boolean(deps.videoParser);

  if (!videoFallbackEnabled || !deps.videoParser) {
    return null;
  }

  if (!scraped.videoUrl) {
    request.log.info({ hasVideoUrl: false }, 'video fallback skipped: no video URL');
    return null;
  }

  await store.incrWithTtl(fallbackStatsKey('triggered', now), STATS_TTL_SECONDS);
  request.log.info({ videoUrl: scraped.videoUrl }, 'triggering video fallback extraction');

  try {
    const videoParsed = await deps.videoParser.parseVideo(
      scraped.videoUrl,
      scraped.caption,
      primaryParsed ?? undefined,
    );

    if (videoParsed.isRecipe === false) {
      request.log.info({}, 'video fallback: video analysis found no recipe');
      await store.incrWithTtl(fallbackStatsKey('failed', now), STATS_TTL_SECONDS);
      return null;
    }

    await store.incrWithTtl(fallbackStatsKey('success', now), STATS_TTL_SECONDS);
    request.log.info(
      { ingredientCount: videoParsed.ingredients.length, stepCount: videoParsed.steps.length },
      'video fallback extraction succeeded',
    );
    return videoParsed;
  } catch (err) {
    request.log.warn(
      { error: (err as Error).message },
      'video fallback extraction failed',
    );
    await store.incrWithTtl(fallbackStatsKey('failed', now), STATS_TTL_SECONDS);
    return null;
  }
}

/**
 * Registers `POST /extract`. The pipeline: validate URL -> serve from cache if
 * we've seen this link -> meter (global circuit breaker, then per-device monthly
 * quota) for Instagram/TikTok only -> pick the scraper -> DeepSeek text parse,
 * then Gemini text parse if that's insufficient, then Gemini video analysis if
 * both are (skipping straight to video when the caption is already known-bad)
 * -> merge results -> normalize -> cache -> return ExtractedRecipe. Error
 * mapping is handled centrally.
 */
export function registerExtractRoute(app: FastifyInstance, deps: ExtractDeps): void {
  const { store, limits, supabase } = deps;
  const cacheTtlSeconds = limits.extractCacheTtlDays * 24 * 60 * 60;

  app.post<{ Body: { url?: unknown } }>('/extract', async (request) => {
    const url = assertHttpUrl(request.body?.url);
    const platform = detectPlatform(url);
    // Reject links we can already tell won't work (a profile instead of a post,
    // a YouTube link) before the cache lookup and before any metering, so the
    // user gets a message naming the real problem and pays nothing for it.
    assertExtractableUrl(url, platform);
    const now = new Date();

    // Key on the post's identity, not the link's text: the same reel shared
    // three ways is one cache entry, so the first extraction serves everyone.
    const canonical = canonicalCacheKey(url, platform);

    // A cache hit costs nothing, so it must not consume the caller's quota or
    // the daily budget. This is also what neuters "hammer one link" abuse.
    const cached = await store.getJson<ExtractedRecipe>(cacheKey(canonical));
    if (cached) {
      request.log.info({ url, canonical, platform, cacheHit: true }, 'extract served from cache');
      await store.incrWithTtl(statsKey('hit', now), STATS_TTL_SECONDS);
      // Hand back the caller's own link rather than whoever extracted it first,
      // so their local duplicate detection matches what they actually pasted.
      return { ...cached, sourceUrl: url };
    }
    await store.incrWithTtl(statsKey('miss', now), STATS_TTL_SECONDS);

    const metered = isMetered(platform);
    const deviceId = deviceIdOf(request);

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
      // over the cap never triggers a paid scrape. The cap comes from records
      // this server wrote - the grant it stored at redemption, and the
      // subscription the RevenueCat webhook wrote into Supabase - never from
      // anything the client claims about its plan. This is the one Plus benefit
      // that costs real money.
      const entitlement = await resolveEntitlement({ store, supabase }, request, now.getTime());
      const limit = entitlement.plus
        ? limits.plusDeviceExtractionLimit
        : limits.monthlyDeviceExtractionLimit;

      // The counter stays keyed on the install, never on the signed-in user,
      // even though the *limit* now depends on who is signed in. Switching the
      // bucket on sign-in would hand someone a second free allowance for the
      // cost of signing out.
      const used = await store.getJson<number>(`q:dev:${deviceId}:${monthKey(now)}`);
      if ((used ?? 0) >= limit) {
        throw quotaExceeded(
          `You've used all ${limit} AI extractions this month. Blog & website recipes are still unlimited.`,
        );
      }
    }

    const scraped = await scraperFor(platform, deps).scrape(url);

    // =========================================================================
    // THREE-LEVEL EXTRACTION ARCHITECTURE
    // Level 1: DeepSeek text analysis (cheap, tried first to hold down Gemini usage)
    // Level 2: Gemini text parse (if DeepSeek is unavailable or insufficient)
    // Level 3: Gemini video fallback (expensive, if Level 1+2 insufficient)
    //
    // A caption already known to be unusable (empty, or just hashtags/emoji -
    // `assessCaption`) skips straight to Level 3 when a video exists: apify/
    // tiktok have already rejected the no-video case outright, so spending two
    // text-LLM calls that can't succeed only delays the call that can.
    // =========================================================================

    const captionVerdict = assessCaption(scraped.caption);
    // Only worth skipping the text levels when there's a video to fall back on -
    // otherwise a known-bad caption still deserves a shot from both text parsers
    // (the isRecipe flag is the real backstop for junk), since throwing outright
    // with no video is strictly worse than trying and failing.
    const skipTextLevels = captionVerdict !== 'ok' && Boolean(scraped.videoUrl);

    let primaryParsed: ParsedRecipe | null = null;
    let primaryError: Error | null = null;
    let deepseekResult: DeepSeekResult | null = null;

    if (skipTextLevels) {
      request.log.info(
        { captionVerdict },
        'caption already known-bad - skipping Levels 1-2, going straight to Level 3 video',
      );
    } else {
      // LEVEL 1: DeepSeek text analysis - cheap, tried first.
      if (scraped.caption.trim()) {
        deepseekResult = await tryDeepSeekExtraction(deps, scraped, null, request, now, store);
      } else {
        request.log.info({}, 'Level 1: no caption available');
      }
    }

    const level1Sufficient = Boolean(
      deepseekResult?.sufficient && deepseekResult.recipe.isRecipe !== false,
    );
    if (level1Sufficient && deepseekResult) {
      request.log.info(
        { confidence: deepseekResult.confidence },
        'Level 1 (DeepSeek) extraction sufficient - stopping',
      );
    }

    // LEVEL 2: Gemini text parse - only spent when DeepSeek couldn't close it
    // out (or isn't configured), and only when the caption wasn't already
    // known-bad with a video to fall back on instead.
    if (!level1Sufficient && !skipTextLevels && scraped.caption.trim()) {
      try {
        primaryParsed = await deps.parser.parse(scraped.caption);
      } catch (err) {
        primaryError = err as Error;
        request.log.info(
          { error: primaryError.message },
          'Level 2 (Gemini text) extraction failed',
        );
      }
    }

    let level2Sufficient = false;
    if (!level1Sufficient && primaryParsed && primaryParsed.isRecipe !== false) {
      const completeness = assessCompleteness(scraped, primaryParsed);
      level2Sufficient = completeness.isComplete && completeness.confidence >= 0.6;
      if (level2Sufficient) {
        request.log.info(
          {
            confidence: completeness.confidence,
            ingredientCount: completeness.details.ingredientCount,
            stepCount: completeness.details.stepCount,
          },
          'Level 2 (Gemini text) extraction sufficient - stopping',
        );
      }
    }

    let finalParsed: ParsedRecipe;

    if (level1Sufficient && deepseekResult) {
      finalParsed = deepseekResult.recipe;
    } else if (level2Sufficient && primaryParsed) {
      finalParsed = primaryParsed;
    } else {
      // LEVEL 3: Gemini video fallback (if video URL available)
      const needsVideo = Boolean(scraped.videoUrl);
      let videoParsed: ParsedRecipe | null = null;

      if (needsVideo) {
        const bestTextResult = primaryParsed ?? deepseekResult?.recipe ?? null;
        request.log.info(
          {
            reason: skipTextLevels
              ? 'caption_known_bad'
              : primaryParsed
                ? 'gemini_insufficient'
                : 'no_text_result',
          },
          'proceeding to Level 3 (Gemini video)',
        );
        videoParsed = await tryVideoFallback(deps, scraped, bestTextResult, request, now, store);
      }

      // Determine final result from all levels
      if (videoParsed && videoParsed.isRecipe !== false) {
        // Merge video result with best text result if both available
        const bestTextResult = primaryParsed ?? deepseekResult?.recipe ?? null;
        if (bestTextResult && bestTextResult.isRecipe !== false) {
          const merged = mergeRecipes(bestTextResult, videoParsed);
          request.log.info(
            {
              videoContributions: merged.videoContributions,
              mergedConfidence: merged.mergedConfidence,
            },
            'merged text and video extraction results',
          );
          finalParsed = merged;
        } else {
          finalParsed = videoParsed;
        }
      } else if (primaryParsed && primaryParsed.isRecipe !== false) {
        // Fall back to the Gemini text result
        finalParsed = primaryParsed;
      } else if (deepseekResult?.recipe && deepseekResult.recipe.isRecipe !== false) {
        // DeepSeek had something even if not "sufficient"
        finalParsed = deepseekResult.recipe;
      } else {
        // No usable result from any level
        if (primaryError) {
          throw primaryError;
        }
        throw unprocessable(
          'Could not extract a recipe from this link. The video may not contain a recipe, ' +
          'or the content could not be analyzed.',
          'not_a_recipe',
        );
      }
    }

    const recipe = normalizeRecipe(url, platform, scraped, finalParsed);

    // INVARIANT: only a confidently-parsed recipe is ever cached. Every rejection
    // upstream of here throws - the link check, the caption gate in the scraper,
    // and `isRecipe: false` in normalization - so an uncertain result can't reach
    // this line. That matters because an entry written here is keyed on the post,
    // lives for a year, and is then served to everyone who pastes that link: one
    // cached guess becomes the permanent answer for that post.
    //
    // Defensive shape check on the wire format. normalizeRecipe sanitises and
    // defaults every field, so this should never fail; if it does, the recipe is
    // rejected rather than cached and served as-is.
    const validated = validateExtractedRecipe(recipe);
    if (!validated.success) {
      request.log.error(
        { url, errors: validated.errors },
        'normalization produced an invalid ExtractedRecipe',
      );
      throw new HttpError(500, 'internal_error', 'Something went wrong.');
    }

    await store.setJson(cacheKey(canonical), recipe, cacheTtlSeconds);

    // A short link (vm.tiktok.com/…) can't be canonicalised before scraping,
    // but the scraper hands back the platform's own id. Writing an alias under
    // that id means the next person who pastes the full URL gets a free hit.
    const alias = cacheKeyFromShortcode(platform, scraped.shortcode);
    if (alias && alias !== canonical) {
      await store.setJson(cacheKey(alias), recipe, cacheTtlSeconds);
    }

    // Discover: make this extraction searchable for everyone. Fire-and-forget -
    // indexing (and its classify call) must never slow down or fail the
    // response. The platform id beats a short link's path as the identity.
    void deps.indexer?.index(alias ?? canonical, recipe, scraped.ownerUsername, request.log);
    // Charged only on success, so a failed extraction never burns an allowance.
    // The global counter above is incremented up front instead, because a failed
    // attempt still costs us money upstream.
    if (metered) {
      await store.incrWithTtl(`q:dev:${deviceId}:${monthKey(now)}`, MONTH_TTL_SECONDS);
    }

    return recipe;
  });
}
