import { describe, expect, it } from 'vitest';

import {
  assessCompleteness,
  hasQuantity,
  DEFAULT_THRESHOLDS,
} from './completeness.js';
import type { ParsedRecipe, ScrapedPost } from './types.js';

const baseRecipe: ParsedRecipe = {
  isRecipe: true,
  title: 'Chicken Curry',
  servings: 4,
  ingredients: [
    '500g chicken',
    '2 tbsp oil',
    '1 onion',
    '3 cloves garlic',
    '1 tsp turmeric',
  ],
  steps: [
    'Heat oil in pan',
    'Add onion and garlic, saute 5 minutes',
    'Add chicken and spices, cook 15 minutes',
  ],
  macros: { calories: 350, carbs: 10, protein: 40, fat: 15 },
  macrosStatedInCaption: false,
  suggestedCategory: 'meals',
};

const baseScraped: ScrapedPost = {
  caption: 'Full recipe for chicken curry with all ingredients and steps.',
  imageUrl: 'https://example.com/image.jpg',
};

describe('hasQuantity', () => {
  it('detects numeric quantities at start', () => {
    expect(hasQuantity('500g chicken')).toBe(true);
    expect(hasQuantity('2 cups flour')).toBe(true);
    expect(hasQuantity('1/2 tsp salt')).toBe(true);
  });

  it('detects fraction symbols', () => {
    expect(hasQuantity('½ cup sugar')).toBe(true);
    expect(hasQuantity('¼ tsp vanilla')).toBe(true);
  });

  it('detects unit-based quantities', () => {
    expect(hasQuantity('chicken 500g')).toBe(true);
    expect(hasQuantity('add 2 tablespoons butter')).toBe(true);
  });

  it('detects word-based quantities', () => {
    expect(hasQuantity('one large onion')).toBe(true);
    expect(hasQuantity('two cups flour')).toBe(true);
  });

  it('returns false for ingredients without quantities', () => {
    expect(hasQuantity('chicken')).toBe(false);
    expect(hasQuantity('salt to taste')).toBe(false);
    expect(hasQuantity('oil as needed')).toBe(false);
  });
});

describe('assessCompleteness', () => {
  it('marks a complete recipe as complete', () => {
    const result = assessCompleteness(baseScraped, baseRecipe);
    expect(result.isComplete).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.reason).toBeUndefined();
  });

  it('marks a recipe without ingredients as incomplete', () => {
    const recipe = { ...baseRecipe, ingredients: [] };
    const result = assessCompleteness(baseScraped, recipe);
    expect(result.isComplete).toBe(false);
    expect(result.reason).toBe('no_ingredients');
  });

  it('marks a recipe with too few ingredients as incomplete', () => {
    const recipe = { ...baseRecipe, ingredients: ['chicken'] };
    const result = assessCompleteness(baseScraped, recipe);
    expect(result.isComplete).toBe(false);
    expect(result.reason).toBe('few_ingredients');
  });

  it('marks a recipe without steps as incomplete', () => {
    const recipe = { ...baseRecipe, steps: [] };
    const result = assessCompleteness(baseScraped, recipe);
    expect(result.isComplete).toBe(false);
    expect(result.reason).toBe('no_steps');
  });

  it('marks a recipe with missing quantities as incomplete', () => {
    const recipe = {
      ...baseRecipe,
      ingredients: ['chicken', 'oil', 'onion', 'garlic', 'turmeric'],
    };
    const result = assessCompleteness(baseScraped, recipe);
    expect(result.isComplete).toBe(false);
    expect(result.reason).toBe('missing_quantities');
  });

  it('marks non-recipe as incomplete', () => {
    const recipe = { ...baseRecipe, isRecipe: false };
    const result = assessCompleteness(baseScraped, recipe);
    expect(result.isComplete).toBe(false);
    expect(result.reason).toBe('not_a_recipe');
    expect(result.confidence).toBeLessThan(0.2);
  });

  it('uses custom thresholds', () => {
    const recipe = { ...baseRecipe, ingredients: ['500g chicken'] };
    const laxThresholds = { ...DEFAULT_THRESHOLDS, minIngredients: 1 };
    const result = assessCompleteness(baseScraped, recipe, laxThresholds);
    expect(result.isComplete).toBe(true);
  });

  it('returns detailed breakdown', () => {
    const result = assessCompleteness(baseScraped, baseRecipe);
    expect(result.details.hasTitle).toBe(true);
    expect(result.details.ingredientCount).toBe(5);
    expect(result.details.stepCount).toBe(3);
    expect(result.details.parserSaysRecipe).toBe(true);
  });
});
