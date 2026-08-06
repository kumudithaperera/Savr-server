import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createStore } from './lib/store.js';
import { createApifyInstagramScraper } from './services/apify.js';
import { createGeminiRecipeParser } from './services/gemini.js';
import { createPexelsPhotoSearch } from './services/images.js';
import { createGeminiRecipeImprover } from './services/improve.js';
import { createUsdaNutritionLookup } from './services/nutrition.js';
import { createApifyTikTokScraper } from './services/tiktok.js';
import { createWebScraper } from './services/web.js';

const config = loadConfig();

const app = buildApp({
  instagramScraper: createApifyInstagramScraper(config),
  tiktokScraper: createApifyTikTokScraper(config),
  webScraper: createWebScraper(),
  parser: createGeminiRecipeParser(config),
  improver: createGeminiRecipeImprover(config),
  photoSearch: createPexelsPhotoSearch(config),
  nutrition: createUsdaNutritionLookup(config),
  appSharedSecret: config.appSharedSecret,
  store: createStore({ upstashUrl: config.upstashUrl, upstashToken: config.upstashToken }),
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

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then((address) => app.log.info(`Morsel extraction server listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
