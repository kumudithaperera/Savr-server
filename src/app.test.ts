import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from './app.js';
import { unprocessable } from './lib/errors.js';
import type { ScrapedPost } from './lib/types.js';

/**
 * A scraper stub that records it was called and returns a fixed caption.
 * `shortcode` mirrors the real scrapers, which report the platform's own id
 * (Instagram shortCode / TikTok video id) - the route uses it to alias short
 * links to their canonical entry.
 */
function stubScraper(caption: string, shortcode?: string) {
  return { scrape: vi.fn(async (): Promise<ScrapedPost> => ({ caption, shortcode })) };
}

const parsed = {
  title: 'Pancakes',
  servings: 2,
  ingredients: ['flour', 'eggs'],
  steps: ['mix', 'cook'],
  macros: { calories: 100, carbs: 10, protein: 5, fat: 2 },
  macrosStatedInCaption: false,
  suggestedCategory: 'meals' as const,
};

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    instagramScraper: stubScraper('ig'),
    tiktokScraper: stubScraper('tt', '7412345678901234567'),
    webScraper: stubScraper('web'),
    parser: { parse: vi.fn(async () => parsed) },
    improver: {} as AppDeps['improver'],
    appSharedSecret: '',
    ...overrides,
  };
}

describe('POST /extract routing', () => {
  it('routes a TikTok URL to the TikTok scraper', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      payload: { url: 'https://www.tiktok.com/@x/video/1' },
    });
    expect(res.statusCode).toBe(200);
    expect(deps.tiktokScraper.scrape).toHaveBeenCalledOnce();
    expect(deps.instagramScraper.scrape).not.toHaveBeenCalled();
    expect(deps.webScraper.scrape).not.toHaveBeenCalled();
    expect(res.json().sourcePlatform).toBe('tiktok');
    await app.close();
  });
});

describe('guardrail', () => {
  it('rejects /extract without the app key when a secret is set', async () => {
    const app = buildApp(makeDeps({ appSharedSecret: 'sekret' }));
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      payload: { url: 'https://www.tiktok.com/@x/video/1' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('accepts /extract with the correct app key', async () => {
    const app = buildApp(makeDeps({ appSharedSecret: 'sekret' }));
    const res = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: { 'x-morsel-app-key': 'sekret' },
      payload: { url: 'https://www.tiktok.com/@x/video/1' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('leaves /health open', async () => {
    const app = buildApp(makeDeps({ appSharedSecret: 'sekret' }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// --- metering -------------------------------------------------------------

/** POSTs a link to /extract as a given install. */
function extract(app: ReturnType<typeof buildApp>, url: string, deviceId = 'device-a') {
  return app.inject({
    method: 'POST',
    url: '/extract',
    headers: { 'x-morsel-device-id': deviceId },
    payload: { url },
  });
}

const TIKTOK = (n: number) => `https://www.tiktok.com/@x/video/${n}`;

/** Production defaults, narrowed per test to keep cases short. */
const LIMITS = {
  monthlyDeviceExtractionLimit: 50,
  globalDailyExtractionLimit: 200,
  extractCacheTtlDays: 30,
};

describe('extraction cache', () => {
  it('serves an identical link from cache without scraping again', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);

    const first = await extract(app, TIKTOK(1));
    const second = await extract(app, TIKTOK(1));

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(deps.tiktokScraper.scrape).toHaveBeenCalledOnce();
    expect(deps.parser.parse).toHaveBeenCalledOnce();
    await app.close();
  });

  it('does not charge quota for a cache hit', async () => {
    const deps = makeDeps();
    const app = buildApp({ ...deps, limits: { ...LIMITS, monthlyDeviceExtractionLimit: 1 } });

    await extract(app, TIKTOK(1));
    // The same link again would be the second extraction if it were metered.
    const cached = await extract(app, TIKTOK(1));

    expect(cached.statusCode).toBe(200);
    await app.close();
  });
});

describe('canonical cache keys', () => {
  const IG = 'https://www.instagram.com/reel/ABC123/';

  it('treats the ways one reel gets shared as a single extraction', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);

    const bare = await extract(app, IG);
    const shared = await extract(app, `${IG}?igsh=MzRlODBiNWFl`);
    const copied = await extract(app, 'https://instagram.com/reel/ABC123?utm_source=ig_web_copy');

    expect([bare.statusCode, shared.statusCode, copied.statusCode]).toEqual([200, 200, 200]);
    // The whole point: one paid extraction, not three.
    expect(deps.instagramScraper.scrape).toHaveBeenCalledOnce();
    await app.close();
  });

  it('charges quota only for the first of those', async () => {
    const deps = makeDeps();
    const app = buildApp({ ...deps, limits: { ...LIMITS, monthlyDeviceExtractionLimit: 1 } });

    expect((await extract(app, IG)).statusCode).toBe(200);
    // Would be over quota if the tagged variant counted as a second extraction.
    expect((await extract(app, `${IG}?igsh=xyz`)).statusCode).toBe(200);
    await app.close();
  });

  it('returns the caller their own link, not the first extractor\'s', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);

    await extract(app, IG);
    const tagged = `${IG}?igsh=MzRlODBiNWFl`;
    const res = await extract(app, tagged);

    // Otherwise the app would save a recipe whose source link isn't the one
    // pasted, breaking its local duplicate detection later.
    expect(res.json().sourceUrl).toBe(tagged);
    await app.close();
  });

  it('lets a TikTok short link and the full URL share one entry', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);

    // The stub scraper reports the video id, as the real one does.
    const short = await extract(app, 'https://vm.tiktok.com/ZMabc123/');
    const full = await extract(app, 'https://www.tiktok.com/@chef/video/7412345678901234567');

    expect([short.statusCode, full.statusCode]).toEqual([200, 200]);
    expect(deps.tiktokScraper.scrape).toHaveBeenCalledOnce();
    await app.close();
  });

  it('still separates genuinely different posts', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);

    await extract(app, 'https://www.instagram.com/reel/AAA/');
    await extract(app, 'https://www.instagram.com/reel/BBB/');

    expect(deps.instagramScraper.scrape).toHaveBeenCalledTimes(2);
    await app.close();
  });
});

describe('cache statistics', () => {
  it('reports hits, misses and hit rate on /health', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);

    await extract(app, 'https://www.instagram.com/reel/STATS1/'); // miss
    await extract(app, 'https://www.instagram.com/reel/STATS1/?igsh=x'); // hit
    await extract(app, 'https://www.instagram.com/reel/STATS2/'); // miss

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json().cache).toMatchObject({ hits: 1, misses: 2 });
    expect(health.json().cache.hitRate).toBeCloseTo(0.33, 2);
    await app.close();
  });

  it('reports a null hit rate before any traffic', async () => {
    const app = buildApp(makeDeps());
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json().cache).toMatchObject({ hits: 0, misses: 0, hitRate: null });
    await app.close();
  });
});

describe('per-device monthly quota', () => {
  it('rejects a metered link once the install is over its allowance', async () => {
    const deps = makeDeps();
    const app = buildApp({ ...deps, limits: { ...LIMITS, monthlyDeviceExtractionLimit: 2 } });

    expect((await extract(app, TIKTOK(1))).statusCode).toBe(200);
    expect((await extract(app, TIKTOK(2))).statusCode).toBe(200);
    const third = await extract(app, TIKTOK(3));

    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe('quota_exceeded');
    await app.close();
  });

  it('meters each install separately', async () => {
    const deps = makeDeps();
    const app = buildApp({ ...deps, limits: { ...LIMITS, monthlyDeviceExtractionLimit: 1 } });

    await extract(app, TIKTOK(1), 'device-a');
    expect((await extract(app, TIKTOK(2), 'device-a')).statusCode).toBe(429);
    expect((await extract(app, TIKTOK(3), 'device-b')).statusCode).toBe(200);
    await app.close();
  });

  it('leaves web & blog links unlimited', async () => {
    const deps = makeDeps();
    const app = buildApp({ ...deps, limits: { ...LIMITS, monthlyDeviceExtractionLimit: 1 } });

    await extract(app, TIKTOK(1));
    expect((await extract(app, TIKTOK(2))).statusCode).toBe(429);
    // Same install, past the cap: a recipe blog still extracts.
    const blog = await extract(app, 'https://example.com/recipes/pancakes');
    expect(blog.statusCode).toBe(200);
    expect(blog.json().sourcePlatform).toBe('web');
    await app.close();
  });
});

describe('global daily circuit breaker', () => {
  it('stops metered extractions for everyone once the day is spent', async () => {
    const deps = makeDeps();
    const app = buildApp({ ...deps, limits: { ...LIMITS, globalDailyExtractionLimit: 1 } });

    expect((await extract(app, TIKTOK(1), 'device-a')).statusCode).toBe(200);
    const overflow = await extract(app, TIKTOK(2), 'device-b');

    expect(overflow.statusCode).toBe(503);
    expect(overflow.json().code).toBe('at_capacity');
    await app.close();
  });

  it('still allows web & blog links at capacity', async () => {
    const deps = makeDeps();
    const app = buildApp({ ...deps, limits: { ...LIMITS, globalDailyExtractionLimit: 1 } });

    await extract(app, TIKTOK(1));
    expect((await extract(app, 'https://example.com/soup')).statusCode).toBe(200);
    await app.close();
  });
});

// --- nothing uncertain is ever cached -------------------------------------

describe('unextractable links', () => {
  it('rejects an Instagram profile without calling the scraper at all', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);

    const res = await extract(app, 'https://www.instagram.com/cookingwithme/');

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('unsupported_link');
    // The whole point: no Apify spend, no Gemini spend, on a link we could tell
    // was wrong from its shape.
    expect(deps.instagramScraper.scrape).not.toHaveBeenCalled();
    expect(deps.parser.parse).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not spend the caller quota on an unsupported link', async () => {
    const deps = makeDeps();
    const app = buildApp({ ...deps, limits: { ...LIMITS, monthlyDeviceExtractionLimit: 1 } });

    await extract(app, 'https://www.youtube.com/watch?v=abc123');
    // If the rejected YouTube link had burned the single allowance, this would 429.
    const after = await extract(app, TIKTOK(1));

    expect(after.statusCode).toBe(200);
    await app.close();
  });
});

describe('caching invariant: only a confident parse is stored', () => {
  it('does not cache a link whose caption held no recipe', async () => {
    // The parser reports "this is not a recipe" rather than improvising.
    const parser = { parse: vi.fn(async () => ({ ...parsed, isRecipe: false })) };
    const deps = makeDeps({ parser });
    const app = buildApp(deps);

    const first = await extract(app, TIKTOK(9));
    const second = await extract(app, TIKTOK(9));

    expect(first.statusCode).toBe(422);
    expect(first.json().code).toBe('not_a_recipe');
    // Second attempt must fail the same way. If the rejection had been cached -
    // or worse, an invented recipe had been - this would return 200 and serve
    // that guess to everyone who pastes the link for the next year.
    expect(second.statusCode).toBe(422);
    expect(parser.parse).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('does not cache a scrape that failed its caption gate', async () => {
    const scraper = {
      scrape: vi.fn(async () => {
        throw unprocessable('caption has no recipe in it', 'caption_only');
      }),
    };
    const deps = makeDeps({ instagramScraper: scraper as unknown as AppDeps['instagramScraper'] });
    const app = buildApp(deps);

    const IG_REEL = 'https://www.instagram.com/reel/ABC123/';
    const first = await extract(app, IG_REEL);
    const second = await extract(app, IG_REEL);

    expect(first.statusCode).toBe(422);
    expect(first.json().code).toBe('caption_only');
    expect(second.statusCode).toBe(422);
    expect(scraper.scrape).toHaveBeenCalledTimes(2);
    expect(deps.parser.parse).not.toHaveBeenCalled();
    await app.close();
  });

  it('still caches a genuine recipe', async () => {
    const deps = makeDeps();
    const app = buildApp(deps);

    await extract(app, TIKTOK(10));
    const second = await extract(app, TIKTOK(10));

    expect(second.statusCode).toBe(200);
    expect(deps.parser.parse).toHaveBeenCalledOnce();
    await app.close();
  });
});
