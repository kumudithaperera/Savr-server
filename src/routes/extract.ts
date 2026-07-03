import type { FastifyInstance } from 'fastify';

import type { InstagramScraper } from '../services/apify.js';
import type { RecipeParser } from '../services/gemini.js';
import type { WebScraper } from '../services/web.js';
import { normalizeRecipe } from '../lib/normalize.js';
import { assertHttpUrl, detectPlatform } from '../lib/url.js';

interface ExtractDeps {
  instagramScraper: InstagramScraper;
  webScraper: WebScraper;
  parser: RecipeParser;
}

interface ExtractBody {
  url?: unknown;
}

/**
 * Registers `POST /extract`. The pipeline: validate URL -> pick the scraper for
 * the link's origin (Instagram vs web/blog) -> parse + estimate macros ->
 * normalize -> return ExtractedRecipe. Error mapping is handled centrally.
 */
export function registerExtractRoute(app: FastifyInstance, deps: ExtractDeps): void {
  app.post<{ Body: ExtractBody }>('/extract', async (request) => {
    const url = assertHttpUrl(request.body?.url);
    const platform = detectPlatform(url);
    const scraped =
      platform === 'instagram'
        ? await deps.instagramScraper.scrape(url)
        : await deps.webScraper.scrape(url);
    const parsed = await deps.parser.parse(scraped.caption);
    return normalizeRecipe(url, platform, scraped, parsed);
  });
}
