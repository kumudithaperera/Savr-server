import { buildApp } from './app.js';
import { loadConfig } from './config.js';
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
});

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then((address) => app.log.info(`Morsel extraction server listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
