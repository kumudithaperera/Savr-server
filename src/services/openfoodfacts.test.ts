import { describe, expect, it, vi } from 'vitest';

import { createOpenFoodFactsLookup } from './openfoodfacts.js';

/**
 * Fake fetch that records the request headers and returns OFF hits shaped like
 * search-a-licious (`{ hits: [...] }`).
 */
/**
 * Fake fetch that records the request headers and returns OFF hits shaped like
 * search-a-licious (`{ hits: [...] }`).
 */
function hitFetch(hits: unknown[]) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({ hits }),
  } as unknown as Response));
}

const PLAIN_HIT = {
  code: '76808005',
  brands: ['Barilla'],
  completeness: 0.8,
  product_name: 'Barilla Spaghetti',
  nutriments: {
    'energy-kcal_100g': 359,
    proteins_100g: 13,
    carbohydrates_100g: 71,
    fat_100g: 2,
    fiber_100g: 3,
    sugars_100g: 3.5,
    saturated_fat_100g: 0.5,
    sodium_100g: 0.004,
  },
};

describe('createOpenFoodFactsLookup', () => {
  it('sends the OFF-compliant `AppName/Version (ContactEmail)` User-Agent', async () => {
    const fetchImpl = hitFetch([PLAIN_HIT]);
    const lookup = createOpenFoodFactsLookup({
      contactEmail: 'ops@morsel.app',
      fetchImpl,
    });

    await lookup.search('Barilla spaghetti', { brandTokens: ['barilla'] });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ 'User-Agent': 'Morsel/1.0 (ops@morsel.app)' });
  });

  it('still sends a User-Agent (non-compliant placeholder) when no email is configured', async () => {
    const fetchImpl = hitFetch([PLAIN_HIT]);
    const lookup = createOpenFoodFactsLookup({ fetchImpl });

    await lookup.search('Barilla spaghetti', { brandTokens: ['barilla'] });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ 'User-Agent': 'Morsel/1.0 (no-contact-email)' });
  });

  it('only accepts a product carrying one of the brand tokens', async () => {
    const fetchImpl = hitFetch([
      { ...PLAIN_HIT, code: '1', brands: ['Generica'], completeness: 1 },
      { ...PLAIN_HIT, code: '2', brands: ['Barilla', 'BARILLA NORGE AS'], completeness: 0.8 },
    ]);
    const lookup = createOpenFoodFactsLookup({ contactEmail: 'ops@morsel.app', fetchImpl });

    const result = await lookup.search('Barilla spaghetti', { brandTokens: ['barilla'] });
    expect(result?.macros.caloriesPer100g).toBe(359);
  });

  it('returns null when no product carries the brand', async () => {
    const fetchImpl = hitFetch([{ ...PLAIN_HIT, brands: ['Generica'] }]);
    const lookup = createOpenFoodFactsLookup({ contactEmail: 'ops@morsel.app', fetchImpl });

    await expect(
      lookup.search('Barilla spaghetti', { brandTokens: ['barilla'] }),
    ).resolves.toBeNull();
  });

  it('returns null on a non-OK response instead of failing the check', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      ({ ok: false, status: 503 }) as unknown as Response);
    const lookup = createOpenFoodFactsLookup({ contactEmail: 'ops@morsel.app', fetchImpl });

    await expect(lookup.search('Barilla spaghetti')).resolves.toBeNull();
  });

  it('serves a repeat query from cache without a second request', async () => {
    const fetchImpl = hitFetch([PLAIN_HIT]);
    const lookup = createOpenFoodFactsLookup({ contactEmail: 'ops@morsel.app', fetchImpl });

    const first = await lookup.search('Barilla spaghetti', { brandTokens: ['barilla'] });
    const second = await lookup.search('Barilla spaghetti', { brandTokens: ['barilla'] });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops searching OFF once the per-minute budget is spent, instead of risking a ban', async () => {
    const fetchImpl = hitFetch([PLAIN_HIT]);
    let t = 0;
    const lookup = createOpenFoodFactsLookup({ contactEmail: 'ops@morsel.app', fetchImpl, now: () => t });

    // The budget allows 8 searches per rolling minute; distinct queries only,
    // since repeats are served from cache.
    for (let i = 0; i < 8; i++) {
      const r = await lookup.search(`Barilla product ${i}`, { brandTokens: ['barilla'] });
      expect(r?.macros.caloriesPer100g).toBe(359);
    }
    // 9th distinct query inside the window: declined so USDA answers instead.
    await expect(lookup.search('Barilla product 9', { brandTokens: ['barilla'] })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(8);

    // A minute later the budget resets and OFF answers again.
    t = 61_000;
    await expect(lookup.search('Barilla product 9', { brandTokens: ['barilla'] })).resolves.toMatchObject({
      macros: { caloriesPer100g: 359 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(9);
  });

  it('expires cached results after the TTL and searches again', async () => {
    const fetchImpl = hitFetch([PLAIN_HIT]);
    let t = 0;
    const lookup = createOpenFoodFactsLookup({ contactEmail: 'ops@morsel.app', fetchImpl, now: () => t });

    await lookup.search('Barilla spaghetti', { brandTokens: ['barilla'] });
    t = 10 * 60_000 + 1;
    await lookup.search('Barilla spaghetti', { brandTokens: ['barilla'] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});