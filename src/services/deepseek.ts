/**
 * DeepSeek text-based recipe parser.
 *
 * Uses DeepSeek API as a low-cost text reasoning layer for recipe extraction.
 * This is Level 2 in the three-level architecture:
 * - Level 1: Primary extraction (existing Gemini text parser)
 * - Level 2: DeepSeek for cheap text analysis
 * - Level 3: Gemini video fallback (expensive, multimodal)
 *
 * DeepSeek should only be called when Level 1 produces insufficient results
 * but useful text is available (caption, comments, transcript).
 */

import type { Config } from '../config.js';
import { unprocessable, upstreamError } from '../lib/errors.js';
import { FACET_GUIDE, FACET_SCHEMA_PROPERTIES } from '../lib/facet-rules.js';
import { CATEGORIES, type ParsedRecipe } from '../lib/types.js';
import { validateParsedRecipe } from '../lib/validate.js';

export interface DeepSeekRecipeParser {
  /**
   * Analyzes text content to extract recipe information.
   * @param text Combined text from caption, comments, transcript, etc.
   * @param partialRecipe Incomplete recipe from Level 1 (for context)
   */
  parseText(
    text: string,
    partialRecipe?: Partial<ParsedRecipe>,
  ): Promise<DeepSeekResult>;
}

/** Result from DeepSeek analysis including sufficiency assessment. */
export interface DeepSeekResult {
  /** The extracted recipe (may be partial). */
  recipe: ParsedRecipe;
  /** Whether DeepSeek considers the extraction sufficient to use. */
  sufficient: boolean;
  /** Confidence score 0-1. */
  confidence: number;
  /** List of missing information that would make the recipe more complete. */
  missing: string[];
}

const DEEPSEEK_SYSTEM_PROMPT = `You are a recipe extraction specialist. Extract recipe information from the provided text, which may be a social media caption, comments, transcript, or combination.

Return JSON only, matching the exact schema provided.

RULES:
1. isRecipe: Set to true ONLY if the text contains actual recipe information (ingredients, steps, or both). A dish name alone is NOT a recipe.

2. DO NOT INVENT INFORMATION:
   - If quantities are not stated, do not guess them
   - If cooking times are not stated, do not estimate them
   - If ingredients are not listed, do not assume them from the dish name
   - Mark what is actually missing in the "missing" array

3. For ingredients:
   - Include quantities ONLY when explicitly stated
   - Keep original units and measurements
   - Keep original ingredient names (do not translate "haldi" to "turmeric")

4. For steps:
   - Include only instructions that are actually written
   - Include times and temperatures only when stated

5. Assess sufficiency honestly:
   - sufficient=true: Recipe has at least 3 ingredients with quantities AND at least 2 clear steps
   - sufficient=false: Recipe is incomplete or missing critical information
   - confidence: Your confidence in the extraction (0.0 to 1.0)

6. In the "missing" array, list what would make the recipe complete:
   - "ingredient quantities" if most ingredients lack amounts
   - "cooking instructions" if steps are vague or missing
   - "cooking time" if duration is not specified
   - "temperature" if baking/cooking temp is needed but not stated

7. Language: Preserve the source language for title, ingredients, and steps.

8. suggestedCategory: Choose from meals, drinks, snacks, desserts.

9. Macros: Only include if explicitly stated in the text. Otherwise estimate from ingredients. Set macrosStatedInCaption accordingly.

10. Search tags - also return "dietTags" (array of strings) and "totalMinutes" (integer). These never change the fields above:
${FACET_GUIDE}`;

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
    ...FACET_SCHEMA_PROPERTIES,
    sufficient: { type: 'boolean' },
    confidence: { type: 'number' },
    missing: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'isRecipe',
    'title',
    'ingredients',
    'steps',
    'macros',
    'macrosStatedInCaption',
    'suggestedCategory',
    'sufficient',
    'confidence',
    'missing',
  ],
};

interface DeepSeekResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
    finish_reason?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

interface DeepSeekParsedResponse extends ParsedRecipe {
  sufficient: boolean;
  confidence: number;
  missing: string[];
}

/**
 * Creates a DeepSeek recipe parser.
 * `fetchImpl` is injectable for testing.
 */
export function createDeepSeekRecipeParser(
  config: Pick<Config, 'deepseekApiKey' | 'deepseekModel' | 'deepseekBaseUrl'>,
  fetchImpl: typeof fetch = fetch,
): DeepSeekRecipeParser {
  return {
    async parseText(
      text: string,
      partialRecipe?: Partial<ParsedRecipe>,
    ): Promise<DeepSeekResult> {
      if (!config.deepseekApiKey) {
        throw upstreamError('DeepSeek API key not configured');
      }

      // Build context from partial recipe if available
      let userPrompt = text;
      if (partialRecipe) {
        const contextParts: string[] = [];
        if (partialRecipe.title) {
          contextParts.push(`Previous extraction found title: ${partialRecipe.title}`);
        }
        if (partialRecipe.ingredients?.length) {
          contextParts.push(
            `Previous extraction found ingredients:\n${partialRecipe.ingredients.join('\n')}`,
          );
        }
        if (partialRecipe.steps?.length) {
          contextParts.push(
            `Previous extraction found steps:\n${partialRecipe.steps.join('\n')}`,
          );
        }
        if (contextParts.length > 0) {
          userPrompt = `${text}\n\n---\nContext from previous extraction (may be incomplete):\n${contextParts.join('\n\n')}`;
        }
      }

      const endpoint = `${config.deepseekBaseUrl}/v1/chat/completions`;

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.deepseekApiKey}`,
          },
          body: JSON.stringify({
            model: config.deepseekModel,
            messages: [
              { role: 'system', content: DEEPSEEK_SYSTEM_PROMPT },
              { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
          }),
        });
      } catch (err) {
        throw upstreamError(`Could not reach DeepSeek: ${(err as Error).message}`);
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw upstreamError(`DeepSeek returned HTTP ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as DeepSeekResponse;

      if (data.error) {
        throw upstreamError(`DeepSeek error: ${data.error.message ?? data.error.type ?? 'Unknown'}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw unprocessable('DeepSeek returned no recipe content.');
      }

      let parsed: DeepSeekParsedResponse;
      try {
        parsed = JSON.parse(content) as DeepSeekParsedResponse;
      } catch {
        throw unprocessable('DeepSeek returned malformed recipe JSON.');
      }

      const validated = validateParsedRecipe(parsed);
      if (!validated.success) {
        throw unprocessable('DeepSeek returned a malformed recipe response.');
      }

      // Extract recipe portion and metadata separately
      const recipe: ParsedRecipe = validated.data;

      return {
        recipe,
        sufficient: parsed.sufficient ?? false,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      };
    },
  };
}
