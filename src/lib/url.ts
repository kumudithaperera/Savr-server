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
