import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from '../app.js';
import type { DeepSeekResult } from '../services/deepseek.js';
import { createStore } from '../lib/store.js';
import type { ScrapedPost, ParsedRecipe } from '../lib/types.js';

/**
 * Covers the reordered three-level pipeline (DeepSeek -> Gemini -> video) and
 * the known-bad-caption short-circuit. Level ordering has real cost
 * consequences (Gemini is the expensive text parser, video is more expensive
 * still), so which parser gets called - and which doesn't - is the thing
 * worth pinning down here, not just the final status code.
 */

const sufficientRecipe: ParsedRecipe = {
  isRecipe: true,
  title: 'Pancakes',
  servings: 2,
  ingredients: ['2 cups flour', '2 eggs', '1 cup milk'],
  steps: ['Mix batter', 'Cook on griddle 2 minutes per side'],
  macros: { calories: 300, carbs: 40, protein: 10, fat: 8 },
  macrosStatedInCaption: false,
  suggestedCategory: 'meals',
};

const insufficientRecipe: ParsedRecipe = {
  isRecipe: true,
  title: 'Pancakes',
  servings: 2,
  ingredients: ['flour'],
  steps: [],
  macros: { calories: 0, carbs: 0, protein: 0, fat: 0 },
  macrosStatedInCaption: false,
  suggestedCategory: 'meals',
};

const REAL_CAPTION =
  'Fluffy pancakes: 2 cups flour, 2 eggs, 1 cup milk, 1 tbsp sugar, pinch of ' +
  'salt. Whisk together, cook on a hot griddle for 2 minutes per side until ' +
  'golden. Serves 2.';

const THIN_CAPTION = '#pancakes #breakfast #yum';

function stubScraper(post: ScrapedPost) {
  return { scrape: vi.fn(async (): Promise<ScrapedPost> => post) };
}

function deepseekSufficient(recipe: ParsedRecipe = sufficientRecipe): DeepSeekResult {
  return { recipe, sufficient: true, confidence: 0.9, missing: [] };
}

function deepseekInsufficient(recipe: ParsedRecipe = insufficientRecipe): DeepSeekResult {
  return { recipe, sufficient: false, confidence: 0.3, missing: ['steps'] };
}

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    instagramScraper: stubScraper({ caption: REAL_CAPTION }),
    tiktokScraper: stubScraper({ caption: REAL_CAPTION }),
    webScraper: stubScraper({ caption: REAL_CAPTION }),
    parser: { parse: vi.fn(async () => sufficientRecipe) },
    improver: {} as AppDeps['improver'],
    photoSearch: { search: vi.fn(async () => null) },
    nutrition: { search: vi.fn(async () => null) },
    appSharedSecret: '',
    ...overrides,
  };
}

function extract(app: ReturnType<typeof buildApp>, url: string) {
  return app.inject({
    method: 'POST',
    url: '/extract',
    headers: { 'x-morsel-device-id': 'device-a' },
    payload: { url },
  });
}

const TIKTOK_URL = 'https://www.tiktok.com/@x/video/1';

describe('extraction level ordering', () => {
  it('never calls Gemini when DeepSeek alone is sufficient', async () => {
    const deps = makeDeps({
      deepseekParser: { parseText: vi.fn(async () => deepseekSufficient()) },
    });
    const app = buildApp(deps);
    const res = await extract(app, TIKTOK_URL);
    expect(res.statusCode).toBe(200);
    expect(deps.deepseekParser!.parseText).toHaveBeenCalledOnce();
    expect(deps.parser.parse).not.toHaveBeenCalled();
    await app.close();
  });

  it('falls through to Gemini when DeepSeek is unavailable', async () => {
    const deps = makeDeps(); // no deepseekParser
    const app = buildApp(deps);
    const res = await extract(app, TIKTOK_URL);
    expect(res.statusCode).toBe(200);
    expect(deps.parser.parse).toHaveBeenCalledOnce();
    await app.close();
  });

  it('falls through to Gemini when DeepSeek is insufficient, and never touches video', async () => {
    const videoParser = { parseVideo: vi.fn(async () => sufficientRecipe) };
    const deps = makeDeps({
      deepseekParser: { parseText: vi.fn(async () => deepseekInsufficient()) },
      videoParser,
      videoFallbackEnabled: true,
    });
    const app = buildApp(deps);
    const res = await extract(app, TIKTOK_URL);
    expect(res.statusCode).toBe(200);
    expect(deps.parser.parse).toHaveBeenCalledOnce();
    expect(videoParser.parseVideo).not.toHaveBeenCalled();
    await app.close();
  });

  it('skips Levels 1-2 entirely for a known-bad caption with a video to fall back on', async () => {
    const deepseekParser = { parseText: vi.fn(async () => deepseekSufficient()) };
    const videoParser = { parseVideo: vi.fn(async () => sufficientRecipe) };
    const deps = makeDeps({
      tiktokScraper: stubScraper({ caption: THIN_CAPTION, videoUrl: 'https://cdn.example/v.mp4' }),
      deepseekParser,
      videoParser,
      videoFallbackEnabled: true,
    });
    const app = buildApp(deps);
    const res = await extract(app, TIKTOK_URL);
    expect(res.statusCode).toBe(200);
    expect(deepseekParser.parseText).not.toHaveBeenCalled();
    expect(deps.parser.parse).not.toHaveBeenCalled();
    expect(videoParser.parseVideo).toHaveBeenCalledOnce();
    await app.close();
  });

  it('still tries both text levels for a known-bad caption with no video to fall back on', async () => {
    const deepseekParser = { parseText: vi.fn(async () => deepseekInsufficient()) };
    const deps = makeDeps({
      tiktokScraper: stubScraper({ caption: THIN_CAPTION }), // no videoUrl
      deepseekParser,
      parser: { parse: vi.fn(async () => sufficientRecipe) },
    });
    const app = buildApp(deps);
    const res = await extract(app, TIKTOK_URL);
    expect(res.statusCode).toBe(200);
    expect(deepseekParser.parseText).toHaveBeenCalledOnce();
    expect(deps.parser.parse).toHaveBeenCalledOnce();
    await app.close();
  });
});

describe('extraction cache boundary', () => {
  it('rejects an invalid ExtractedRecipe at the cache boundary with a 500', async () => {
    const store = createStore({ upstashUrl: '', upstashToken: '' });
    const setJsonSpy = vi.spyOn(store, 'setJson');

    // imageRemoteUrl comes from scraped.imageUrl unsanitized; a non-string
    // value triggers validateExtractedRecipe at the cache boundary.
    const deps = makeDeps({
      tiktokScraper: stubScraper({ caption: REAL_CAPTION, imageUrl: 123 as unknown as string }),
      store,
    });
    const app = buildApp(deps);

    const res = await extract(app, TIKTOK_URL);
    expect(res.statusCode).toBe(500);

    // The recipe was never cached
    expect(setJsonSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('caches a valid ExtractedRecipe', async () => {
    const store = createStore({ upstashUrl: '', upstashToken: '' });
    const setJsonSpy = vi.spyOn(store, 'setJson');

    const deps = makeDeps({ store });
    const app = buildApp(deps);

    const res = await extract(app, TIKTOK_URL);
    expect(res.statusCode).toBe(200);

    // The recipe was cached (setJson called at least once)
    expect(setJsonSpy).toHaveBeenCalled();
    await app.close();
  });
});
