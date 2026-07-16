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
