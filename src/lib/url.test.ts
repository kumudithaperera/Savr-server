import { describe, expect, it } from 'vitest';

import {
  assertExtractableUrl,
  assertHttpUrl,
  cacheKeyFromShortcode,
  canonicalCacheKey,
  detectPlatform,
} from './url.js';
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

describe('canonicalCacheKey', () => {
  const ig = (u: string) => canonicalCacheKey(u, 'instagram');
  const tt = (u: string) => canonicalCacheKey(u, 'tiktok');
  const web = (u: string) => canonicalCacheKey(u, 'web');

  it('collapses the ways one Instagram reel gets shared', () => {
    const bare = ig('https://www.instagram.com/reel/ABC123/');
    expect(ig('https://www.instagram.com/reel/ABC123/?igsh=MzRlODBiNWFl')).toBe(bare);
    expect(ig('https://instagram.com/reel/ABC123/?utm_source=ig_web_copy_link')).toBe(bare);
    expect(ig('https://www.instagram.com/reel/ABC123')).toBe(bare);
    expect(bare).toBe('ig:ABC123');
  });

  it('handles the other Instagram post shapes', () => {
    expect(ig('https://www.instagram.com/p/XYZ789/')).toBe('ig:XYZ789');
    expect(ig('https://www.instagram.com/tv/XYZ789/')).toBe('ig:XYZ789');
    expect(ig('https://www.instagram.com/share/reel/XYZ789/')).toBe('ig:XYZ789');
  });

  it('reduces TikTok links to the video id', () => {
    const bare = tt('https://www.tiktok.com/@chef/video/7412345678901234567');
    expect(
      tt('https://www.tiktok.com/@chef/video/7412345678901234567?is_from_webapp=1&sender_device=pc'),
    ).toBe(bare);
    // A different account path for the same video id is still the same video.
    expect(tt('https://m.tiktok.com/@other/video/7412345678901234567')).toBe(bare);
    expect(bare).toBe('tt:7412345678901234567');
  });

  it('keeps TikTok short links distinct until the scraper resolves them', () => {
    expect(tt('https://vm.tiktok.com/ZMabc123/')).toBe('tt:short:/ZMabc123');
    expect(tt('https://vm.tiktok.com/ZMabc123')).toBe('tt:short:/ZMabc123');
  });

  it('strips tracking junk from web links but keeps meaningful params', () => {
    expect(web('https://example.com/recipes?utm_source=x&recipe=123')).toBe(
      'web:example.com/recipes?recipe=123',
    );
    // Param order must not create two entries for one page.
    expect(web('https://example.com/r?b=2&a=1')).toBe(web('https://example.com/r?a=1&b=2'));
  });

  it('collapses www and trailing-slash variants of a web link', () => {
    const bare = web('https://example.com/recipes/pasta');
    expect(web('https://www.example.com/recipes/pasta/')).toBe(bare);
    expect(web('https://EXAMPLE.com/recipes/pasta')).toBe(bare);
  });

  it('falls back rather than throwing on an unparseable url', () => {
    expect(canonicalCacheKey('not a url', 'web')).toBe('raw:not a url');
  });

  it('does not collapse genuinely different posts', () => {
    expect(ig('https://www.instagram.com/reel/AAA/')).not.toBe(
      ig('https://www.instagram.com/reel/BBB/'),
    );
    expect(web('https://example.com/a')).not.toBe(web('https://example.com/b'));
  });
});

describe('cacheKeyFromShortcode', () => {
  it('builds the same key the URL parser would', () => {
    expect(cacheKeyFromShortcode('instagram', 'ABC123')).toBe(
      canonicalCacheKey('https://www.instagram.com/reel/ABC123/', 'instagram'),
    );
    expect(cacheKeyFromShortcode('tiktok', '7412345678901234567')).toBe(
      canonicalCacheKey('https://www.tiktok.com/@c/video/7412345678901234567', 'tiktok'),
    );
  });

  it('returns null when there is no usable id', () => {
    expect(cacheKeyFromShortcode('web', 'anything')).toBeNull();
    expect(cacheKeyFromShortcode('instagram', undefined)).toBeNull();
  });
});

describe('assertExtractableUrl', () => {
  /** Runs the same pairing the route does: detect the platform, then validate. */
  const check = (url: string) => assertExtractableUrl(url, detectPlatform(url));

  it('accepts the link shapes we can actually extract', () => {
    expect(() => check('https://www.instagram.com/reel/ABC123/')).not.toThrow();
    expect(() => check('https://www.instagram.com/p/ABC123/')).not.toThrow();
    expect(() => check('https://www.instagram.com/share/reel/ABC123/')).not.toThrow();
    expect(() => check('https://www.tiktok.com/@chef/video/7412345678901234567')).not.toThrow();
    expect(() => check('https://vm.tiktok.com/ZMabc123/')).not.toThrow();
    expect(() => check('https://example.com/recipes/pancakes')).not.toThrow();
  });

  it('rejects an Instagram profile rather than scraping its latest post', () => {
    // The old behaviour: Apify was handed the profile URL and returned whatever
    // that account posted most recently, so the user got a random recipe.
    expect(() => check('https://www.instagram.com/cookingwithme/')).toThrow(HttpError);
    try {
      check('https://www.instagram.com/cookingwithme/');
    } catch (err) {
      expect((err as HttpError).code).toBe('unsupported_link');
      expect((err as HttpError).message).toContain('profile');
    }
  });

  it('rejects Instagram stories and highlights', () => {
    expect(() => check('https://www.instagram.com/stories/chef/123456/')).toThrow(HttpError);
    expect(() => check('https://www.instagram.com/explore/tags/dal/')).toThrow(HttpError);
  });

  it('rejects a TikTok profile', () => {
    expect(() => check('https://www.tiktok.com/@chef')).toThrow(HttpError);
  });

  it('rejects YouTube links instead of feeding the page shell to the parser', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=abc123',
      'https://youtu.be/abc123',
      'https://m.youtube.com/shorts/abc123',
    ]) {
      try {
        check(url);
        throw new Error(`expected ${url} to be rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).code).toBe('unsupported_link');
        expect((err as HttpError).message).toContain('YouTube');
      }
    }
  });

  it('rejects a bare site front page', () => {
    expect(() => check('https://example.com/')).toThrow(HttpError);
    expect(() => check('https://example.com')).toThrow(HttpError);
  });
});
