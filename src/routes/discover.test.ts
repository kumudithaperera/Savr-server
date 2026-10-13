import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from '../app.js';
import { createMemoryCommunityDb } from '../lib/community-db.js';
import { createMemoryDiscoverDb } from '../lib/discover-db.js';
import { createDiscoverIndexer } from '../lib/discover-indexer.js';
import { createStore } from '../lib/store.js';
import type { ExtractedRecipe } from '../lib/types.js';
import { publicShareUrl, publicSourceUrl } from '../lib/url.js';
import type { RecipeClassifier } from '../services/classify.js';
import { createPassthroughRehoster } from '../services/rehost.js';

/**
 * Discover's promises, pinned: search returns previews (never steps), save
 * hands out the full recipe and counts each device once, published links are
 * rebuilt from the canonical id (no share ids, no private query strings), and
 * three reports hide an entry.
 */

const PEPPER = 'test-pepper';

const recipe = (over: Partial<ExtractedRecipe> = {}): ExtractedRecipe => ({
  sourceUrl: 'https://www.instagram.com/reel/ABC123/?igsh=sharer-id',
  sourcePlatform: 'instagram',
  title: 'Chicken tikka masala',
  imageRemoteUrl: 'https://scontent.cdninstagram.com/v/photo.jpg',
  category: 'meals',
  servings: 4,
  ingredients: ['500 g chicken thighs', '200 ml cream', '2 tbsp garam masala'],
  steps: ['Marinate the chicken.', 'Simmer in the sauce.'],
  macros: { calories: 520, carbs: 12, protein: 38, fat: 30 },
  macrosSource: 'estimated',
  ...over,
});

function setup(options: { classifier?: RecipeClassifier; configured?: boolean } = {}) {
  const db = createMemoryDiscoverDb();
  const communityDb = createMemoryCommunityDb();
  const store = createStore({ upstashUrl: '', upstashToken: '' });
  const app = buildApp({
    instagramScraper: { scrape: vi.fn() },
    tiktokScraper: { scrape: vi.fn() },
    webScraper: { scrape: vi.fn() },
    parser: { parse: vi.fn() },
    improver: {} as AppDeps['improver'],
    photoSearch: { search: vi.fn(async () => null) },
    nutrition: { search: vi.fn(async () => null) },
    appSharedSecret: '',
    store,
    communityDb,
    discoverDb: options.configured === false ? undefined : db,
    classifier: options.classifier,
    communityHashPepper: PEPPER,
    rateLimit: { max: 1000, windowMs: 60_000 },
  } as AppDeps);
  const indexer = createDiscoverIndexer({
    db,
    store,
    classifier: options.classifier,
    rehoster: createPassthroughRehoster(),
    dailyClassifyLimit: 100,
  });

  const as = (deviceId: string | null) => {
    const headers: Record<string, string> = deviceId ? { 'x-morsel-device-id': deviceId } : {};
    return {
      get: (url: string) => app.inject({ method: 'GET', url, headers }),
      post: (url: string, payload: unknown = {}) =>
        app.inject({ method: 'POST', url, headers, payload: payload as object }),
    };
  };

  return { app, db, communityDb, indexer, as };
}

describe('publicSourceUrl', () => {
  it('rebuilds social links from the canonical id, dropping share ids', () => {
    expect(publicSourceUrl('ig:ABC123')).toBe('https://www.instagram.com/p/ABC123/');
    expect(publicSourceUrl('tt:7300000000000000000', 'chef.dan')).toBe(
      'https://www.tiktok.com/@chef.dan/video/7300000000000000000',
    );
  });

  it('keeps allowlisted web params and refuses anything else', () => {
    expect(publicSourceUrl('web:example.com/recipes/curry')).toBe('https://example.com/recipes/curry');
    expect(publicSourceUrl('web:example.com/?p=42')).toBe('https://example.com/?p=42');
    expect(publicSourceUrl('web:example.com/recipe?token=secret')).toBeNull();
    expect(publicSourceUrl('raw:not a url')).toBeNull();
  });

  it('strips a private-looking query from a shared link instead of refusing it', () => {
    expect(publicShareUrl('https://example.com/recipe?session=abc&utm_source=x', 'web')).toBe(
      'https://example.com/recipe',
    );
    expect(publicShareUrl('https://www.instagram.com/reel/XYZ/?igsh=abc', 'instagram')).toBe(
      'https://www.instagram.com/p/XYZ/',
    );
  });
});

describe('discover indexer', () => {
  it('indexes under the public link and tags with the classifier', async () => {
    const classifier = { classify: vi.fn(async () => ({ dietTags: ['high_protein' as const], totalMinutes: 45, difficulty: 'medium' as const })) };
    const { db, indexer } = setup({ classifier });
    expect(await indexer.index('ig:ABC123', recipe(), 'chef.dan')).toBe(true);

    const [row] = db.admin.rows();
    expect(row.source_url).toBe('https://www.instagram.com/p/ABC123/');
    expect(row.recipe.sourceUrl).toBe('https://www.instagram.com/p/ABC123/');
    expect(JSON.stringify(row)).not.toContain('sharer-id');
    expect(row.creator).toBe('@chef.dan');
    expect(row.diet_tags).toEqual(['high_protein']);
    expect(row.total_minutes).toBe(45);
    expect(classifier.classify).toHaveBeenCalledTimes(1);

    // Re-indexing refreshes the recipe but keeps tags and doesn't re-classify.
    await indexer.index('ig:ABC123', recipe({ title: 'Better tikka' }));
    expect(db.admin.rows()[0]).toMatchObject({ title: 'Better tikka', diet_tags: ['high_protein'] });
    expect(classifier.classify).toHaveBeenCalledTimes(1);
  });

  it('never indexes a web page whose query could be private', async () => {
    const { db, indexer } = setup();
    expect(await indexer.index('web:example.com/recipe?token=abc', recipe({ sourcePlatform: 'web' }))).toBe(false);
    expect(db.admin.rows()).toHaveLength(0);
  });

  it('survives a classifier failure and lets the sweep retry', async () => {
    const classify = vi
      .fn()
      .mockRejectedValueOnce(new Error('gemini down'))
      .mockResolvedValue({ dietTags: ['vegan'], totalMinutes: 20, difficulty: 'easy' });
    const { db, indexer } = setup({ classifier: { classify } });
    expect(await indexer.index('ig:ABC123', recipe())).toBe(true);
    expect(db.admin.rows()[0].classified_at).toBeNull();
    expect(await indexer.sweep(10)).toBe(1);
    expect(db.admin.rows()[0].diet_tags).toEqual(['vegan']);
  });
});

describe('discover routes', () => {
  it('answers 503 when no index is configured', async () => {
    const { as } = setup({ configured: false });
    expect((await as('alice').get('/discover/search')).statusCode).toBe(503);
  });

  it('searches by prefix and filters, returning previews without steps', async () => {
    const { db, indexer, as } = setup();
    await indexer.index('ig:ABC123', recipe());
    await indexer.index('web:example.com/salad', recipe({ sourcePlatform: 'web', title: 'Green salad', ingredients: ['lettuce'], macros: { calories: 120, carbs: 8, protein: 3, fat: 9 } }));
    await db.setFacets('web:example.com/salad', { dietTags: ['vegan'], totalMinutes: 10, difficulty: 'easy' });

    const all = (await as(null).get('/discover/search')).json();
    expect(all.items).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain('Marinate');

    const chick = (await as(null).get('/discover/search?q=chick')).json();
    expect(chick.items.map((i: { title: string }) => i.title)).toEqual(['Chicken tikka masala']);

    const vegan = (await as(null).get('/discover/search?diet=vegan&maxMinutes=15')).json();
    expect(vegan.items).toHaveLength(1);
    expect(vegan.items[0]).toMatchObject({ title: 'Green salad', creator: 'example.com', dietTags: ['vegan'] });

    const light = (await as(null).get('/discover/search?maxCalories=200')).json();
    expect(light.items).toHaveLength(1);

    const detail = (await as(null).get(`/discover/items/${vegan.items[0].id}`)).json();
    expect(detail.item.ingredients).toEqual(['lettuce']);
    expect(detail.item.steps).toBeUndefined();
  });

  it('hands out the full recipe on save and counts each device once', async () => {
    const { db, indexer, as } = setup();
    await indexer.index('ig:ABC123', recipe());
    const id = db.admin.rows()[0].id;

    expect((await as(null).post(`/discover/items/${id}/save`)).statusCode).toBe(400);
    const saved = await as('alice').post(`/discover/items/${id}/save`);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().recipe).toMatchObject({
      steps: ['Marinate the chicken.', 'Simmer in the sauce.'],
      sourceUrl: 'https://www.instagram.com/p/ABC123/',
    });
    await as('alice').post(`/discover/items/${id}/save`);
    await as('bob').post(`/discover/items/${id}/save`);
    expect(db.admin.rows()[0].save_count).toBe(2);
  });

  it('caps saves per device per day', async () => {
    const { db, indexer, as } = setup();
    await indexer.index('ig:ABC123', recipe());
    const id = db.admin.rows()[0].id;
    for (let i = 0; i < 50; i++) await as('alice').post(`/discover/items/${id}/save`);
    expect((await as('alice').post(`/discover/items/${id}/save`)).statusCode).toBe(429);
  });

  it('hides an entry after three distinct reports, and refuses banned devices', async () => {
    const { db, communityDb, indexer, as } = setup();
    await indexer.index('ig:ABC123', recipe());
    const id = db.admin.rows()[0].id;
    for (const who of ['a', 'b', 'b', 'c']) {
      expect((await as(who).post('/discover/reports', { targetId: id, reason: 'spam' })).statusCode).toBe(200);
    }
    expect((await as(null).get('/discover/search')).json().items).toHaveLength(0);
    expect((await as('d').get(`/discover/items/${id}`)).statusCode).toBe(404);

    await indexer.index('ig:OTHER', recipe());
    const other = db.admin.rows().find((r) => r.canonical_key === 'ig:OTHER')!;
    const { createHash } = await import('node:crypto');
    communityDb.admin.ban(createHash('sha256').update(`${PEPPER}:mallory`).digest('hex'));
    expect((await as('mallory').post(`/discover/items/${other.id}/save`)).statusCode).toBe(403);
  });
});
