import { describe, expect, it } from 'vitest';

import { mergeRecipes } from './merge.js';
import type { ParsedRecipe } from './types.js';

const primaryRecipe: ParsedRecipe = {
  isRecipe: true,
  title: 'Chicken Pasta',
  servings: 4,
  ingredients: ['chicken', 'pasta', 'garlic'],
  steps: ['Cook pasta', 'Cook chicken'],
  macros: { calories: 400, carbs: 50, protein: 30, fat: 10 },
  macrosStatedInCaption: false,
  suggestedCategory: 'meals',
};

const videoRecipe: ParsedRecipe = {
  isRecipe: true,
  title: 'Creamy Chicken Pasta',
  servings: 4,
  ingredients: [
    '500g chicken breast',
    '400g pasta',
    '3 cloves garlic',
    '200ml cream',
  ],
  steps: [
    'Boil pasta for 10 minutes',
    'Slice chicken and cook for 8 minutes',
    'Add cream and simmer for 5 minutes',
    'Combine and serve',
  ],
  macros: { calories: 550, carbs: 60, protein: 35, fat: 18 },
  macrosStatedInCaption: false,
  suggestedCategory: 'meals',
};

describe('mergeRecipes', () => {
  it('uses video recipe when primary is null', () => {
    const result = mergeRecipes(null, videoRecipe);
    expect(result.title).toBe('Creamy Chicken Pasta');
    expect(result.ingredients).toEqual(videoRecipe.ingredients);
    expect(result.videoContributions).toContain('title');
    expect(result.videoContributions).toContain('ingredients');
  });

  it('uses video recipe when primary says not a recipe', () => {
    const notRecipe = { ...primaryRecipe, isRecipe: false as const };
    const result = mergeRecipes(notRecipe, videoRecipe);
    expect(result.title).toBe('Creamy Chicken Pasta');
    expect(result.isRecipe).toBe(true);
  });

  it('uses primary when video says not a recipe', () => {
    const notRecipe = { ...videoRecipe, isRecipe: false as const };
    const result = mergeRecipes(primaryRecipe, notRecipe);
    expect(result.title).toBe('Chicken Pasta');
    expect(result.videoContributions).toHaveLength(0);
  });

  it('prefers ingredients with quantities', () => {
    const result = mergeRecipes(primaryRecipe, videoRecipe);
    // Video has quantities, primary does not
    expect(result.ingredients).toContain('500g chicken breast');
    expect(result.ingredients).not.toContain('chicken');
  });

  it('combines unique ingredients from both sources', () => {
    const result = mergeRecipes(primaryRecipe, videoRecipe);
    // Video adds cream which primary does not have
    expect(result.ingredients.some((i) => i.includes('cream'))).toBe(true);
  });

  it('prefers steps with more detail', () => {
    const result = mergeRecipes(primaryRecipe, videoRecipe);
    // Video has more detailed steps
    expect(result.steps.length).toBe(videoRecipe.steps.length);
    expect(result.steps[0]).toContain('10 minutes');
  });

  it('prefers caption-stated macros', () => {
    const primaryWithMacros = {
      ...primaryRecipe,
      macros: { calories: 380, carbs: 45, protein: 28, fat: 12 },
      macrosStatedInCaption: true,
    };
    const result = mergeRecipes(primaryWithMacros, videoRecipe);
    expect(result.macros.calories).toBe(380);
    expect(result.macrosStatedInCaption).toBe(true);
  });

  it('averages macros when both are caption-stated', () => {
    const primaryWithMacros = {
      ...primaryRecipe,
      macrosStatedInCaption: true,
    };
    const videoWithMacros = {
      ...videoRecipe,
      macrosStatedInCaption: true,
    };
    const result = mergeRecipes(primaryWithMacros, videoWithMacros);
    // Average of 400 and 550
    expect(result.macros.calories).toBe(475);
    expect(result.macrosStatedInCaption).toBe(true);
  });

  it('tracks video contributions', () => {
    const result = mergeRecipes(primaryRecipe, videoRecipe);
    expect(result.videoContributions).toContain('ingredients');
    expect(result.videoContributions).toContain('steps');
  });

  it('calculates merged confidence', () => {
    const result = mergeRecipes(primaryRecipe, videoRecipe);
    expect(result.mergedConfidence).toBeGreaterThan(0);
    expect(result.mergedConfidence).toBeLessThanOrEqual(1);
  });

  it('preserves servings from primary if video lacks it', () => {
    const videoNoServings = { ...videoRecipe, servings: undefined };
    const result = mergeRecipes(primaryRecipe, videoNoServings);
    expect(result.servings).toBe(4);
  });

  it('uses video servings if primary lacks it', () => {
    const primaryNoServings = { ...primaryRecipe, servings: undefined };
    const result = mergeRecipes(primaryNoServings, videoRecipe);
    expect(result.servings).toBe(4);
    expect(result.videoContributions).toContain('servings');
  });
});
