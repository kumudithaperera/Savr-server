import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createStore } from './lib/store.js';
import { createApifyInstagramScraper } from './services/apify.js';
import { createGeminiRecipeParser } from './services/gemini.js';
import { createGeminiRecipeImprover } from './services/improve.js';
import { createApifyTikTokScraper } from './services/tiktok.js';
import { createWebScraper } from './services/web.js';

const config = loadConfig();

const app = buildApp({
  instagramScraper: createApifyInstagramScraper(config),
  tiktokScraper: createApifyTikTokScraper(config),
  webScraper: createWebScraper(),
  parser: createGeminiRecipeParser(config),
  improver: createGeminiRecipeImprover(config),
  appSharedSecret: config.appSharedSecret,
  store: createStore({ upstashUrl: config.upstashUrl, upstashToken: config.upstashToken }),
  limits: {
    monthlyDeviceExtractionLimit: config.monthlyDeviceExtractionLimit,
    globalDailyExtractionLimit: config.globalDailyExtractionLimit,
    extractCacheTtlDays: config.extractCacheTtlDays,
  },
  rateLimit: { max: config.ipRateLimitMax, windowMs: config.ipRateLimitWindowMs },
});

if (!config.upstashUrl) {
  app.log.warn(
    'UPSTASH_REDIS_REST_URL is unset - rate limits, quotas and the extraction cache are in-memory and reset on every restart.',
  );
}

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then((address) => app.log.info(`Morsel extraction server listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
