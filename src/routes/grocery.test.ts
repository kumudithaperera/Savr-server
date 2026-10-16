import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from '../app.js';
import { createStore } from '../lib/store.js';
import { cleanProfile, type FoodProfiler } from '../services/food-profiles.js';
import { GROCERY_LIMITS, parseKeys } from './grocery.js';

/**
 * Food weights for the grocery list, pinned: validated keys, one model call
 * per unknown food ever (answers and "couldn't weigh it" are both cached),
 * implausible answers dropped, and a per-device daily cap.
 */

function setup(profile: FoodProfiler['profile'] = async (keys) =>
  Object.fromEntries(keys.map((key) => [key, { gPerCup: 100, sold: 'weight' as const }]))) {
  const foodProfiler = { profile: vi.fn(profile) };
  const app = buildApp({
    instagramScraper: { scrape: vi.fn() },
    tiktokScraper: { scrape: vi.fn() },
    webScraper: { scrape: vi.fn() },
    parser: { parse: vi.fn() },
    improver: {} as AppDeps['improver'],
    photoSearch: { search: vi.fn(async () => null) },
    nutrition: { search: vi.fn(async () => null) },
    appSharedSecret: '',
    store: createStore({ upstashUrl: '', upstashToken: '' }),
    foodProfiler,
    rateLimit: { max: 1000, windowMs: 60_000 },
  } as AppDeps);
  const post = (keys: unknown, device = 'device-1') =>
    app.inject({ method: 'POST', url: '/grocery/profiles', headers: { 'x-morsel-device-id': device }, payload: { keys } });
  return { app, post, foodProfiler };
}

describe('POST /grocery/profiles', () => {
  it('asks the model once per food, then answers from the cache', async () => {
    const { post, foodProfiler } = setup();
    const first = await post(['Okra', 'okra', 'snake gourd']);
    expect(first.statusCode).toBe(200);
    expect(first.json().profiles).toEqual({
      okra: { gPerCup: 100, sold: 'weight' },
      'snake gourd': { gPerCup: 100, sold: 'weight' },
    });
    expect(foodProfiler.profile).toHaveBeenCalledWith(['okra', 'snake gourd']);

    const second = await post(['okra', 'snake gourd'], 'device-2');
    expect(second.json().profiles.okra).toEqual({ gPerCup: 100, sold: 'weight' });
    expect(foodProfiler.profile).toHaveBeenCalledTimes(1);
  });

  it('caches foods it could not weigh, so they are not asked again', async () => {
    const { post, foodProfiler } = setup(async (keys) => Object.fromEntries(keys.map((key) => [key, null])));
    await post(['aunties chilli paste']);
    const again = await post(['aunties chilli paste']);
    expect(again.json().profiles).toEqual({ 'aunties chilli paste': null });
    expect(foodProfiler.profile).toHaveBeenCalledTimes(1);
  });

  it('rejects bad bodies before anything is charged', async () => {
    const { post, foodProfiler } = setup();
    expect((await post('okra')).statusCode).toBe(422);
    expect((await post(['<script>'])).statusCode).toBe(422);
    expect((await post(Array.from({ length: GROCERY_LIMITS.maxKeys + 1 }, (_, i) => `food ${'x'.repeat(i % 5)}`))).statusCode).toBe(422);
    expect(foodProfiler.profile).not.toHaveBeenCalled();
  });

  it('caps model calls per device per day', async () => {
    const { post } = setup();
    for (let i = 0; i < GROCERY_LIMITS.deviceDaily; i++) {
      expect((await post([`food ${String.fromCharCode(97 + i)}`])).statusCode).toBe(200);
    }
    expect((await post(['one more food'])).statusCode).toBe(429);
  });
});

describe('parseKeys', () => {
  it('normalizes and de-duplicates', () => {
    expect(parseKeys(['  Bitter  Gourd ', 'bitter gourd', "lady's finger"])).toEqual(['bitter gourd', "lady's finger"]);
  });
});

describe('cleanProfile', () => {
  it('keeps plausible weights and drops the rest', () => {
    expect(cleanProfile({ isFood: true, sold: 'weight', gramsPerCup: 99.6, gramsPerPiece: 12 })).toEqual({
      gPerCup: 100,
      gPerPiece: 12,
      sold: 'weight',
    });
    expect(cleanProfile({ isFood: true, sold: 'weight', gramsPerCup: 40000 })).toBeNull();
    expect(cleanProfile({ isFood: false, sold: 'weight', gramsPerCup: 100 })).toBeNull();
    // "Bought by the piece" with no piece weight is sold by weight instead.
    expect(cleanProfile({ isFood: true, sold: 'piece', gramsPerCup: 120 })).toMatchObject({ sold: 'weight' });
  });
});
