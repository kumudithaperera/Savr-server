import type { FastifyInstance } from 'fastify';

import type { NutritionLookup } from '../services/nutrition.js';
import { requireQuery } from '../lib/query.js';

interface NutritionDeps {
  nutrition: NutritionLookup;
}

interface NutritionBody {
  query?: unknown;
}

/**
 * Registers `POST /nutrition`. Body: `{ query }`. Returns `{ macros, micros }` -
 * the per-100 g macros and micronutrients for the best-matching food, or both
 * null when nothing matched, which the app treats as "skip this ingredient"
 * (macros) / "no breakdown to show" (micros).
 *
 * The lookup answers via a brand-first, two-source chain: Open Food Facts when
 * the ingredient names a specific branded product (verified against the brand,
 * with USDA as the generic fallback), otherwise USDA FoodData Central. See
 * `services/nutrition.ts` and `services/openfoodfacts.ts`.
 *
 * The route exists so third-party credentials live on the server instead of in
 * the app bundle. The app calls it once per distinct ingredient during a
 * nutrition cross-check, so it is chattier than /extract but individually
 * cheap; the per-IP rate limit on the protected paths is what bounds it. The
 * micros ride on the same call as the macros - both sources return them on the
 * one search response, so there is no second upstream hit for Morsel Plus
 * "advanced nutrition".
 */
export function registerNutritionRoute(app: FastifyInstance, deps: NutritionDeps): void {
  app.post<{ Body: NutritionBody }>('/nutrition', async (request) => {
    const query = requireQuery(request.body?.query);

    const nutrition = await deps.nutrition.search(query);
    return nutrition ?? { macros: null, micros: null };
  });
}
