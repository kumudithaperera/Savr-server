import type { Config } from '../config.js';
import { unprocessable, upstreamError } from '../lib/errors.js';
import type { ScrapedPost } from '../lib/types.js';

/** Subset of the Apify Instagram Scraper dataset item shape we rely on. */
interface ApifyInstagramItem {
  caption?: string;
  displayUrl?: string;
  ownerUsername?: string;
  shortCode?: string;
  // Apify returns an `error` field on items it could not scrape.
  error?: string;
}

export interface InstagramScraper {
  scrape(url: string): Promise<ScrapedPost>;
}

/**
 * Creates an Instagram scraper backed by the Apify actor run-sync API.
 * `fetchImpl` is injectable so the scraper can be unit-tested without network.
 */
export function createApifyInstagramScraper(
  config: Pick<Config, 'apifyToken' | 'apifyInstagramActor'>,
  fetchImpl: typeof fetch = fetch,
): InstagramScraper {
  return {
    async scrape(url: string): Promise<ScrapedPost> {
      const endpoint =
        `https://api.apify.com/v2/acts/${config.apifyInstagramActor}` +
        `/run-sync-get-dataset-items?token=${encodeURIComponent(config.apifyToken)}`;

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            directUrls: [url],
            resultsType: 'posts',
            resultsLimit: 1,
            addParentData: false,
          }),
        });
      } catch (err) {
        throw upstreamError(`Could not reach Apify: ${(err as Error).message}`);
      }

      if (!response.ok) {
        throw upstreamError(`Apify returned HTTP ${response.status}.`);
      }

      const items = (await response.json()) as ApifyInstagramItem[];
      const item = Array.isArray(items) ? items[0] : undefined;

      if (!item || item.error) {
        throw unprocessable(
          item?.error
            ? `Apify could not scrape this post: ${item.error}`
            : 'No data returned for this Instagram link. It may be private or removed.',
        );
      }

      const caption = (item.caption ?? '').trim();
      if (!caption) {
        throw unprocessable('This post has no caption text to extract a recipe from.');
      }

      return {
        caption,
        imageUrl: item.displayUrl,
        ownerUsername: item.ownerUsername,
        shortcode: item.shortCode,
      };
    },
  };
}
