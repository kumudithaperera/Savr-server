import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createMemoryCommunityDb, createSupabaseCommunityDb } from './lib/community-db.js';
import { SEED_POSTS } from './lib/community-seed.js';
import { createStore } from './lib/store.js';
import { createSupabase } from './lib/supabase.js';
import { createApifyInstagramScraper } from './services/apify.js';
import { createDeepSeekRecipeParser } from './services/deepseek.js';
import { createGeminiRecipeParser } from './services/gemini.js';
import { createGeminiVideoParser } from './services/gemini-video.js';
import { createPexelsPhotoSearch } from './services/images.js';
import { createGeminiRecipeImprover } from './services/improve.js';
import { createGeminiModerator } from './services/moderation.js';
import { createBrandFirstNutritionLookup, createUsdaNutritionLookup, createDeepSeekNutritionLookup } from './services/nutrition.js';
import { createOpenFoodFactsLookup } from './services/openfoodfacts.js';
import { createApifyTikTokScraper } from './services/tiktok.js';
import { createWebScraper } from './services/web.js';

const config = loadConfig();

const store = createStore({ upstashUrl: config.upstashUrl, upstashToken: config.upstashToken });

const app = buildApp({
  instagramScraper: createApifyInstagramScraper(config),
  tiktokScraper: createApifyTikTokScraper(config),
  webScraper: createWebScraper(),
  parser: createGeminiRecipeParser(config),
  deepseekParser: config.deepseekApiKey ? createDeepSeekRecipeParser(config) : undefined,
  videoParser: config.videoFallbackEnabled ? createGeminiVideoParser(config) : undefined,
  videoFallbackEnabled: config.videoFallbackEnabled,
  improver: createGeminiRecipeImprover(config),
  photoSearch: createPexelsPhotoSearch(config),
  nutrition: createBrandFirstNutritionLookup({
    usda: createUsdaNutritionLookup(config),
    off: createOpenFoodFactsLookup({ contactEmail: config.offContactEmail }),
    deepseek: config.deepseekApiKey ? createDeepSeekNutritionLookup(config) : undefined,
  }),
  appSharedSecret: config.appSharedSecret,
  store,
  supabase: createSupabase(
    {
      url: config.supabaseUrl,
      anonKey: config.supabaseAnonKey,
      serviceRoleKey: config.supabaseServiceRoleKey,
    },
    store,
  ),
  revenueCatWebhookSecret: config.revenueCatWebhookSecret,
  revenueCatEntitlementId: config.revenueCatEntitlementId,
  communityDb:
    config.communityDb === 'memory'
      ? createMemoryCommunityDb({ seed: SEED_POSTS })
      : createSupabaseCommunityDb({
          url: config.supabaseUrl,
          serviceRoleKey: config.supabaseServiceRoleKey,
        }),
  moderator: createGeminiModerator(config),
  communityHashPepper: config.communityHashPepper,
  limits: {
    monthlyDeviceExtractionLimit: config.monthlyDeviceExtractionLimit,
    plusDeviceExtractionLimit: config.plusDeviceExtractionLimit,
    globalDailyExtractionLimit: config.globalDailyExtractionLimit,
    extractCacheTtlDays: config.extractCacheTtlDays,
  },
  redeem: {
    plusRedeemCodes: config.plusRedeemCodes,
    plusGrantDays: config.plusGrantDays,
  },
  globalDailyImproveLimit: config.globalDailyImproveLimit,
  rateLimit: { max: config.ipRateLimitMax, windowMs: config.ipRateLimitWindowMs },
});

if (!config.appSharedSecret) {
  app.log.warn(
    'APP_SHARED_SECRET is unset - /extract, /improve, /image-search and /nutrition accept ' +
      'any caller. Fine locally; in a deployed environment set it and match it with the ' +
      "app's EXPO_PUBLIC_APP_KEY.",
  );
}

if (!config.offContactEmail) {
  app.log.warn(
    'OFF_CONTACT_EMAIL is unset - Open Food Facts requests identify as ' +
      "'Morsel/1.0 (no-contact-email)', which violates the API's required " +
      '`AppName/Version (ContactEmail)` User-Agent form and risks a crawler ban. ' +
      'Set it in any deployed environment.',
  );
}

if (!config.upstashUrl) {
  app.log.warn(
    'UPSTASH_REDIS_REST_URL is unset - rate limits, quotas and the extraction cache are in-memory and reset on every restart.',
  );
  if (config.plusRedeemCodes.length > 0) {
    app.log.warn(
      `PLUS_REDEEM_CODES lists ${config.plusRedeemCodes.length} code(s) with no Upstash store - ` +
        'redemption state is in-memory, so every redeploy makes those codes reusable. ' +
        'Configure Upstash before issuing any code.',
    );
  }
}

if (!config.supabaseUrl) {
  app.log.warn(
    'SUPABASE_URL is unset - paid subscriptions are invisible to this server. Redeem codes ' +
      'still work; anyone who bought Morsel Plus is metered at the free extraction cap.',
  );
} else if (!config.supabaseServiceRoleKey) {
  app.log.warn(
    'SUPABASE_SERVICE_ROLE_KEY is unset - /webhooks/revenuecat cannot write, so purchases ' +
      'will never be recorded. Set it in the server environment only (never EXPO_PUBLIC_*).',
  );
}

if (config.supabaseUrl && !config.revenueCatWebhookSecret) {
  app.log.warn(
    'REVENUECAT_WEBHOOK_SECRET is unset - /webhooks/revenuecat rejects every delivery. This ' +
      'endpoint fails closed on purpose: it decides who has paid. Set it here and set the same ' +
      "value as the webhook's Authorization header in the RevenueCat dashboard.",
  );
}

if (config.communityDb === 'memory') {
  app.log.warn('COMMUNITY_DB=memory - the ideas board is in-process and is wiped on every restart. Local dev only.');
} else if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
  app.log.warn(
    'Supabase service role is unset - the ideas board (/community/*) answers 503. Set SUPABASE_URL and ' +
      'SUPABASE_SERVICE_ROLE_KEY and run supabase/003_community.sql, or COMMUNITY_DB=memory locally.',
  );
}
if (!config.communityHashPepper) {
  app.log.warn(
    'COMMUNITY_HASH_PEPPER is unset - board author hashes are a plain hash of the device id. Set a ' +
      'random value before the board goes live, and never change it afterwards (it would lift every ban).',
  );
}

// Log three-level architecture configuration
if (config.deepseekApiKey) {
  app.log.info(
    `Level 2 (DeepSeek) enabled using model: ${config.deepseekModel}. ` +
      'DeepSeek will analyze text when Level 1 is insufficient.',
  );
} else {
  app.log.info(
    'Level 2 (DeepSeek) disabled (DEEPSEEK_API_KEY not set). ' +
      'Extraction will fall through directly to Level 3 (Gemini video) when Level 1 fails.',
  );
}

if (config.videoFallbackEnabled) {
  app.log.info(
    `Level 3 (Gemini video) enabled using model: ${config.geminiVideoModel}. ` +
      'Videos will be analyzed when text extraction is insufficient.',
  );
} else {
  app.log.info(
    'Level 3 (Gemini video) disabled (VIDEO_FALLBACK_ENABLED=false). ' +
      'Video-only content will not be recoverable.',
  );
}

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then((address) => app.log.info(`Morsel extraction server listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
