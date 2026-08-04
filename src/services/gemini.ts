import type { Config } from '../config.js';
import { unprocessable, upstreamError } from '../lib/errors.js';
import { CATEGORIES, type ParsedRecipe } from '../lib/types.js';

export interface RecipeParser {
  parse(caption: string): Promise<ParsedRecipe>;
}

/** Gemini structured-output schema describing the ParsedRecipe shape. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    isRecipe: { type: 'boolean' },
    title: { type: 'string' },
    servings: { type: 'integer' },
    ingredients: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'string' } },
    macros: {
      type: 'object',
      properties: {
        calories: { type: 'number' },
        carbs: { type: 'number' },
        protein: { type: 'number' },
        fat: { type: 'number' },
      },
      required: ['calories', 'carbs', 'protein', 'fat'],
    },
    macrosStatedInCaption: { type: 'boolean' },
    suggestedCategory: { type: 'string', enum: [...CATEGORIES] },
  },
  required: [
    'isRecipe',
    'title',
    'ingredients',
    'steps',
    'macros',
    'macrosStatedInCaption',
    'suggestedCategory',
  ],
} as const;

const SYSTEM_PROMPT = `You extract a single cooking recipe from the provided text, which may be a social media caption or the contents of a recipe web page.

Return JSON only, matching the provided schema.

Rules:
- isRecipe: true only when the text actually contains a recipe - ingredients, steps, or both - written out.
  - If it does not, set isRecipe=false and leave title empty and ingredients/steps as empty arrays.
  - NEVER invent a recipe. Do not infer ingredients or steps from a hashtag, a handle, a dish name, or a title alone. A caption like "the best #paneerbuttermasala 😍 recipe below 👇" is NOT a recipe: it names a dish but writes none of it down.
- title: a short, human-friendly recipe name.
- ingredients: one item per array entry, including quantity when stated.
  - One entry per ingredient the source lists. Do not merge several ingredients onto one line, and do not split one across lines.
- steps: ordered preparation steps, one per array entry.
- servings: integer number of servings the macros refer to. If unknown, assume 1.
- macros: per-serving calories (kcal), carbs (g), protein (g), fat (g).
  - If the caption explicitly states nutrition/macros, use those values and set macrosStatedInCaption=true.
  - Otherwise estimate them from the ingredients and servings, and set macrosStatedInCaption=false.
- suggestedCategory: one of meals, drinks, snacks, desserts — pick the best fit.

Language and wording - preserve the source, do not normalize it:
- Write title, ingredients and steps in the SAME language as the source text. Never translate.
- Name each ingredient exactly as the source names it. "haldi" stays "haldi", "atta" stays "atta", "besan" stays "besan" - never substitute a Western equivalent like "turmeric" or "whole wheat flour".
- Keep quantities and units exactly as written, including local measures (katori, tola, mutthi, inch) and non-numeric amounts ("to taste", "as required", "a pinch").`;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

/**
 * Creates a recipe parser backed by the Gemini generateContent REST API,
 * using structured output so the response is reliable JSON.
 * `fetchImpl` is injectable for unit testing.
 */
export function createGeminiRecipeParser(
  config: Pick<Config, 'geminiApiKey' | 'geminiModel'>,
  fetchImpl: typeof fetch = fetch,
): RecipeParser {
  return {
    async parse(caption: string): Promise<ParsedRecipe> {
      const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${config.geminiModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: caption }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              responseSchema: RESPONSE_SCHEMA,
              temperature: 0.2,
            },
          }),
        });
      } catch (err) {
        throw upstreamError(`Could not reach Gemini: ${(err as Error).message}`);
      }

      if (!response.ok) {
        throw upstreamError(`Gemini returned HTTP ${response.status}.`);
      }

      const data = (await response.json()) as GeminiResponse;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw unprocessable('Gemini returned no recipe content.');
      }

      try {
        return JSON.parse(text) as ParsedRecipe;
      } catch {
        throw unprocessable('Gemini returned malformed recipe JSON.');
      }
    },
  };
}
