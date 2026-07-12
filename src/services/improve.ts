import type { Config } from '../config.js';
import { unprocessable, upstreamError } from '../lib/errors.js';
import type {
  ImprovedRecipe,
  Macros,
  RecipeInput,
  SubstitutionResult,
} from '../lib/types.js';

/** AI-backed recipe improvements: ingredient substitutes and healthier variants. */
export interface RecipeImprover {
  suggestSubstitutes(recipe: RecipeInput): Promise<SubstitutionResult>;
  makeHealthier(recipe: RecipeInput, goal: string): Promise<ImprovedRecipe>;
  /**
   * Rewrites a recipe's steps to reflect a single ingredient substitution
   * (`from` -> `to`), so the instructions stay consistent after a swap. The
   * recipe passed in should already have the new ingredient in its list.
   */
  reconcileSteps(recipe: RecipeInput, from: string, to: string): Promise<{ steps: string[] }>;
}

const MACROS_SCHEMA = {
  type: 'object',
  properties: {
    calories: { type: 'number' },
    carbs: { type: 'number' },
    protein: { type: 'number' },
    fat: { type: 'number' },
  },
  required: ['calories', 'carbs', 'protein', 'fat'],
} as const;

/** Structured-output schema for the `substitutes` mode. */
const SUBSTITUTES_SCHEMA = {
  type: 'object',
  properties: {
    substitutions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ingredient: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                replacement: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['replacement', 'reason'],
            },
          },
        },
        required: ['ingredient', 'options'],
      },
    },
  },
  required: ['substitutions'],
} as const;

/** Structured-output schema for the `healthier` mode. */
const HEALTHIER_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    servings: { type: 'integer' },
    ingredients: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'string' } },
    macros: MACROS_SCHEMA,
    summary: { type: 'string' },
  },
  required: ['title', 'ingredients', 'steps', 'macros', 'summary'],
} as const;

/** Structured-output schema for the `reconcile-steps` mode. */
const STEPS_SCHEMA = {
  type: 'object',
  properties: {
    steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['steps'],
} as const;

const RECONCILE_STEPS_PROMPT = `You are a cooking assistant. The user swapped one ingredient in a recipe for another. Rewrite the preparation steps so they correctly reflect the new ingredient.

Return JSON only, matching the provided schema.

Rules:
- Change ONLY what the substitution requires: references to the old ingredient's name, quantity, or handling become the new ingredient's. If the new ingredient needs a different technique, time, or temperature, adjust that step accordingly.
- Leave every other step exactly as written.
- Preserve the original step order. Keep the same number of steps unless the swap genuinely makes one redundant.
- Return the FULL ordered list of steps, not just the changed ones.`;

const SUBSTITUTES_PROMPT = `You are a cooking assistant. Given a recipe, suggest practical ingredient substitutions.

Return JSON only, matching the provided schema.

Rules:
- For each ingredient that has genuinely useful alternatives, provide 1-3 substitution options. Skip ingredients with no sensible swap (e.g. water, salt) rather than inventing weak ones.
- ingredient: echo the ORIGINAL ingredient line EXACTLY as given, character for character, so it can be matched.
- replacement: the full replacement ingredient line, keeping a sensible quantity for the same yield.
- reason: a short phrase (e.g. "dairy-free", "lower fat", "pantry swap", "gluten-free").
- Prefer common, accessible substitutes across dietary, allergen, and pantry needs.`;

const HEALTHIER_PROMPT = `You are a cooking assistant. Rewrite the given recipe to satisfy the requested goal while keeping it delicious and realistic.

Return JSON only, matching the provided schema.

Rules:
- title: a short name that reflects the variant (you may append a hint like "(Lighter)"), but keep it human-friendly.
- ingredients: one item per array entry, quantity included, adjusted for the goal.
- steps: ordered preparation steps for the rewritten recipe.
- servings: integer the macros refer to; keep the original servings when possible.
- macros: per-serving calories (kcal), carbs (g), protein (g), fat (g) — your best estimate for the rewritten recipe.
- summary: one concise line describing what changed and why (e.g. "Swapped butter for olive oil and cut sugar to lower calories").`;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

/** Non-negative, finite, rounded macro value. */
function cleanMacro(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

function cleanMacros(macros: Partial<Macros> | undefined): Macros {
  return {
    calories: cleanMacro(macros?.calories),
    carbs: cleanMacro(macros?.carbs),
    protein: cleanMacro(macros?.protein),
    fat: cleanMacro(macros?.fat),
  };
}

/** Compact recipe context handed to the model as the user turn. */
function recipeToPrompt(recipe: RecipeInput): string {
  const lines = [
    `Title: ${recipe.title}`,
    recipe.servings ? `Servings: ${recipe.servings}` : null,
    '',
    'Ingredients:',
    ...recipe.ingredients.map((i) => `- ${i}`),
    '',
    'Steps:',
    ...recipe.steps.map((s, idx) => `${idx + 1}. ${s}`),
  ].filter((line) => line !== null);
  return lines.join('\n');
}

/**
 * Creates a recipe improver backed by the Gemini generateContent REST API,
 * reusing the same structured-output approach as the extraction parser.
 * `fetchImpl` is injectable for unit testing.
 */
export function createGeminiRecipeImprover(
  config: Pick<Config, 'geminiApiKey' | 'geminiModel'>,
  fetchImpl: typeof fetch = fetch,
): RecipeImprover {
  async function callGemini(
    systemPrompt: string,
    userText: string,
    responseSchema: unknown,
  ): Promise<unknown> {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${config.geminiModel}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema,
            temperature: 0.4,
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
      throw unprocessable('Gemini returned no content.');
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unprocessable('Gemini returned malformed JSON.');
    }
  }

  return {
    async suggestSubstitutes(recipe: RecipeInput): Promise<SubstitutionResult> {
      const raw = (await callGemini(
        SUBSTITUTES_PROMPT,
        recipeToPrompt(recipe),
        SUBSTITUTES_SCHEMA,
      )) as SubstitutionResult;

      const substitutions = (Array.isArray(raw?.substitutions) ? raw.substitutions : [])
        .map((entry) => ({
          ingredient: typeof entry?.ingredient === 'string' ? entry.ingredient.trim() : '',
          options: (Array.isArray(entry?.options) ? entry.options : [])
            .map((opt) => ({
              replacement: typeof opt?.replacement === 'string' ? opt.replacement.trim() : '',
              reason: typeof opt?.reason === 'string' ? opt.reason.trim() : '',
            }))
            .filter((opt) => opt.replacement.length > 0),
        }))
        .filter((entry) => entry.ingredient.length > 0 && entry.options.length > 0);

      if (substitutions.length === 0) {
        throw unprocessable('No substitutions could be suggested for this recipe.');
      }
      return { substitutions };
    },

    async makeHealthier(recipe: RecipeInput, goal: string): Promise<ImprovedRecipe> {
      const userText = `Goal: ${goal}\n\n${recipeToPrompt(recipe)}`;
      const raw = (await callGemini(HEALTHIER_PROMPT, userText, HEALTHIER_SCHEMA)) as ImprovedRecipe;

      const ingredients = (Array.isArray(raw?.ingredients) ? raw.ingredients : [])
        .map((i) => (typeof i === 'string' ? i.trim() : ''))
        .filter((i) => i.length > 0);
      const steps = (Array.isArray(raw?.steps) ? raw.steps : [])
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter((s) => s.length > 0);
      const title = typeof raw?.title === 'string' ? raw.title.trim() : '';

      if (!title || (ingredients.length === 0 && steps.length === 0)) {
        throw unprocessable('Could not generate an improved recipe.');
      }

      return {
        title,
        servings:
          typeof raw.servings === 'number' && raw.servings > 0
            ? Math.round(raw.servings)
            : recipe.servings,
        ingredients,
        steps,
        macros: cleanMacros(raw.macros),
        summary: typeof raw?.summary === 'string' ? raw.summary.trim() : '',
      };
    },

    async reconcileSteps(
      recipe: RecipeInput,
      from: string,
      to: string,
    ): Promise<{ steps: string[] }> {
      // Nothing to reconcile if the recipe has no steps.
      if (recipe.steps.length === 0) return { steps: [] };

      const userText =
        `${recipeToPrompt(recipe)}\n\n` +
        `Substitution made: replace "${from}" with "${to}".`;
      const raw = (await callGemini(RECONCILE_STEPS_PROMPT, userText, STEPS_SCHEMA)) as {
        steps?: unknown;
      };

      const steps = (Array.isArray(raw?.steps) ? raw.steps : [])
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter((s) => s.length > 0);

      // Fall back to the original steps rather than wiping them if the model
      // returns nothing usable — the ingredient swap must not lose the method.
      return { steps: steps.length > 0 ? steps : recipe.steps };
    },
  };
}
