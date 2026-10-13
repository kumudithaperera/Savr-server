import { createHash } from 'node:crypto';

/**
 * Copies a recipe photo off an expiring social CDN into our own public bucket.
 *
 * Instagram and TikTok image URLs are signed and stop working within days, so
 * a Discover result or a shared post that pointed at one would lose its photo
 * almost immediately. Anything else (a blog's own image, a Pexels photo) is
 * stable and is kept as-is.
 *
 * SSRF: the server only ever fetches from the CDN hosts below, over https,
 * without following redirects, with a timeout and a size cap, and only keeps
 * the response when it is an image. A URL from anywhere else is returned
 * untouched and never fetched.
 */

export interface ImageRehoster {
  /**
   * A durable URL for `url`: a re-hosted copy for an expiring CDN image, the
   * URL itself when it is already stable, or null when it is unusable (not
   * https, or a CDN image that could not be fetched - typically expired).
   */
  rehost(url: string | undefined | null): Promise<string | null>;
}

const EXPIRING_HOST_SUFFIXES = [
  'cdninstagram.com',
  'fbcdn.net',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'tiktokcdn-eu.com',
  'ibyteimg.com',
  'byteimg.com',
];

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};

function parseHttps(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

export function isExpiringCdnUrl(url: string): boolean {
  const parsed = parseHttps(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return EXPIRING_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export interface SupabaseStorageConfig {
  url: string;
  serviceRoleKey: string;
  /** Public bucket the copies go into. */
  bucket: string;
}

export function createSupabaseImageRehoster(
  config: SupabaseStorageConfig,
  fetchImpl: typeof fetch = fetch,
): ImageRehoster {
  const base = config.url.replace(/\/$/, '');
  const configured = Boolean(base && config.serviceRoleKey && config.bucket);

  async function download(url: string): Promise<{ bytes: Buffer; type: string } | null> {
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!EXTENSIONS[type]) return null;
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
    return { bytes, type };
  }

  return {
    async rehost(url) {
      if (!url) return null;
      if (!parseHttps(url)) return null;
      if (!isExpiringCdnUrl(url) || !configured) return url;
      try {
        const image = await download(url);
        if (!image) return null;
        // Content-addressed, so re-hosting the same photo twice is one object.
        const name = `${createHash('sha256').update(image.bytes).digest('hex')}.${EXTENSIONS[image.type]}`;
        const upload = await fetchImpl(`${base}/storage/v1/object/${config.bucket}/${name}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.serviceRoleKey}`,
            apikey: config.serviceRoleKey,
            'content-type': image.type,
            'x-upsert': 'true',
            'cache-control': 'public, max-age=31536000, immutable',
          },
          body: new Uint8Array(image.bytes),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!upload.ok) return null;
        return `${base}/storage/v1/object/public/${config.bucket}/${name}`;
      } catch {
        return null;
      }
    },
  };
}

/**
 * No storage configured (tests, local dev): every https URL is kept as-is. An
 * expiring CDN photo then works for a few days and breaks, which is fine
 * locally; `index.ts` warns when a deployed server runs like this.
 */
export function createPassthroughRehoster(): ImageRehoster {
  return {
    async rehost(url) {
      return url && parseHttps(url) ? url : null;
    },
  };
}
