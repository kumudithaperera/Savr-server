import { describe, expect, it } from 'vitest';

import {
  validateExtractedRecipe,
  validateMacros,
  validateParsedRecipe,
} from './validate.js';
import type { ExtractedRecipe, ParsedRecipe } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validParsed: ParsedRecipe = {
  isRecipe: true,
  title: 'Protein Pancakes',
  servings: 2,
  ingredients: ['1 banana', '2 eggs', '1 scoop protein powder'],
  steps: ['Blend all ingredients', 'Cook on a hot griddle'],
  macros: { calories: 300, carbs: 30, protein: 20, fat: 10 },
  macrosStatedInCaption: false,
  suggestedCategory: 'meals',
};

const validExtracted: ExtractedRecipe = {
  sourceUrl: 'https://instagram.com/p/abc123',
  sourcePlatform: 'instagram',
  title: 'Protein Pancakes',
  imageRemoteUrl: 'https://example.com/img.jpg',
  category: 'meals',
  servings: 2,
  ingredients: ['1 banana', '2 eggs', '1 scoop protein powder'],
  steps: ['Blend all ingredients', 'Cook on a hot griddle'],
  macros: { calories: 300, carbs: 30, protein: 20, fat: 10 },
  macrosSource: 'estimated',
};

// ---------------------------------------------------------------------------
// validateMacros
// ---------------------------------------------------------------------------

describe('validateMacros', () => {
  it('accepts valid macros', () => {
    expect(validateMacros({ calories: 100, carbs: 10, protein: 5, fat: 3 }, 'macros')).toEqual([]);
  });

  it('rejects macros that is not an object', () => {
    const errs = validateMacros(null, 'macros');
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('macros');
  });

  it('rejects non-finite macro values', () => {
    const errs = validateMacros({ calories: NaN, carbs: Infinity, protein: -1, fat: 3 }, 'macros');
    expect(errs).toHaveLength(2);
    expect(errs.map((e) => e.path).sort()).toEqual(['macros.calories', 'macros.carbs']);
  });

  it('rejects missing macro fields', () => {
    const errs = validateMacros({ calories: 100 }, 'macros');
    expect(errs).toHaveLength(3);
  });

  it('rejects non-numeric macro values', () => {
    const errs = validateMacros({ calories: '100', carbs: 10, protein: 5, fat: 3 }, 'macros');
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('macros.calories');
  });
});

// ---------------------------------------------------------------------------
// validateParsedRecipe
// ---------------------------------------------------------------------------

describe('validateParsedRecipe', () => {
  it('accepts a valid ParsedRecipe', () => {
    const result = validateParsedRecipe(validParsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('Protein Pancakes');
    }
  });

  it('rejects non-object input', () => {
    const result = validateParsedRecipe('not an object');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors[0].message).toContain('object');
    }
  });

  it('rejects null input', () => {
    const result = validateParsedRecipe(null);
    expect(result.success).toBe(false);
  });

  it('rejects missing title', () => {
    const result = validateParsedRecipe({ ...validParsed, title: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.find((e) => e.path === 'title')).toBeTruthy();
    }
  });

  it('accepts an empty title when isRecipe is false', () => {
    const result = validateParsedRecipe({
      ...validParsed,
      isRecipe: false,
      title: '',
      ingredients: [],
      steps: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts ParsedRecipe without isRecipe (optional)', () => {
    const { isRecipe: _, ...without } = validParsed;
    const result = validateParsedRecipe(without);
    expect(result.success).toBe(true);
  });

  it('rejects non-boolean isRecipe', () => {
    const result = validateParsedRecipe({ ...validParsed, isRecipe: 'yes' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.find((e) => e.path === 'isRecipe')).toBeTruthy();
    }
  });

  it('rejects non-array ingredients', () => {
    const result = validateParsedRecipe({ ...validParsed, ingredients: 'flour' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.find((e) => e.path === 'ingredients')).toBeTruthy();
    }
  });

  it('rejects non-string ingredient items', () => {
    const result = validateParsedRecipe({ ...validParsed, ingredients: ['flour', 42] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.find((e) => e.path === 'ingredients')).toBeTruthy();
    }
  });

  it('rejects non-array steps', () => {
    const result = validateParsedRecipe({ ...validParsed, steps: 'mix' });
    expect(result.success).toBe(false);
  });

  it('accepts missing servings (undefined treated as missing)', () => {
    const { servings: _, ...without } = validParsed;
    const result = validateParsedRecipe(without);
    expect(result.success).toBe(true);
  });

  it('rejects negative servings', () => {
    const result = validateParsedRecipe({ ...validParsed, servings: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects float servings', () => {
    const result = validateParsedRecipe({ ...validParsed, servings: 2.5 });
    expect(result.success).toBe(false);
  });

  it('rejects missing macros', () => {
    const { macros: _, ...without } = validParsed;
    const result = validateParsedRecipe(without);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.find((e) => e.path === 'macros')).toBeTruthy();
    }
  });

  it('rejects non-boolean macrosStatedInCaption', () => {
    const result = validateParsedRecipe({ ...validParsed, macrosStatedInCaption: 'true' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid suggestedCategory', () => {
    const result = validateParsedRecipe({ ...validParsed, suggestedCategory: 'breakfast' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.find((e) => e.path === 'suggestedCategory')).toBeTruthy();
    }
  });

  it('accumulates multiple errors', () => {
    const result = validateParsedRecipe({
      title: '',
      ingredients: null,
      steps: null,
      macros: null,
      macrosStatedInCaption: 123,
      suggestedCategory: 'breakfast',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    }
  });
});

// ---------------------------------------------------------------------------
// validateExtractedRecipe
// ---------------------------------------------------------------------------

describe('validateExtractedRecipe', () => {
  it('accepts a valid ExtractedRecipe', () => {
    const result = validateExtractedRecipe(validExtracted);
    expect(result.success).toBe(true);
  });

  it('rejects non-object input', () => {
    const result = validateExtractedRecipe('bad');
    expect(result.success).toBe(false);
  });

  it('rejects empty sourceUrl', () => {
    const result = validateExtractedRecipe({ ...validExtracted, sourceUrl: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid sourcePlatform', () => {
    const result = validateExtractedRecipe({ ...validExtracted, sourcePlatform: 'facebook' });
    expect(result.success).toBe(false);
  });

  it('rejects empty title', () => {
    const result = validateExtractedRecipe({ ...validExtracted, title: '' });
    expect(result.success).toBe(false);
  });

  it('accepts missing imageRemoteUrl (optional)', () => {
    const { imageRemoteUrl: _, ...without } = validExtracted;
    const result = validateExtractedRecipe(without);
    expect(result.success).toBe(true);
  });

  it('rejects non-string imageRemoteUrl', () => {
    const result = validateExtractedRecipe({ ...validExtracted, imageRemoteUrl: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects invalid category', () => {
    const result = validateExtractedRecipe({ ...validExtracted, category: 'sides' });
    expect(result.success).toBe(false);
  });

  it('accepts an empty ingredients array (normalization can produce it)', () => {
    const result = validateExtractedRecipe({ ...validExtracted, ingredients: [] });
    expect(result.success).toBe(true);
  });

  it('accepts an empty steps array (normalization can produce it)', () => {
    const result = validateExtractedRecipe({ ...validExtracted, steps: [] });
    expect(result.success).toBe(true);
  });

  it('rejects non-string ingredients element', () => {
    const result = validateExtractedRecipe({ ...validExtracted, ingredients: ['flour', 42] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.find((e) => e.path === 'ingredients[1]')).toBeTruthy();
    }
  });

  it('rejects invalid macrosSource', () => {
    const result = validateExtractedRecipe({ ...validExtracted, macrosSource: 'inferred' });
    expect(result.success).toBe(false);
  });

  it('accepts missing servings (optional)', () => {
    const { servings: _, ...without } = validExtracted;
    const result = validateExtractedRecipe(without);
    expect(result.success).toBe(true);
  });

  it('accepts null servings (explicit optional)', () => {
    const result = validateExtractedRecipe({ ...validExtracted, servings: null });
    expect(result.success).toBe(true);
  });

  it('rejects negative servings', () => {
    const result = validateExtractedRecipe({ ...validExtracted, servings: -1 });
    expect(result.success).toBe(false);
  });

  it('accumulates multiple errors across fields', () => {
    const result = validateExtractedRecipe({
      sourceUrl: '',
      sourcePlatform: 'unknown',
      title: '',
      category: 'sides',
      ingredients: 'flour',
      steps: 42,
      macros: null,
      macrosSource: 'inferred',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThanOrEqual(8);
    }
  });
});