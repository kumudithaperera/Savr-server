import { describe, expect, it, vi } from 'vitest';

import { createBrandFirstNutritionLookup, createDeepSeekNutritionLookup } from './nutrition.js';
import type { FoodNutrition, NutritionLookup } from './nutrition.js';
import type { OffLookup } from './openfoodfacts.js';

const macros = {
  caloriesPer100g: 359,
  proteinPer100g: 13,
  carbsPer100g: 71,
  fatPer100g: 2,
};

const micros = {
  fiberG: 3,
  sugarsG: 3.5,
  sodiumMg: 4,
  potassiumMg: 0,
  calciumMg: 0,
  ironMg: 0,
  magnesiumMg: 0,
  zincMg: 0,
  saturatedFatG: 0.5,
  monounsaturatedFatG: 0,
  polyunsaturatedFatG: 0,
  cholesterolMg: 0,
  vitaminCMg: 0,
  vitaminARaeUg: 0,
  vitaminDUg: 0,
};

const usdaValue: FoodNutrition = { macros: { ...macros, caloriesPer100g: 100 }, micros };
const offValue: FoodNutrition = { macros, micros };
const deepseekValue: FoodNutrition = { macros: { ...macros, caloriesPer100g: 250 }, micros };

function stubLookup(result: FoodNutrition | null | 'throw'): NutritionLookup {
  return {
    search: vi.fn(async () => {
      if (result === 'throw') throw new Error('USDA down');
      return result;
    }),
  };
}

function stubOff(result: FoodNutrition | null | 'throw'): OffLookup {
  return {
    search: vi.fn(async (_query, _opts) => {
      if (result === 'throw') throw new Error('OFF down');
      return result;
    }),
  };
}

describe('createBrandFirstNutritionLookup', () => {
  it('routes a generic ingredient straight to USDA without ever calling OFF', async () => {
    const usda = stubLookup(usdaValue);
    const off = stubOff(offValue);
    const lookup = createBrandFirstNutritionLookup({ usda, off });

    await expect(lookup.search('plain flour')).resolves.toEqual({ nutrition: usdaValue, source: 'usda' });
    expect(usda.search).toHaveBeenCalledWith('plain flour');
    expect(off.search).not.toHaveBeenCalled();
  });

  it('uses OFF label data when the ingredient names a brand and OFF has it', async () => {
    const usda = stubLookup(usdaValue);
    const off = stubOff(offValue);
    const lookup = createBrandFirstNutritionLookup({ usda, off });

    await expect(lookup.search('Barilla spaghetti')).resolves.toEqual({ nutrition: offValue, source: 'openfoodfacts' });
    expect(off.search).toHaveBeenCalledWith('Barilla spaghetti', { brandTokens: ['barilla'] });
    expect(usda.search).not.toHaveBeenCalled();
  });

  it('falls back to USDA when OFF has no product carrying the brand', async () => {
    const usda = stubLookup(usdaValue);
    const off = stubOff(null);
    const lookup = createBrandFirstNutritionLookup({ usda, off });

    await expect(lookup.search('Barilla spaghetti')).resolves.toEqual({ nutrition: usdaValue, source: 'usda' });
    expect(off.search).toHaveBeenCalledWith('Barilla spaghetti', { brandTokens: ['barilla'] });
    expect(usda.search).toHaveBeenCalledWith('Barilla spaghetti');
  });

  it('falls back to USDA when OFF is unreachable instead of failing the check', async () => {
    const usda = stubLookup(usdaValue);
    const off = stubOff('throw');
    const lookup = createBrandFirstNutritionLookup({ usda, off });

    await expect(lookup.search('Barilla spaghetti')).resolves.toEqual({ nutrition: usdaValue, source: 'usda' });
    expect(usda.search).toHaveBeenCalledWith('Barilla spaghetti');
  });

  it('passes an empty query through to USDA unchanged', async () => {
    const usda = stubLookup(usdaValue);
    const off = stubOff(offValue);
    const lookup = createBrandFirstNutritionLookup({ usda, off });

    await expect(lookup.search('   ')).resolves.toEqual({ nutrition: usdaValue, source: 'usda' });
    expect(usda.search).toHaveBeenCalledWith('   ');
    expect(off.search).not.toHaveBeenCalled();
  });

  it('falls back to DeepSeek when USDA throws (e.g. rate limit) for a generic ingredient', async () => {
    const usda = stubLookup('throw');
    const off = stubOff(offValue);
    const deepseek = stubLookup(deepseekValue);
    const lookup = createBrandFirstNutritionLookup({ usda, off, deepseek });

    await expect(lookup.search('plain flour')).resolves.toEqual({ nutrition: deepseekValue, source: 'deepseek' });
    expect(usda.search).toHaveBeenCalledWith('plain flour');
    expect(off.search).not.toHaveBeenCalled();
    expect(deepseek.search).toHaveBeenCalledWith('plain flour');
  });

  it('falls back to DeepSeek when USDA throws for a branded ingredient', async () => {
    const usda = stubLookup('throw');
    const off = stubOff(null);
    const deepseek = stubLookup(deepseekValue);
    const lookup = createBrandFirstNutritionLookup({ usda, off, deepseek });

    await expect(lookup.search('Barilla spaghetti')).resolves.toEqual({ nutrition: deepseekValue, source: 'deepseek' });
    expect(off.search).toHaveBeenCalledWith('Barilla spaghetti', { brandTokens: ['barilla'] });
    expect(usda.search).toHaveBeenCalledWith('Barilla spaghetti');
    expect(deepseek.search).toHaveBeenCalledWith('Barilla spaghetti');
  });

  it('returns null when USDA throws and DeepSeek is unavailable', async () => {
    const usda = stubLookup('throw');
    const off = stubOff(null);
    const lookup = createBrandFirstNutritionLookup({ usda, off });

    await expect(lookup.search('plain flour')).resolves.toBeNull();
  });

  it('falls back to DeepSeek when OFF throws and USDA throws', async () => {
    const usda = stubLookup('throw');
    const off = stubOff('throw');
    const deepseek = stubLookup(deepseekValue);
    const lookup = createBrandFirstNutritionLookup({ usda, off, deepseek });

    await expect(lookup.search('Barilla spaghetti')).resolves.toEqual({ nutrition: deepseekValue, source: 'deepseek' });
    expect(deepseek.search).toHaveBeenCalledWith('Barilla spaghetti');
  });
});

describe('createDeepSeekNutritionLookup', () => {
  const deepseek = {
    deepseekApiKey: 'test-key',
    deepseekModel: 'deepseek-chat',
    deepseekBaseUrl: 'https://api.deepseek.com',
  };

  const nutritionJson = JSON.stringify({
    caloriesPer100g: 359,
    proteinPer100g: 13,
    carbsPer100g: 71,
    fatPer100g: 2,
    fiberG: 3,
    sugarsG: 3.5,
    sodiumMg: 4,
    potassiumMg: 0,
    calciumMg: 0,
    ironMg: 0,
    magnesiumMg: 0,
    zincMg: 0,
    saturatedFatG: 0.5,
    monounsaturatedFatG: 0,
    polyunsaturatedFatG: 0,
    cholesterolMg: 0,
    vitaminCMg: 0,
    vitaminARaeUg: 0,
    vitaminDUg: 0,
  });

  const deepseekResponse = JSON.stringify({
    choices: [{ message: { content: nutritionJson } }],
  });

  function stubFetch(status: number, body: string, calls: unknown[]) {
    return vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        json: async () => JSON.parse(body),
      } as Response;
    }) as unknown as typeof fetch;
  }

  it('parses a valid DeepSeek response into FoodNutrition', async () => {
    const calls: unknown[] = [];
    const lookup = createDeepSeekNutritionLookup(deepseek, stubFetch(200, deepseekResponse, calls));

    const result = await lookup.search('plain flour');
    expect(result).toEqual({ macros, micros });
    expect(calls).toHaveLength(1);

    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'deepseek-chat',
      temperature: 0.1,
    });
  });

  it('returns null when DeepSeek is unreachable', async () => {
    const lookup = createDeepSeekNutritionLookup(
      deepseek,
      vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    );

    await expect(lookup.search('plain flour')).rejects.toThrow('Could not reach DeepSeek');
  });

  it('returns null when DeepSeek returns no content in message', async () => {
    const emptyResponse = JSON.stringify({ choices: [{ message: { content: '' } }] });
    const lookup = createDeepSeekNutritionLookup(deepseek, stubFetch(200, emptyResponse, []));

    await expect(lookup.search('plain flour')).resolves.toBeNull();
  });

  it('returns null when DeepSeek returns no choices', async () => {
    const noChoices = JSON.stringify({ choices: [] });
    const lookup = createDeepSeekNutritionLookup(deepseek, stubFetch(200, noChoices, []));

    await expect(lookup.search('plain flour')).resolves.toBeNull();
  });

  it('returns null for an empty query without calling DeepSeek', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const lookup = createDeepSeekNutritionLookup(deepseek, fetchImpl);

    await expect(lookup.search('   ')).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws upstreamError when DeepSeek returns a non-OK status', async () => {
    const lookup = createDeepSeekNutritionLookup(deepseek, stubFetch(401, 'unauthorized', []));

    await expect(lookup.search('plain flour')).rejects.toThrow('HTTP 401');
  });

  it('throws upstreamError when DeepSeek returns an API error', async () => {
    const errorResponse = JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit' } });
    const lookup = createDeepSeekNutritionLookup(deepseek, stubFetch(200, errorResponse, []));

    await expect(lookup.search('plain flour')).rejects.toThrow('rate limit exceeded');
  });
});