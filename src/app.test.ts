import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from './app.js';
import type { ScrapedPost } from './lib/types.js';

/** A scraper stub that records it was called and returns a fixed caption. */
function stubScraper(caption: string) {
  return { scrape: vi.fn(async (): Promise<ScrapedPost> => ({ caption })) };
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
    tiktokScraper: stubScraper('tt'),
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
