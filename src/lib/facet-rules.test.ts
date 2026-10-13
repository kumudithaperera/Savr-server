import { describe, expect, it } from 'vitest';

import { recipeBodyHash } from './ai-cache.js';
import { deriveFacets, facetsFromParsed, ingredientTags, macroTags, parseIsoDuration } from './facet-rules.js';
import type { DietTag } from './recipe-facets.js';
import { thinkingOff } from './geminiFetch.js';

const NO_MACROS = { calories: 0, protein: 0, carbs: 0, fat: 0 };

describe('macro tags', () => {
  it('computes high_protein and low_carb from per-serving macros', () => {
    expect(macroTags({ calories: 520, protein: 38, carbs: 12, fat: 30 })).toEqual(['high_protein', 'low_carb']);
    // 30% of calories from protein counts even under 25 g.
    expect(macroTags({ calories: 200, protein: 16, carbs: 25, fat: 5 })).toEqual(['high_protein']);
    expect(macroTags({ calories: 400, protein: 8, carbs: 60, fat: 12 })).toEqual([]);
  });

  it('treats all-zero macros as unknown, not as low everything', () => {
    expect(macroTags(NO_MACROS)).toEqual([]);
  });
});

describe('ingredient tags', () => {
  it('tags plant-only lists vegan and vegetarian', () => {
    expect(ingredientTags(['200 g chickpeas', '1 onion', '2 tbsp olive oil'])).toEqual(['vegetarian', 'vegan']);
  });

  it('keeps eggs and dairy vegetarian, not vegan', () => {
    expect(ingredientTags(['3 eggs', '50 g butter', 'salt'])).toEqual(['vegetarian']);
    expect(ingredientTags(['2 huevos', '100 ml leche'])).toEqual(['vegetarian']);
  });

  it('finds meat and fish in English, Spanish and others', () => {
    expect(ingredientTags(['500 g chicken thighs', 'rice'])).toEqual([]);
    expect(ingredientTags(['200 g de jamón', 'pan'])).toEqual([]);
    expect(ingredientTags(['2 anchovies', 'pasta'])).toEqual([]);
    expect(ingredientTags(['300 g Hähnchen', 'Reis'])).toEqual([]);
  });

  it('reads plant versions of animal words as plants', () => {
    expect(ingredientTags(['400 ml coconut milk', '1 eggplant', '2 tbsp peanut butter'])).toEqual(['vegetarian', 'vegan']);
    expect(ingredientTags(['1 butternut squash', 'vegan cheese'])).toEqual(['vegetarian', 'vegan']);
  });

  it('matches whole words only', () => {
    // "graham" is not ham, "codlins" is not cod.
    expect(ingredientTags(['6 graham crackers', 'codlins'])).toEqual(['vegetarian', 'vegan']);
  });

  it('claims nothing for a script the word lists cannot read, or a one-line list', () => {
    expect(ingredientTags(['鶏肉 200g', '醤油 大さじ2'])).toEqual([]);
    expect(ingredientTags(['lettuce'])).toEqual([]);
  });
});

describe('derived facets', () => {
  it('keeps the model\'s diet tags and recomputes the macro ones', () => {
    const model = { dietTags: ['vegan', 'low_carb'] as DietTag[], totalMinutes: 30 };
    expect(deriveFacets({ ingredients: ['tofu', 'rice'], macros: { calories: 400, protein: 8, carbs: 60, fat: 12 } }, model)).toEqual({
      dietTags: ['vegetarian', 'vegan'],
      totalMinutes: 30,
    });
  });

  it('vetoes a model claim the ingredients contradict', () => {
    const model = { dietTags: ['vegetarian', 'vegan'] as DietTag[], totalMinutes: null };
    expect(deriveFacets({ ingredients: ['bacon', 'beans'], macros: NO_MACROS }, model).dietTags).toEqual([]);
    expect(deriveFacets({ ingredients: ['honey', 'oats'], macros: NO_MACROS }, model).dietTags).toEqual(['vegetarian']);
  });

  it('trusts the model when it says neither, even for a plant-looking list', () => {
    const model = { dietTags: [] as DietTag[], totalMinutes: null };
    expect(deriveFacets({ ingredients: ['dashi', 'miso'], macros: NO_MACROS }, model).dietTags).toEqual([]);
  });

  it('falls back to the word lists with no model answer', () => {
    expect(deriveFacets({ ingredients: ['lentils', 'carrot'], macros: NO_MACROS }, null)).toEqual({
      dietTags: ['vegetarian', 'vegan'],
      totalMinutes: null,
    });
  });

  it('prefers the stated time over the estimate', () => {
    const model = { dietTags: [] as DietTag[], totalMinutes: 30 };
    expect(deriveFacets({ ingredients: [], macros: NO_MACROS }, model, 75).totalMinutes).toBe(75);
  });
});

describe('parsed facets', () => {
  it('keeps only valid values and needs a dietTags answer', () => {
    expect(facetsFromParsed({ dietTags: ['vegan', 'bogus'], totalMinutes: 20.4, difficulty: 'easy' })).toEqual({
      dietTags: ['vegan'],
      totalMinutes: 20,
    });
    expect(facetsFromParsed({ dietTags: [], totalMinutes: 20 })).toEqual({ dietTags: [], totalMinutes: 20 });
    expect(facetsFromParsed({ totalMinutes: 20 })).toBeNull();
    expect(facetsFromParsed(undefined)).toBeNull();
  });
});

describe('ISO 8601 durations', () => {
  it('reads schema.org durations', () => {
    expect(parseIsoDuration('PT1H30M')).toBe(90);
    expect(parseIsoDuration('PT90M')).toBe(90);
    expect(parseIsoDuration('P0DT45M')).toBe(45);
    expect(parseIsoDuration('PT30S')).toBe(1);
    expect(parseIsoDuration('P2D')).toBe(1440);
  });

  it('rejects anything else', () => {
    expect(parseIsoDuration('45 minutes')).toBeNull();
    expect(parseIsoDuration('PT0M')).toBeNull();
    expect(parseIsoDuration(45)).toBeNull();
  });
});

describe('recipe body hash', () => {
  it('ignores case and whitespace, not content', () => {
    const a = recipeBodyHash({ ingredients: ['2 Eggs', ' 1 cup  flour'], steps: ['Mix.'] });
    expect(recipeBodyHash({ ingredients: ['2 eggs', '1 cup flour'], steps: ['mix.'] })).toBe(a);
    expect(recipeBodyHash({ ingredients: ['3 eggs', '1 cup flour'], steps: ['mix.'] })).not.toBe(a);
  });
});

describe('thinking budget', () => {
  it('switches thinking off only where a zero budget is accepted', () => {
    expect(thinkingOff('gemini-2.5-flash')).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
    expect(thinkingOff('gemini-2.5-flash-lite')).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
    expect(thinkingOff('gemini-2.5-pro')).toEqual({});
  });
});
