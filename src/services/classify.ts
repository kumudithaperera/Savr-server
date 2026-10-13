import type { Config } from '../config.js';
import { generateContentWithRetry } from '../lib/geminiFetch.js';
import { upstreamError } from '../lib/errors.js';
import {
  DIET_TAGS,
  DIFFICULTIES,
  type DietTag,
  type Difficulty,
  type RecipeFacets,
} from '../lib/recipe-facets.js';

/**
 * Tags a recipe for the Discover / community filters: diet tags, total time
 * and difficulty. One small Gemini JSON call per recipe, made once - when a
 * recipe is first indexed or shared - and stored on the row.
 *
 * Callers treat this as best-effort: a failure leaves the facets null and the
 * recipe is still listed (it just doesn't match a diet/time/difficulty filter
 * until the sweep in `lib/discover-indexer.ts` retries it).
 */

export interface ClassifyInput {
  title: string;
  ingredients: string[];
  steps: string[];
  macros: { calories: number; protein: number; carbs: number; fat: number };
  servings?: number;
}

export interface RecipeClassifier {
  /** Throws an upstream error when the call could not be made or parsed. */
  classify(recipe: ClassifyInput): Promise<RecipeFacets>;
}

const SCHEMA = {
  type: 'object',
  properties: {
    dietTags: { type: 'array', items: { type: 'string', enum: [...DIET_TAGS] } },
    totalMinutes: { type: 'integer' },
    difficulty: { type: 'string', enum: [...DIFFICULTIES] },
  },
  required: ['dietTags', 'totalMinutes', 'difficulty'],
} as const;

const PROMPT = `You tag recipes for search filters in a recipe app. Return JSON only, matching the schema.

dietTags - include a tag only when it is clearly true for the recipe exactly as written:
- vegetarian: no meat, poultry, fish or seafood (eggs and dairy are fine)
- vegan: no animal products at all (no meat, fish, eggs, dairy, honey)
- gluten_free: no wheat, barley, rye, regular pasta, bread, flour or soy sauce unless stated gluten-free
- dairy_free: no milk, butter, cheese, cream, yogurt, ghee
- nut_free: no tree nuts or peanuts
- high_protein: at least 25 g protein per serving, or protein provides at least 30% of calories
- low_carb: at most 20 g carbs per serving
- keto: at most 10 g net carbs per serving and high in fat
When unsure, leave the tag out.

totalMinutes - realistic total time from start to plate in minutes, including marinating, resting or chilling the recipe requires. Estimate from the steps when no time is stated.

difficulty - easy (few steps, basic techniques), medium, or hard (many components, advanced technique or precise timing).

The recipe may be in any language; judge it as written and never translate.`;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

/** Keeps only valid values; the model's JSON is still untrusted input. */
export function sanitizeFacets(raw: unknown): RecipeFacets {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tags = Array.isArray(value.dietTags)
    ? value.dietTags.filter((t): t is DietTag => (DIET_TAGS as readonly string[]).includes(t as string))
    : [];
  const minutes =
    typeof value.totalMinutes === 'number' && Number.isFinite(value.totalMinutes) && value.totalMinutes > 0
      ? Math.min(Math.round(value.totalMinutes), 1440)
      : null;
  const difficulty = (DIFFICULTIES as readonly string[]).includes(value.difficulty as string)
    ? (value.difficulty as Difficulty)
    : null;
  return { dietTags: [...new Set(tags)], totalMinutes: minutes, difficulty };
}

export function createGeminiClassifier(
  config: Pick<Config, 'geminiApiKey' | 'geminiModel'>,
  fetchImpl: typeof fetch = fetch,
): RecipeClassifier {
  return {
    async classify(recipe) {
      const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${config.geminiModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

      const text = [
        `Title: ${recipe.title}`,
        recipe.servings ? `Servings: ${recipe.servings}` : '',
        `Per serving: ${recipe.macros.calories} kcal, ${recipe.macros.protein} g protein, ` +
          `${recipe.macros.carbs} g carbs, ${recipe.macros.fat} g fat`,
        'Ingredients:',
        ...recipe.ingredients.slice(0, 60).map((line) => `- ${line.slice(0, 200)}`),
        'Steps:',
        ...recipe.steps.slice(0, 40).map((line, i) => `${i + 1}. ${line.slice(0, 500)}`),
      ]
        .filter(Boolean)
        .join('\n');

      const response = await generateContentWithRetry(
        endpoint,
        JSON.stringify({
          systemInstruction: { parts: [{ text: PROMPT }] },
          // Fenced so instructions inside a scraped recipe are tagged, not obeyed.
          contents: [{ role: 'user', parts: [{ text: `Recipe:\n<<<\n${text}\n>>>` }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: SCHEMA,
            temperature: 0,
          },
        }),
        fetchImpl,
      );
      if (!response.ok) throw upstreamError(`Gemini classify responded ${response.status}`);

      const data = (await response.json()) as GeminiResponse;
      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) throw upstreamError('Gemini classify returned no candidate');
      try {
        return sanitizeFacets(JSON.parse(raw));
      } catch {
        throw upstreamError('Gemini classify returned malformed JSON');
      }
    },
  };
}
