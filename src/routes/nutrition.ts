import type { FastifyInstance } from 'fastify';

import type { NutritionLookup } from '../services/nutrition.js';
import { badRequest } from '../lib/errors.js';

interface NutritionDeps {
  nutrition: NutritionLookup;
}

interface NutritionBody {
  query?: unknown;
}

/** Longest ingredient line we'll forward. Real ones are a few words. */
const MAX_QUERY_LENGTH = 200;

/**
 * Registers `POST /nutrition`. Body: `{ query }`. Returns `{ macros, micros }` -
 * the per-100 g macros and micronutrients for the best-matching USDA food, or
 * both null when nothing matched, which the app treats as "skip this ingredient"
 * (macros) / "no breakdown to show" (micros).
 *
 * Exists so the USDA key lives on the server instead of in the app bundle. The
 * app calls this once per distinct ingredient during a nutrition cross-check, so
 * it is chattier than /extract but individually cheap; the per-IP rate limit on
 * the protected paths is what bounds it. The micros ride on the same call as
 * the macros - FDC returns both in the one search response, so there is no
 * second upstream hit for Morsel Plus "advanced nutrition".
 */
export function registerNutritionRoute(app: FastifyInstance, deps: NutritionDeps): void {
  app.post<{ Body: NutritionBody }>('/nutrition', async (request) => {
    const raw = request.body?.query;
    const query = typeof raw === 'string' ? raw.trim() : '';
    if (!query) {
      throw badRequest('A query is required.');
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw badRequest('That query is too long.');
    }

    const nutrition = await deps.nutrition.search(query);
    return nutrition ?? { macros: null, micros: null };
  });
}
