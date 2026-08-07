import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createStore } from './lib/store.js';
import { createSupabase } from './lib/supabase.js';
import { createApifyInstagramScraper } from './services/apify.js';
import { createGeminiRecipeParser } from './services/gemini.js';
import { createPexelsPhotoSearch } from './services/images.js';
import { createGeminiRecipeImprover } from './services/improve.js';
import { createUsdaNutritionLookup } from './services/nutrition.js';
import { createApifyTikTokScraper } from './services/tiktok.js';
import { createWebScraper } from './services/web.js';

const config = loadConfig();

const store = createStore({ upstashUrl: config.upstashUrl, upstashToken: config.upstashToken });

const app = buildApp({
  instagramScraper: createApifyInstagramScraper(config),
  tiktokScraper: createApifyTikTokScraper(config),
  webScraper: createWebScraper(),
  parser: createGeminiRecipeParser(config),
  improver: createGeminiRecipeImprover(config),
  photoSearch: createPexelsPhotoSearch(config),
  nutrition: createUsdaNutritionLookup(config),
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

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then((address) => app.log.info(`Morsel extraction server listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
