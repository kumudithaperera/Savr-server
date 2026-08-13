import { describe, expect, it, vi } from 'vitest';

import { createGeminiVideoParser } from './gemini-video.js';
import type { ParsedRecipe } from '../lib/types.js';

const CONFIG = { geminiApiKey: 'test-key', geminiVideoModel: 'gemini-2.5-flash' };
const VIDEO_URL = 'https://cdn.example/video.mp4';

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

function videoDownloadResponse(): Response {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'video/mp4' }),
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as Response;
}

function geminiResponse(status: number, recipe: ParsedRecipe = RECIPE): Response {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    text: async () => (ok ? '' : 'high demand'),
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(recipe) }] } }],
    }),
  } as unknown as Response;
}

/** Routes the video-download GET separately from Gemini's generateContent POST. */
function makeFetch(generateContentResponses: Response[]): typeof fetch {
  const queue = [...generateContentResponses];
  return vi.fn(async (input: string | URL | Request) => {
    if (input === VIDEO_URL) return videoDownloadResponse();
    const next = queue.shift();
    if (!next) throw new Error('no more mocked Gemini responses');
    return next;
  }) as unknown as typeof fetch;
}

describe('createGeminiVideoParser', () => {
  it('succeeds on the first attempt without retrying', async () => {
    const fetchImpl = makeFetch([geminiResponse(200)]);
    const parser = createGeminiVideoParser(CONFIG, fetchImpl);

    const result = await parser.parseVideo(VIDEO_URL);

    expect(result.title).toBe('Pancakes');
    // 1 call for the video download + 1 for generateContent.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries once after a 503 and succeeds', async () => {
    const fetchImpl = makeFetch([geminiResponse(503), geminiResponse(200)]);
    const parser = createGeminiVideoParser(CONFIG, fetchImpl);

    const result = await parser.parseVideo(VIDEO_URL);

    expect(result.title).toBe('Pancakes');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  }, 10000);

  it('gives up after a second 503 rather than retrying indefinitely', async () => {
    const fetchImpl = makeFetch([geminiResponse(503), geminiResponse(503)]);
    const parser = createGeminiVideoParser(CONFIG, fetchImpl);

    await expect(parser.parseVideo(VIDEO_URL)).rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  }, 10000);

  it('does not retry a non-503 error', async () => {
    const fetchImpl = makeFetch([geminiResponse(500)]);
    const parser = createGeminiVideoParser(CONFIG, fetchImpl);

    await expect(parser.parseVideo(VIDEO_URL)).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
