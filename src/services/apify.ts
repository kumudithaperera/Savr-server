import type { Config } from '../config.js';
import { assessCaption } from '../lib/completeness.js';
import { unprocessable, upstreamError } from '../lib/errors.js';
import type { ScrapedPost } from '../lib/types.js';

export { assessCaption, type CaptionVerdict } from '../lib/completeness.js';

/** Subset of the Apify Instagram Scraper dataset item shape we rely on. */
interface ApifyInstagramItem {
  caption?: string;
  displayUrl?: string;
  ownerUsername?: string;
  shortCode?: string;
  /** Video URL for Reels and video posts. */
  videoUrl?: string;
  /** Whether this is a video post. */
  isVideo?: boolean;
  // Apify returns an `error` field on items it could not scrape.
  error?: string;
}

export interface InstagramScraper {
  scrape(url: string): Promise<ScrapedPost>;
}

/**
 * Creates an Instagram scraper backed by the Apify actor run-sync API.
 * `fetchImpl` is injectable so the scraper can be unit-tested without network.
 *
 * A caption too thin to hold a recipe (`assessCaption`) only rejects the post
 * outright when there's no video to fall back on - see extract.ts's Level 3.
 * Detecting that here, rather than letting Gemini improvise, matters because a
 * successful parse is cached for a year under the post's shortcode and served
 * to *everyone* who pastes that Reel: a caption of pure hashtags used to yield
 * a plausible invented recipe that then became the permanent answer for that
 * post.
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
      const videoUrl = item.videoUrl ?? undefined;
      const verdict = assessCaption(caption);

      // When video URL is available, allow posts with insufficient captions to
      // proceed - the video fallback can analyze the video content. Only reject
      // when there is no video to fall back on.
      if (verdict === 'no-caption' && !videoUrl) {
        throw unprocessable(
          "This Reel's recipe is in the video, and Morsel can only read recipes " +
            'written out in the caption right now. Try a post with the ingredients ' +
            'and steps typed out.',
          'caption_only',
        );
      }
      if (verdict === 'no-recipe-text' && !videoUrl) {
        throw unprocessable(
          "This post's caption is just hashtags and a description, not a recipe. " +
            'Morsel reads Instagram recipes from the caption, so try a post with ' +
            'the ingredients and steps written out.',
          'caption_only',
        );
      }

      return {
        caption,
        imageUrl: item.displayUrl,
        ownerUsername: item.ownerUsername,
        shortcode: item.shortCode,
        videoUrl,
      };
    },
  };
}
