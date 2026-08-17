import { describe, expect, it, vi } from 'vitest';

import { createGeminiRecipeParser } from './gemini.js';
import { GEMINI_RETRY_DELAY_MS } from '../lib/geminiFetch.js';
import type { ParsedRecipe } from '../lib/types.js';

const CONFIG = { geminiApiKey: 'test-key', geminiModel: 'gemini-2.5-flash' };
const CAPTION = '1 cup flour\n2 eggs\nMix and cook.';

const RECIPE: ParsedRecipe = {
  isRecipe: true,
  title: 'Pancakes',
  servings: 2,
  ingredients: ['2 cups flour', '2 eggs'],
  steps: ['Mix', 'Cook'],
  macros: { calories: 300, carbs: 40, protein: 10, fat: 8 },
  macrosStatedInCaption: false,
  suggestedCategory: 'meals',
};

const RECIPE_BODY = {
  candidates: [{ content: { parts: [{ text: JSON.stringify(RECIPE) }] } }],
};

function geminiResponse(status: number, body: unknown = RECIPE_BODY): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    text: async () => (ok ? '' : 'high demand'),
    json: async () => body,
  } as unknown as Response;
}

/** Returns the next mocked generateContent response per call. */
function makeFetch(responses: Response[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('no more mocked Gemini responses');
    return next;
  }) as unknown as typeof fetch;
}

describe('createGeminiRecipeParser', () => {
  it('succeeds on the first attempt without retrying', async () => {
    const fetchImpl = makeFetch([geminiResponse(200)]);
    const parser = createGeminiRecipeParser(CONFIG, fetchImpl);

    const result = await parser.parse(CAPTION);

    expect(result.title).toBe('Pancakes');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries once after a 503 and succeeds', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = makeFetch([geminiResponse(503), geminiResponse(200)]);
      const parser = createGeminiRecipeParser(CONFIG, fetchImpl);

      const resultPromise = parser.parse(CAPTION);
      await vi.advanceTimersByTimeAsync(GEMINI_RETRY_DELAY_MS);

      const result = await resultPromise;
      expect(result.title).toBe('Pancakes');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after a second 503 rather than retrying indefinitely', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = makeFetch([geminiResponse(503), geminiResponse(503)]);
      const parser = createGeminiRecipeParser(CONFIG, fetchImpl);

      const resultPromise = parser.parse(CAPTION);
      const rejection = expect(resultPromise).rejects.toMatchObject({
        statusCode: 502,
        code: 'upstream_error',
        message: expect.stringContaining('503'),
      });
      await vi.advanceTimersByTimeAsync(GEMINI_RETRY_DELAY_MS);
      await rejection;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a non-503 error', async () => {
    const fetchImpl = makeFetch([geminiResponse(500)]);
    const parser = createGeminiRecipeParser(CONFIG, fetchImpl);

    await expect(parser.parse(CAPTION)).rejects.toMatchObject({
      statusCode: 502,
      code: 'upstream_error',
      message: expect.stringContaining('500'),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty Gemini result as unprocessable', async () => {
    const fetchImpl = makeFetch([geminiResponse(200, { candidates: [] })]);
    const parser = createGeminiRecipeParser(CONFIG, fetchImpl);

    await expect(parser.parse(CAPTION)).rejects.toMatchObject({
      statusCode: 422,
      code: 'parse_failed',
      message: 'Gemini returned no recipe content.',
    });
  });

  it('rejects malformed Gemini JSON as unprocessable', async () => {
    const fetchImpl = makeFetch([
      geminiResponse(200, { candidates: [{ content: { parts: [{ text: 'not json' }] } }] }),
    ]);
    const parser = createGeminiRecipeParser(CONFIG, fetchImpl);

    await expect(parser.parse(CAPTION)).rejects.toMatchObject({
      statusCode: 422,
      code: 'parse_failed',
      message: 'Gemini returned malformed recipe JSON.',
    });
  });

  it('rejects Gemini output that is valid JSON but the wrong shape, before normalization', async () => {
    const fetchImpl = makeFetch([
      geminiResponse(200, {
        candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 42 }) }] } }],
      }),
    ]);
    const parser = createGeminiRecipeParser(CONFIG, fetchImpl);

    await expect(parser.parse(CAPTION)).rejects.toMatchObject({
      statusCode: 422,
      code: 'parse_failed',
      message: 'Gemini returned a malformed recipe response.',
    });
  });

  it('accepts a non-recipe verdict with an empty title', async () => {
    const fetchImpl = makeFetch([
      geminiResponse(200, {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                isRecipe: false,
                title: '',
                servings: 1,
                ingredients: [],
                steps: [],
                macros: { calories: 0, carbs: 0, protein: 0, fat: 0 },
                macrosStatedInCaption: false,
                suggestedCategory: 'meals',
              }),
            }],
          },
        }],
      }),
    ]);
    const parser = createGeminiRecipeParser(CONFIG, fetchImpl);

    const result = await parser.parse(CAPTION);
    expect(result.isRecipe).toBe(false);
    expect(result.title).toBe('');
  });
});
