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

/**
 * Micronutrients we surface for Morsel Plus "advanced nutrition", keyed by FDC
 * `nutrientId`. These are the SR Legacy ids - the search results this service
 * actually selects from (Foundation rows carry no macros, so food picking
 * always falls through to SR Legacy). Verified live against
 * `https://api.nal.usda.gov/fdc/v1/foods/search`.
 */
const MICRONUTRIENT = {
  fiber: 1079, // Fiber, total dietary (g)
  sugars: 2000, // Total Sugars (g)
  sodium: 1093, // Sodium, Na (mg)
  potassium: 1092, // Potassium, K (mg)
  calcium: 1087, // Calcium, Ca (mg)
  iron: 1089, // Iron, Fe (mg)
  magnesium: 1090, // Magnesium, Mg (mg)
  zinc: 1095, // Zinc, Zn (mg)
  saturatedFat: 1258, // Fatty acids, total saturated (g)
  monounsaturatedFat: 1292, // Fatty acids, total monounsaturated (g)
  polyunsaturatedFat: 1293, // Fatty acids, total polyunsaturated (g)
  cholesterol: 1253, // Cholesterol (mg)
  vitaminC: 1162, // Vitamin C, total ascorbic acid (mg)
  vitaminARae: 1106, // Vitamin A, RAE (µg)
  vitaminD: 1114, // Vitamin D (D2 + D3) (µg)
} as const;

/** Macros per 100 g for a single USDA food. Mirrors the app's `FoodMacros`. */
export interface FoodMacros {
  caloriesPer100g: number;
  proteinPer100g: number;
  carbsPer100g: number;
  fatPer100g: number;
}

/** Micronutrients per 100 g for a single USDA food. Mirrors the app's `FoodMicros`. */
export interface FoodMicros {
  fiberG: number;
  sugarsG: number;
  sodiumMg: number;
  potassiumMg: number;
  calciumMg: number;
  ironMg: number;
  magnesiumMg: number;
  zincMg: number;
  saturatedFatG: number;
  monounsaturatedFatG: number;
  polyunsaturatedFatG: number;
  cholesterolMg: number;
  vitaminCMg: number;
  vitaminARaeUg: number;
  vitaminDUg: number;
}

/** A matched USDA food's macro and micronutrient profile, per 100 g. */
export interface FoodNutrition {
  macros: FoodMacros;
  micros: FoodMicros;
}

export interface NutritionLookup {
  /** Best-matching food's per-100 g nutrition, or null when nothing usable matched. */
  search(query: string): Promise<FoodNutrition | null>;
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

function toMicros(food: FdcFood): FoodMicros {
  return {
    fiberG: readNutrient(food, MICRONUTRIENT.fiber),
    sugarsG: readNutrient(food, MICRONUTRIENT.sugars),
    sodiumMg: readNutrient(food, MICRONUTRIENT.sodium),
    potassiumMg: readNutrient(food, MICRONUTRIENT.potassium),
    calciumMg: readNutrient(food, MICRONUTRIENT.calcium),
    ironMg: readNutrient(food, MICRONUTRIENT.iron),
    magnesiumMg: readNutrient(food, MICRONUTRIENT.magnesium),
    zincMg: readNutrient(food, MICRONUTRIENT.zinc),
    saturatedFatG: readNutrient(food, MICRONUTRIENT.saturatedFat),
    monounsaturatedFatG: readNutrient(food, MICRONUTRIENT.monounsaturatedFat),
    polyunsaturatedFatG: readNutrient(food, MICRONUTRIENT.polyunsaturatedFat),
    cholesterolMg: readNutrient(food, MICRONUTRIENT.cholesterol),
    vitaminCMg: readNutrient(food, MICRONUTRIENT.vitaminC),
    vitaminARaeUg: readNutrient(food, MICRONUTRIENT.vitaminARae),
    vitaminDUg: readNutrient(food, MICRONUTRIENT.vitaminD),
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
    async search(query: string): Promise<FoodNutrition | null> {
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
      return usable ? { macros: toMacros(usable), micros: toMicros(usable) } : null;
    },
  };
}
