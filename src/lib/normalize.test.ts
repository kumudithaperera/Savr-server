import { describe, expect, it } from 'vitest';

import { normalizeRecipe } from './normalize.js';
import { HttpError } from './errors.js';
import type { ParsedRecipe, ScrapedPost } from './types.js';

const scraped: ScrapedPost = {
  caption: 'Protein pancakes',
  imageUrl: 'https://example.com/img.jpg',
};

const baseParsed: ParsedRecipe = {
  title: 'Protein Pancakes',
  servings: 2,
  ingredients: ['1 banana', '2 eggs'],
  steps: ['Blend', 'Cook'],
  macros: { calories: 300, carbs: 30, protein: 20, fat: 10 },
  macrosStatedInCaption: false,
  suggestedCategory: 'meals',
};

describe('normalizeRecipe', () => {
  it('marks macros as estimated when not stated in caption', () => {
    const recipe = normalizeRecipe('https://instagram.com/p/x', 'instagram', scraped, baseParsed);
    expect(recipe.macrosSource).toBe('estimated');
    expect(recipe.imageRemoteUrl).toBe('https://example.com/img.jpg');
  });

  it('passes through the source platform', () => {
    const recipe = normalizeRecipe('https://example.com/r/1', 'web', scraped, baseParsed);
    expect(recipe.sourcePlatform).toBe('web');
  });

  it('marks macros as caption when stated', () => {
    const recipe = normalizeRecipe('https://instagram.com/p/x', 'instagram', scraped,{
      ...baseParsed,
      macrosStatedInCaption: true,
    });
    expect(recipe.macrosSource).toBe('caption');
  });

  it('falls back to "meals" for an invalid category', () => {
    const recipe = normalizeRecipe('https://instagram.com/p/x', 'instagram', scraped,{
      ...baseParsed,
      suggestedCategory: 'invalid' as ParsedRecipe['suggestedCategory'],
    });
    expect(recipe.category).toBe('meals');
  });

  it('sanitises negative/NaN macros to 0 and rounds', () => {
    const recipe = normalizeRecipe('https://instagram.com/p/x', 'instagram', scraped,{
      ...baseParsed,
      macros: { calories: -5, carbs: Number.NaN, protein: 20.6, fat: 9.4 },
    });
    expect(recipe.macros).toEqual({ calories: 0, carbs: 0, protein: 21, fat: 9 });
  });

  it('throws 422 when there is no recipe content', () => {
    expect(() =>
      normalizeRecipe('https://instagram.com/p/x', 'instagram', scraped,{
        ...baseParsed,
        ingredients: [],
        steps: [],
      }),
    ).toThrow(HttpError);
  });
});
