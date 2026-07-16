import { describe, expect, it } from 'vitest';

import { assertHttpUrl, detectPlatform } from './url.js';
import { HttpError } from './errors.js';

describe('assertHttpUrl', () => {
  it('accepts a valid https url', () => {
    expect(assertHttpUrl('https://example.com/recipes/pasta')).toContain('example.com');
  });

  it('rejects an empty value', () => {
    expect(() => assertHttpUrl('')).toThrow(HttpError);
    expect(() => assertHttpUrl(undefined)).toThrow(HttpError);
  });

  it('rejects a malformed url', () => {
    expect(() => assertHttpUrl('not a url')).toThrow(HttpError);
  });

  it('rejects non-http protocols', () => {
    expect(() => assertHttpUrl('ftp://example.com/file')).toThrow(HttpError);
  });
});

describe('detectPlatform', () => {
  it('detects instagram links', () => {
    expect(detectPlatform('https://www.instagram.com/reel/abc/')).toBe('instagram');
    expect(detectPlatform('https://instagram.com/p/abc/')).toBe('instagram');
  });

  it('detects tiktok links', () => {
    expect(detectPlatform('https://www.tiktok.com/@x/video/1')).toBe('tiktok');
    expect(detectPlatform('https://tiktok.com/@x/video/1')).toBe('tiktok');
    expect(detectPlatform('https://vm.tiktok.com/ZMabc123/')).toBe('tiktok');
  });

  it('treats other hosts as web', () => {
    expect(detectPlatform('https://cooking.nytimes.com/recipes/123')).toBe('web');
  });
});
