import type { Config } from '../config.js';
import { unprocessable, upstreamError } from '../lib/errors.js';
import type { ScrapedPost } from '../lib/types.js';

/**
 * Subset of the Apify TikTok scraper dataset item we rely on. TikTok recipe
 * content lives in the spoken audio / on-screen text, not the caption, so we
 * combine the caption (`text`) with the video's subtitles/transcript before
 * handing it to the LLM parser.
 *
 * Actors deliver the transcript in one of two ways, so we handle both:
 *  - inline plain text on the item (`transcript` / `subtitles`), or
 *  - a list of downloadable subtitle files (`videoMeta.subtitleLinks`, usually
 *    WebVTT) that need a second fetch.
 */
interface ApifySubtitleLink {
  language?: string;
  downloadLink?: string;
}

interface ApifyTikTokItem {
  /** Caption/description text (clockworks actors use `text`). */
  text?: string;
  caption?: string;
  /** Some transcript actors return the spoken text inline. */
  transcript?: string;
  subtitles?: string;
  webVideoUrl?: string;
  videoMeta?: {
    coverUrl?: string;
    subtitleLinks?: ApifySubtitleLink[];
  };
  authorMeta?: { name?: string };
  id?: string;
  // Apify stamps an `error` field on items it could not scrape.
  error?: string;
}

export interface TikTokScraper {
  scrape(url: string): Promise<ScrapedPost>;
}

/** Strips WebVTT/SRT markup down to the spoken lines, de-duplicating repeats. */
export function subtitlesToPlainText(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  let last = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'WEBVTT') continue;
    // Cue timing ("00:00:01.000 --> 00:00:03.000") and numeric cue indices.
    if (line.includes('-->')) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(line)) continue;
    // Drop inline tags like <c> or <00:00:01.000>.
    const clean = line.replace(/<[^>]+>/g, '').trim();
    if (!clean || clean === last) continue;
    out.push(clean);
    last = clean;
  }
  return out.join(' ');
}

/** Picks the best subtitle link, preferring an English track. */
function pickSubtitleLink(links: ApifySubtitleLink[] | undefined): string | undefined {
  if (!links || links.length === 0) return undefined;
  const withLink = links.filter((l) => typeof l.downloadLink === 'string' && l.downloadLink);
  if (withLink.length === 0) return undefined;
  const english = withLink.find((l) => (l.language ?? '').toLowerCase().startsWith('en'));
  return (english ?? withLink[0]).downloadLink;
}

/**
 * Creates a TikTok scraper backed by an Apify actor's run-sync API, mirroring
 * the Instagram scraper. `fetchImpl` is injectable so it can be unit-tested
 * without network.
 */
export function createApifyTikTokScraper(
  config: Pick<Config, 'apifyToken' | 'apifyTiktokActor' | 'apifyTiktokNativeSubtitlesOnly'>,
  fetchImpl: typeof fetch = fetch,
): TikTokScraper {
  async function fetchTranscript(item: ApifyTikTokItem): Promise<string> {
    // Prefer an inline transcript if the actor provides one.
    const inline = (item.transcript ?? item.subtitles ?? '').trim();
    if (inline) return subtitlesToPlainText(inline);

    // Otherwise fetch the subtitle file and strip it to plain text.
    const link = pickSubtitleLink(item.videoMeta?.subtitleLinks);
    if (!link) return '';
    try {
      const res = await fetchImpl(link);
      if (!res.ok) return '';
      return subtitlesToPlainText(await res.text());
    } catch {
      // A missing transcript is not fatal — we can still parse the caption.
      return '';
    }
  }

  return {
    async scrape(url: string): Promise<ScrapedPost> {
      const endpoint =
        `https://api.apify.com/v2/acts/${config.apifyTiktokActor}` +
        `/run-sync-get-dataset-items?token=${encodeURIComponent(config.apifyToken)}`;

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            postURLs: [url],
            resultsPerPage: 1,
            shouldDownloadVideos: false,
            shouldDownloadCovers: false,
            // Native captions only — no per-minute AI speech-to-text (see config).
            shouldDownloadSubtitles: true,
            subtitlesLanguage: config.apifyTiktokNativeSubtitlesOnly ? undefined : 'all',
          }),
        });
      } catch (err) {
        throw upstreamError(`Could not reach Apify: ${(err as Error).message}`);
      }

      if (!response.ok) {
        throw upstreamError(`Apify returned HTTP ${response.status}.`);
      }

      const items = (await response.json()) as ApifyTikTokItem[];
      const item = Array.isArray(items) ? items[0] : undefined;

      if (!item || item.error) {
        throw unprocessable(
          item?.error
            ? `Apify could not scrape this video: ${item.error}`
            : 'No data returned for this TikTok link. It may be private or removed.',
        );
      }

      const caption = (item.text ?? item.caption ?? '').trim();
      const transcript = await fetchTranscript(item);

      // The recipe usually lives in the spoken transcript; the caption adds
      // hashtags/quantities. Give the parser both, labelled, when present.
      const parts: string[] = [];
      if (caption) parts.push(caption);
      if (transcript) parts.push(`Video transcript:\n${transcript}`);
      const combined = parts.join('\n\n').trim();

      if (!combined) {
        throw unprocessable(
          'This TikTok has no caption or subtitles to extract a recipe from.',
        );
      }

      return {
        caption: combined,
        imageUrl: item.videoMeta?.coverUrl,
        ownerUsername: item.authorMeta?.name,
        shortcode: item.id,
      };
    },
  };
}
