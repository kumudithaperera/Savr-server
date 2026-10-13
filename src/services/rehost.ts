import { createHash } from 'node:crypto';

/**
 * The only photos Discover and the recipe feed ever publish live in our own
 * public bucket. Two ways in:
 *
 *  - `storeUpload` - a photo the app sent with a shared recipe (the person's
 *    own photo, or the thumbnail it already saved for that recipe).
 *  - `rehost` - a copy of an Instagram/TikTok thumbnail. Those URLs are signed
 *    and expire within days, and they are the only third-party hosts the
 *    server ever fetches from.
 *
 * Anything else (a blog's image URL, a link the client typed) is never fetched
 * and never published: showing it would make every viewer's phone call that
 * host, which tells it who is browsing. The app shows a placeholder instead,
 * and a Discover web result's own photo is only downloaded after someone saves
 * the recipe (`routes/discover.ts`).
 *
 * SSRF: fetches only from the CDN hosts below, over https, with no redirects,
 * a timeout and a size cap, and keeps the response only when it is an image.
 */

export interface UploadedImage {
  bytes: Buffer;
  mimeType: string;
}

export interface ImageRehoster {
  /**
   * Our copy of an expiring Instagram/TikTok thumbnail, or null for anything
   * else (not one of those CDNs, not https, expired, or storage unavailable).
   */
  rehost(url: string | undefined | null): Promise<string | null>;
  /** Our public URL for an uploaded photo, or null when it can't be stored. */
  storeUpload(image: UploadedImage): Promise<string | null>;
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

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 8000;
export const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
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

/**
 * The real type of an image from its first bytes, ignoring whatever the
 * sender claimed. Null = not a JPEG, PNG or WebP.
 */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
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

  async function download(url: string): Promise<UploadedImage | null> {
    const response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    const mimeType = sniffImageType(bytes);
    return mimeType ? { bytes, mimeType } : null;
  }

  async function upload(image: UploadedImage): Promise<string | null> {
    const type = sniffImageType(image.bytes);
    if (!configured || !type || image.bytes.length > MAX_IMAGE_BYTES) return null;
    // Content-addressed, so storing the same photo twice is one object.
    const name = `${createHash('sha256').update(image.bytes).digest('hex')}.${IMAGE_EXTENSIONS[type]}`;
    const response = await fetchImpl(`${base}/storage/v1/object/${config.bucket}/${name}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.serviceRoleKey}`,
        apikey: config.serviceRoleKey,
        'content-type': type,
        'x-upsert': 'true',
        'cache-control': 'public, max-age=31536000, immutable',
      },
      body: new Uint8Array(image.bytes),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok ? `${base}/storage/v1/object/public/${config.bucket}/${name}` : null;
  }

  return {
    async rehost(url) {
      if (!url || !configured || !isExpiringCdnUrl(url)) return null;
      try {
        const image = await download(url);
        return image ? await upload(image) : null;
      } catch {
        return null;
      }
    },

    async storeUpload(image) {
      try {
        return await upload(image);
      } catch {
        return null;
      }
    },
  };
}

/**
 * No storage configured (tests, local dev): nothing can be stored, so every
 * photo becomes the app's placeholder. `index.ts` warns when a deployed server
 * runs like this.
 */
export function createPassthroughRehoster(): ImageRehoster {
  return {
    async rehost() {
      return null;
    },
    async storeUpload() {
      return null;
    },
  };
}
