import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from '../app.js';
import { createMemoryCommunityDb } from '../lib/community-db.js';
import { createMemoryDiscoverDb } from '../lib/discover-db.js';
import { facetColumns, filterParams, plannerTerms, type RecipeFilters } from '../lib/recipe-facets.js';
import { createMemoryRecipeFeedDb } from '../lib/recipe-feed-db.js';
import { createStore } from '../lib/store.js';
import type { ExtractedRecipe } from '../lib/types.js';
import { PLANNER_DAILY_CAP } from './planner.js';

/**
 * The planner's candidate route, pinned: it filters by diet tags, calories,
 * category and excluded ingredients, returns ingredients but never steps,
 * mixes both sources, and is capped per device per day.
 */

const PEPPER = 'test-pepper';

const recipe = (over: Partial<ExtractedRecipe> = {}): ExtractedRecipe => ({
  sourceUrl: 'https://example.com/recipe',
  sourcePlatform: 'web',
  title: 'Chicken rice bowl',
  category: 'meals',
  servings: 2,
  ingredients: ['200 g chicken breast', '1 cup rice', '1 cup broccoli'],
  steps: ['Cook the rice.', 'Grill the chicken.'],
  macros: { calories: 600, carbs: 60, protein: 45, fat: 15 },
  macrosSource: 'estimated',
  ...over,
});

async function setup() {
  const discoverDb = createMemoryDiscoverDb();
  const recipeFeedDb = createMemoryRecipeFeedDb();
  const store = createStore({ upstashUrl: '', upstashToken: '' });
  const communityDb = createMemoryCommunityDb();
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
    discoverDb,
    recipeFeedDb,
    communityHashPepper: PEPPER,
    rateLimit: { max: 1000, windowMs: 60_000 },
  } as AppDeps);

  const index = async (key: string, r: ExtractedRecipe, dietTags: ('vegetarian' | 'high_protein')[] = []) => {
    await discoverDb.upsert({
      canonical_key: key,
      source_url: r.sourceUrl,
      source_platform: 'web',
      creator: null,
      image_url: null,
      servings: r.servings ?? null,
      ingredients: r.ingredients,
      recipe: r,
      ...facetColumns(r, null),
    });
    await discoverDb.setFacets(key, { dietTags, totalMinutes: null });
  };

  await index('web:chicken', recipe(), ['high_protein']);
  await index('web:salad', recipe({ title: 'Lentil salad', ingredients: ['1 cup lentils', '1 cucumber'], macros: { calories: 400, carbs: 50, protein: 20, fat: 10 } }), ['vegetarian']);
  await index('web:pb', recipe({ title: 'Peanut noodles', ingredients: ['200 g noodles', '3 tbsp peanut butter'] }), ['vegetarian']);
  await index('web:huge', recipe({ title: 'Giant lasagne', macros: { calories: 1800, carbs: 150, protein: 80, fat: 90 } }));
  await index('web:drink', recipe({ title: 'Green smoothie', category: 'drinks', macros: { calories: 300, carbs: 50, protein: 5, fat: 5 } }), ['vegetarian']);

  const post = recipe({ title: 'Veggie tacos', ingredients: ['4 tortillas', '1 can black beans'], macros: { calories: 550, carbs: 70, protein: 20, fat: 18 } });
  await recipeFeedDb.insert({
    author_hash: 'someone-else',
    author_name: null,
    remix_of: null,
    note: '',
    image_url: null,
    source_url: null,
    source_platform: 'manual',
    servings: 2,
    recipe: { ...post, sourcePlatform: 'manual' },
    needs_review: false,
    ...facetColumns(post, { dietTags: ['vegetarian'], totalMinutes: null }),
  });

  const ask = (payload: unknown, deviceId: string | null = 'device-1') =>
    app.inject({
      method: 'POST',
      url: '/planner/candidates',
      headers: deviceId ? { 'x-morsel-device-id': deviceId } : {},
      payload: payload as object,
    });

  return { ask, communityDb };
}

describe('POST /planner/candidates', () => {
  it('returns candidates from both sources, with ingredients and without steps', async () => {
    const { ask } = await setup();
    const res = await ask({ minKcal: 200, maxKcal: 1000, limit: 20 });
    expect(res.statusCode).toBe(200);
    const { candidates } = res.json();
    const titles = candidates.map((c: { title: string }) => c.title).sort();
    expect(titles).toEqual(['Chicken rice bowl', 'Lentil salad', 'Peanut noodles', 'Veggie tacos']);
    expect(candidates.find((c: { kind: string }) => c.kind === 'post').ingredients).toEqual(['4 tortillas', '1 can black beans']);
    for (const c of candidates) {
      // The grocery list scales ingredients by planned portions / servings.
      expect(c.servings).toBe(2);
      expect(c.ingredients.length).toBeGreaterThan(0);
      expect(c).not.toHaveProperty('steps');
      expect(c).not.toHaveProperty('recipe');
    }
  });

  it('filters by diet tags, excluded ingredients and calories', async () => {
    const { ask } = await setup();
    const res = await ask({ dietTags: ['vegetarian'], excluded: ['Peanut'], minKcal: 450, maxKcal: 900, limit: 20 });
    const titles = res.json().candidates.map((c: { title: string }) => c.title);
    expect(titles).toEqual(['Veggie tacos']);
  });

  it('leaves out recipes from authors the caller blocked', async () => {
    const { ask, communityDb } = await setup();
    const hash = createHash('sha256').update(`${PEPPER}:device-1`).digest('hex');
    await communityDb.insertBlock({ hash, userId: null }, 'someone-else', null);
    const titles = (await ask({ minKcal: 200, maxKcal: 1000, limit: 20 })).json().candidates.map((c: { title: string }) => c.title);
    expect(titles).not.toContain('Veggie tacos');
    const other = (await ask({ minKcal: 200, maxKcal: 1000, limit: 20 }, 'device-2')).json().candidates;
    expect(other.map((c: { title: string }) => c.title)).toContain('Veggie tacos');
  });

  it('needs a device id', async () => {
    const { ask } = await setup();
    expect((await ask({}, null)).statusCode).toBe(400);
  });

  it('caps requests per device per day', async () => {
    const { ask } = await setup();
    for (let i = 0; i < PLANNER_DAILY_CAP; i++) expect((await ask({ limit: 1 })).statusCode).toBe(200);
    expect((await ask({ limit: 1 })).statusCode).toBe(429);
    expect((await ask({ limit: 1 }, 'device-2')).statusCode).toBe(200);
  });
});

describe('planner filters', () => {
  it('reduces excluded terms to plain words', () => {
    expect(plannerTerms(['Pine Nuts', 'egg*', ' ', 'a,b', 42, 'pine nuts'])).toEqual(['pine nuts', 'egg', 'a b']);
    expect(plannerTerms('nuts')).toEqual([]);
  });

  it('translates to PostgREST params', () => {
    const filters: RecipeFilters = {
      terms: [],
      category: null,
      categories: ['meals', 'snacks'],
      diet: ['vegan'],
      maxCalories: 800,
      minCalories: 200,
      maxMinutes: null,
      excluded: ['pine nuts'],
    };
    expect(filterParams(filters)).toEqual([
      'diet_tags=cs.{vegan}',
      'calories=lte.800',
      'calories=gte.200',
      'category=in.(meals,snacks)',
      'search_text=not.ilike.*pine%20nuts*',
    ]);
  });
});
