import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createApifyInstagramScraper } from './services/apify.js';
import { createGeminiRecipeParser } from './services/gemini.js';
import { createWebScraper } from './services/web.js';

const config = loadConfig();

const app = buildApp({
  instagramScraper: createApifyInstagramScraper(config),
  webScraper: createWebScraper(),
  parser: createGeminiRecipeParser(config),
});

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then((address) => app.log.info(`Savr extraction server listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
