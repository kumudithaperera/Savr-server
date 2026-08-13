import { describe, expect, it, vi } from 'vitest';

import { createBrandFirstNutritionLookup } from './nutrition.js';
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

function stubLookup(result: FoodNutrition | null): NutritionLookup {
  return { search: vi.fn(async () => result) };
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

    await expect(lookup.search('plain flour')).resolves.toEqual(usdaValue);
    expect(usda.search).toHaveBeenCalledWith('plain flour');
    expect(off.search).not.toHaveBeenCalled();
  });

  it('uses OFF label data when the ingredient names a brand and OFF has it', async () => {
    const usda = stubLookup(usdaValue);
    const off = stubOff(offValue);
    const lookup = createBrandFirstNutritionLookup({ usda, off });

    await expect(lookup.search('Barilla spaghetti')).resolves.toEqual(offValue);
    expect(off.search).toHaveBeenCalledWith('Barilla spaghetti', { brandTokens: ['barilla'] });
    expect(usda.search).not.toHaveBeenCalled();
  });

  it('falls back to USDA when OFF has no product carrying the brand', async () => {
    const usda = stubLookup(usdaValue);
    const off = stubOff(null);
    const lookup = createBrandFirstNutritionLookup({ usda, off });

    await expect(lookup.search('Barilla spaghetti')).resolves.toEqual(usdaValue);
    expect(off.search).toHaveBeenCalledWith('Barilla spaghetti', { brandTokens: ['barilla'] });
    expect(usda.search).toHaveBeenCalledWith('Barilla spaghetti');
  });

  it('falls back to USDA when OFF is unreachable instead of failing the check', async () => {
    const usda = stubLookup(usdaValue);
    const off = stubOff('throw');
    const lookup = createBrandFirstNutritionLookup({ usda, off });

    await expect(lookup.search('Barilla spaghetti')).resolves.toEqual(usdaValue);
    expect(usda.search).toHaveBeenCalledWith('Barilla spaghetti');
  });

  it('passes an empty query through to USDA unchanged', async () => {
    const usda = stubLookup(usdaValue);
    const off = stubOff(offValue);
    const lookup = createBrandFirstNutritionLookup({ usda, off });

    await expect(lookup.search('   ')).resolves.toEqual(usdaValue);
    expect(usda.search).toHaveBeenCalledWith('   ');
    expect(off.search).not.toHaveBeenCalled();
  });
});