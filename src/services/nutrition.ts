/**
 * USDA FoodData Central lookup, moved here from the app.
 *
 * It used to run on-device with an `EXPO_PUBLIC_USDA_API_KEY`, which Expo inlines
 * into the JS bundle - extractable from any APK with `unzip` + `grep`. Holding
 * the key server-side means the client ships no third-party credential at all,
 * and the lookup inherits the same guardrail (shared secret + per-IP rate limit)
 * as the expensive routes.
 */

import { upstreamError } from '../lib/errors.js';
import { HttpError } from '../lib/errors.js';

const FDC_SEARCH = 'https://api.nal.usda.gov/fdc/v1/foods/search';

/**
 * USDA `nutrientId`s we care about (values are per 100 g). These are the stable
 * FDC nutrient ids - note they are NOT the `nutrientNumber` field (energy's
 * number is "208", and there are separate kJ/Atwater energy rows), so we match
 * on `nutrientId` to avoid grabbing the wrong "Energy" entry.
 */
const NUTRIENT = { calories: 1008, protein: 1003, fat: 1004, carbs: 1005 } as const;

/** Macros per 100 g for a single USDA food. Mirrors the app's `FoodMacros`. */
export interface FoodMacros {
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
}

export interface NutritionLookup {
  /** Best-matching food's per-100 g macros, or null when nothing usable matched. */
  search(query: string): Promise<FoodMacros | null>;
}

interface FdcNutrient {
  nutrientId?: number;
  value?: number;
}

interface FdcFood {
  description: string;
  foodNutrients?: FdcNutrient[];
}

function readNutrient(food: FdcFood, nutrientId: number): number {
  const match = food.foodNutrients?.find((n) => n.nutrientId === nutrientId);
  return match?.value ?? 0;
}

function toMacros(food: FdcFood): FoodMacros {
  return {
    caloriesPer100g: readNutrient(food, NUTRIENT.calories),
    proteinPer100g: readNutrient(food, NUTRIENT.protein),
    carbsPer100g: readNutrient(food, NUTRIENT.carbs),
    fatPer100g: readNutrient(food, NUTRIENT.fat),
  };
}

/**
 * Normalizes a free-text food name into something FDC's search accepts. Notably
 * the endpoint returns HTTP 400 on an encoded "/" (e.g. "oil/butter"), so
 * slashes are swapped for spaces and whitespace is collapsed.
 */
function sanitizeQuery(query: string): string {
  return query.replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Builds the lookup. `usdaApiKey` may be empty, in which case USDA's shared
 * `DEMO_KEY` is used - it works, but is rate-limited to a few dozen requests an
 * hour *globally across every caller using it*, so set a real key in production.
 */
export function createUsdaNutritionLookup(deps: { usdaApiKey: string }): NutritionLookup {
  const apiKey = deps.usdaApiKey || 'DEMO_KEY';

  return {
    async search(query: string): Promise<FoodMacros | null> {
      const clean = sanitizeQuery(query);
      if (!clean) return null;

      const url =
        `${FDC_SEARCH}?api_key=${encodeURIComponent(apiKey)}` +
        `&query=${encodeURIComponent(clean)}` +
        // A handful of results, not just one: the top hit sometimes carries only
        // partial nutrients (e.g. fatty-acid rows and no Energy), so we pick the
        // first food that actually reports calories.
        `&pageSize=8&dataType=${encodeURIComponent('Foundation,SR Legacy')}`;

      let response: Response;
      try {
        response = await fetch(url);
      } catch {
        throw upstreamError('Could not reach USDA. Please try again.');
      }

      // Our key problem, not the caller's - never echo the upstream body, which
      // can quote the key back in its error text.
      if (response.status === 401 || response.status === 403) {
        throw upstreamError('Nutrition data is unavailable right now.');
      }
      if (response.status === 429) {
        throw new HttpError(
          429,
          'rate_limited',
          'USDA rate limit hit. Please try again in a little while.',
        );
      }
      // Any other non-OK status is specific to this one query (a food FDC
      // couldn't parse), so report "no match" rather than failing the check.
      if (!response.ok) return null;

      const body = (await response.json()) as { foods?: FdcFood[] };
      const foods = body.foods ?? [];
      if (foods.length === 0) return null;

      // Prefer the first result that reports calories; fall back to no match.
      const usable = foods.find((f) => readNutrient(f, NUTRIENT.calories) > 0);
      return usable ? toMacros(usable) : null;
    },
  };
}
