import { describe, expect, it, vi } from 'vitest';

import { createDeepSeekRecipeParser } from './deepseek.js';

const CONFIG = {
  deepseekApiKey: 'test-key',
  deepseekModel: 'deepseek-chat',
  deepseekBaseUrl: 'https://api.deepseek.com',
};

const CAPTION = '1 cup flour\n2 eggs\nMix and cook.';

function deepseekResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function makeFetch(responses: Response[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('no more mocked DeepSeek responses');
    return next;
  }) as unknown as typeof fetch;
}

describe('createDeepSeekRecipeParser', () => {
  it('returns a sufficient recipe on success', async () => {
    const fetchImpl = makeFetch([
      deepseekResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              isRecipe: true,
              title: 'Pancakes',
              servings: 2,
              ingredients: ['2 cups flour', '2 eggs'],
              steps: ['Mix', 'Cook'],
              macros: { calories: 300, carbs: 40, protein: 10, fat: 8 },
              macrosStatedInCaption: false,
              suggestedCategory: 'meals',
              sufficient: true,
              confidence: 0.9,
              missing: [],
            }),
          },
        }],
      }),
    ]);
    const parser = createDeepSeekRecipeParser(CONFIG, fetchImpl);

    const result = await parser.parseText(CAPTION);
    expect(result.sufficient).toBe(true);
    expect(result.recipe.title).toBe('Pancakes');
  });

  it('rejects DeepSeek output that is valid JSON but the wrong shape', async () => {
    const fetchImpl = makeFetch([
      deepseekResponse({
        choices: [{
          message: { content: JSON.stringify({ title: 42 }) },
        }],
      }),
    ]);
    const parser = createDeepSeekRecipeParser(CONFIG, fetchImpl);

    await expect(parser.parseText(CAPTION)).rejects.toMatchObject({
      statusCode: 422,
      code: 'parse_failed',
      message: 'DeepSeek returned a malformed recipe response.',
    });
  });

  it('accepts a non-recipe verdict from DeepSeek', async () => {
    const fetchImpl = makeFetch([
      deepseekResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              isRecipe: false,
              title: '',
              servings: 1,
              ingredients: [],
              steps: [],
              macros: { calories: 0, carbs: 0, protein: 0, fat: 0 },
              macrosStatedInCaption: false,
              suggestedCategory: 'meals',
              sufficient: false,
              confidence: 0.0,
              missing: ['ingredients', 'steps'],
            }),
          },
        }],
      }),
    ]);
    const parser = createDeepSeekRecipeParser(CONFIG, fetchImpl);

    const result = await parser.parseText(CAPTION);
    expect(result.sufficient).toBe(false);
    expect(result.recipe.isRecipe).toBe(false);
    expect(result.recipe.title).toBe('');
  });
});