import { badRequest } from './errors.js';
import type { SourcePlatform } from './types.js';

const INSTAGRAM_HOSTS = ['instagram.com', 'www.instagram.com', 'instagr.am'];
const TIKTOK_HOSTS = [
  'tiktok.com',
  'www.tiktok.com',
  'm.tiktok.com',
  'vm.tiktok.com',
  'vt.tiktok.com',
];

/**
 * Validates that `raw` is a well-formed http(s) URL. Throws a 400 HttpError
 * otherwise. Returns the normalized URL string.
 */
export function assertHttpUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw badRequest('A non-empty "url" string is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw badRequest(`"${raw}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw badRequest('Only http and https links are supported.');
  }
  return parsed.toString();
}

/** Determines which extraction flow a URL should use based on its host. */
export function detectPlatform(url: string): SourcePlatform {
  const host = new URL(url).hostname.toLowerCase();
  if (INSTAGRAM_HOSTS.includes(host)) return 'instagram';
  if (TIKTOK_HOSTS.includes(host)) return 'tiktok';
  return 'web';
}

/**
 * Query parameters that identify *how a link was shared* rather than *what it
 * points at*. Dropping them lets the extraction cache recognise that
 * `?igsh=…`, `?utm_source=ig_web_copy_link` and a bare link are the same post,
 * so the first person's extraction is reused instead of paid for again.
 */
const TRACKING_PARAMS = new Set([
  'igsh',
  'igshid',
  'fbclid',
  'gclid',
  'si',
  'is_from_webapp',
  'sender_device',
  'web_id',
  '_r',
  '_t',
  'share_app_id',
  'ref',
  'ref_src',
  'mc_cid',
  'mc_eid',
]);

const isTracking = (name: string) => TRACKING_PARAMS.has(name) || name.startsWith('utm_');

/** TikTok short-link hosts, whose paths carry no video id to canonicalise. */
const TIKTOK_SHORT_HOSTS = ['vm.tiktok.com', 'vt.tiktok.com'];

/** `/reel/CODE/`, `/p/CODE`, `/tv/CODE`, `/share/reel/CODE` -> `CODE`. */
const INSTAGRAM_SHORTCODE = /\/(?:share\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/;
/** `/@user/video/123456` -> `123456`. */
const TIKTOK_VIDEO_ID = /\/video\/(\d+)/;

/**
 * A stable identity for the *post* a link points at, used as the extraction
 * cache key so one extraction serves everyone who shares that post.
 *
 * Social links are reduced to the platform's own id: the whole query string is
 * discarded because the shortcode/video id already identifies the post
 * completely. Web links are treated more cautiously - a query string there can
 * be load-bearing (`?recipe=123`), so only known tracking parameters are
 * removed and the rest are sorted for stability.
 *
 * Anything unrecognised falls back to the full URL, so this can only ever
 * increase the hit rate, never mismatch two different recipes.
 */
export function canonicalCacheKey(url: string, platform: SourcePlatform): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `raw:${url}`;
  }

  if (platform === 'instagram') {
    const code = parsed.pathname.match(INSTAGRAM_SHORTCODE)?.[1];
    if (code) return `ig:${code}`;
  }

  if (platform === 'tiktok') {
    const id = parsed.pathname.match(TIKTOK_VIDEO_ID)?.[1];
    if (id) return `tt:${id}`;
    // Short links resolve to a video id only once the scraper has run; the
    // route writes an alias under `tt:<id>` afterwards so the canonical URL
    // hits this same entry.
    if (TIKTOK_SHORT_HOSTS.includes(parsed.hostname.toLowerCase())) {
      return `tt:short:${parsed.pathname.replace(/\/+$/, '')}`;
    }
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  const params = [...parsed.searchParams.entries()]
    .filter(([name]) => !isTracking(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length
    ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}`
    : '';

  return `web:${host}${path}${query}`;
}

/**
 * Cache key for a post given the canonical id a scraper returned
 * (`ScrapedPost.shortcode`: Instagram's shortCode, TikTok's numeric id), or
 * null when the platform has no such id. Lets a short link and the full URL
 * share one cache entry.
 */
export function cacheKeyFromShortcode(
  platform: SourcePlatform,
  shortcode: string | undefined,
): string | null {
  if (!shortcode) return null;
  if (platform === 'instagram') return `ig:${shortcode}`;
  if (platform === 'tiktok') return `tt:${shortcode}`;
  return null;
}
