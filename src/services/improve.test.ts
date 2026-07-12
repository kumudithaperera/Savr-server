import { describe, expect, it } from 'vitest';

import { createGeminiRecipeImprover } from './improve.js';
import { HttpError } from '../lib/errors.js';
import type { RecipeInput } from '../lib/types.js';

const config = { geminiApiKey: 'test-key', geminiModel: 'gemini-test' };

const recipe: RecipeInput = {
  title: 'Garlic Butter Pasta',
  servings: 2,
  ingredients: ['2 tbsp butter', '200g spaghetti'],
  steps: ['Boil pasta', 'Toss in butter'],
  macros: { calories: 500, carbs: 60, protein: 12, fat: 20 },
};

/** Builds a fake fetch returning the given model JSON inside a Gemini envelope. */
function fakeFetch(modelJson: unknown): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(modelJson) }] } }],
      }),
    }) as unknown as Response) as typeof fetch;
}

describe('createGeminiRecipeImprover.suggestSubstitutes', () => {
  it('returns cleaned substitutions echoing the ingredient lines', async () => {
    const improver = createGeminiRecipeImprover(
      config,
      fakeFetch({
        substitutions: [
          {
            ingredient: '2 tbsp butter',
            options: [
              { replacement: '2 tbsp olive oil', reason: 'dairy-free' },
              { replacement: '', reason: 'dropped — empty' },
            ],
          },
          { ingredient: '', options: [{ replacement: 'x', reason: 'y' }] },
        ],
      }),
    );

    const result = await improver.suggestSubstitutes(recipe);
    expect(result.substitutions).toHaveLength(1);
    expect(result.substitutions[0].ingredient).toBe('2 tbsp butter');
    expect(result.substitutions[0].options).toEqual([
      { replacement: '2 tbsp olive oil', reason: 'dairy-free' },
    ]);
  });

  it('throws 422 when the model returns no usable substitutions', async () => {
    const improver = createGeminiRecipeImprover(config, fakeFetch({ substitutions: [] }));
    await expect(improver.suggestSubstitutes(recipe)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('createGeminiRecipeImprover.makeHealthier', () => {
  it('returns a normalized improved recipe with cleaned macros', async () => {
    const improver = createGeminiRecipeImprover(
      config,
      fakeFetch({
        title: 'Lighter Garlic Pasta',
        servings: 2,
        ingredients: ['1 tbsp olive oil', '200g whole-wheat spaghetti'],
        steps: ['Boil pasta', 'Toss in oil'],
        macros: { calories: 380.6, carbs: 58, protein: -3, fat: 9.2 },
        summary: 'Swapped butter for olive oil to cut calories.',
      }),
    );

    const result = await improver.makeHealthier(recipe, 'lower calorie');
    expect(result.title).toBe('Lighter Garlic Pasta');
    expect(result.macros).toEqual({ calories: 381, carbs: 58, protein: 0, fat: 9 });
    expect(result.summary).toContain('olive oil');
  });

  it('throws 422 when the model returns an empty recipe', async () => {
    const improver = createGeminiRecipeImprover(
      config,
      fakeFetch({ title: '', ingredients: [], steps: [], macros: {}, summary: '' }),
    );
    await expect(improver.makeHealthier(recipe, 'vegan')).rejects.toBeInstanceOf(HttpError);
  });

  it('maps upstream HTTP failures to a 502', async () => {
    const improver = createGeminiRecipeImprover(
      config,
      (async () => ({ ok: false, status: 500 }) as unknown as Response) as typeof fetch,
    );
    await expect(improver.suggestSubstitutes(recipe)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('createGeminiRecipeImprover.reconcileSteps', () => {
  it('returns the rewritten steps for a substitution', async () => {
    const improver = createGeminiRecipeImprover(
      config,
      fakeFetch({ steps: ['Boil pasta', 'Heat the olive oil'] }),
    );
    const result = await improver.reconcileSteps(recipe, '2 tbsp butter', '2 tbsp olive oil');
    expect(result.steps).toEqual(['Boil pasta', 'Heat the olive oil']);
  });

  it('falls back to the original steps when the model returns none', async () => {
    const improver = createGeminiRecipeImprover(config, fakeFetch({ steps: [] }));
    const result = await improver.reconcileSteps(recipe, '2 tbsp butter', '2 tbsp olive oil');
    expect(result.steps).toEqual(recipe.steps);
  });

  it('skips the request entirely when there are no steps', async () => {
    let called = false;
    const improver = createGeminiRecipeImprover(config, (async () => {
      called = true;
      return {} as unknown as Response;
    }) as typeof fetch);
    const result = await improver.reconcileSteps({ ...recipe, steps: [] }, 'a', 'b');
    expect(result.steps).toEqual([]);
    expect(called).toBe(false);
  });
});
