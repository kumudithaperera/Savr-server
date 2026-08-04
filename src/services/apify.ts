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
 * Morsel reads Instagram recipes out of the post caption - it does not watch the
 * video, transcribe the audio, or OCR on-screen text (see the "Instagram video
 * recipes" entry on the Coming Soon screen). So a Reel whose recipe only exists
 * in the voiceover has nothing for us to parse.
 *
 * Detecting that here, rather than letting Gemini improvise, matters because a
 * successful parse is cached for a year under the post's shortcode and served
 * to *everyone* who pastes that Reel. A caption of pure hashtags used to yield a
 * plausible invented recipe that then became the permanent answer for that post.
 */
export type CaptionVerdict = 'ok' | 'no-caption' | 'no-recipe-text';

/**
 * Strips the furniture Instagram captions are padded with - hashtags, @mentions,
 * links, emoji - so what remains is the text a recipe would actually live in.
 */
function captionProse(caption: string): string {
  return caption
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#@][\p{L}\p{N}_.]+/gu, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Shortest caption we'll accept as possibly holding a recipe. Even a terse one
 * ("1 cup toor dal, 1 tsp haldi, salt. Pressure cook 3 whistles...") clears this
 * comfortably, while "Best butter chicken ever! Recipe below 👇" does not.
 *
 * Tuned to err toward *accepting*: wrongly rejecting a recipe the user can read
 * with their own eyes is far worse than one extra Gemini call, and the
 * `isRecipe` flag in the parser is the real backstop for junk that gets through.
 */
const MIN_RECIPE_CAPTION_CHARS = 80;

/** Whether a caption carries enough prose to be worth sending to the parser. */
export function assessCaption(caption: string): CaptionVerdict {
  if (caption.trim().length === 0) return 'no-caption';
  return captionProse(caption).length < MIN_RECIPE_CAPTION_CHARS ? 'no-recipe-text' : 'ok';
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
      const verdict = assessCaption(caption);
      if (verdict === 'no-caption') {
        throw unprocessable(
          "This Reel's recipe is in the video, and Morsel can only read recipes " +
            'written out in the caption right now. Try a post with the ingredients ' +
            'and steps typed out.',
          'caption_only',
        );
      }
      if (verdict === 'no-recipe-text') {
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
      };
    },
  };
}
