import type { FastifyInstance } from 'fastify';

import type { RecipeImprover } from '../services/improve.js';
import { atCapacity, unprocessable } from '../lib/errors.js';
import { DAY_TTL_SECONDS, dayKey } from '../lib/period.js';
import type { Store } from '../lib/store.js';
import type { RecipeInput } from '../lib/types.js';

interface ImproveDeps {
  improver: RecipeImprover;
  store: Store;
  /**
   * Service-wide AI improvements per day. `/improve` and `/extract` both spend
   * the same project-wide Gemini free-tier allowance, but they get **separate**
   * daily ceilings on purpose: the extraction ceiling is sized against Apify's
   * credit, which `/improve` doesn't touch, so pooling them would let the AI
   * Kitchen Assistant eat an extraction budget it costs nothing towards - and
   * conversely leave improvements hostage to a busy extraction day.
   */
  globalDailyImproveLimit: number;
}

type ImproveMode = 'substitutes' | 'healthier' | 'reconcile-steps';

interface ImproveBody {
  mode?: unknown;
  recipe?: unknown;
  goal?: unknown;
  from?: unknown;
  to?: unknown;
}

/** Validates and coerces the request body's `recipe` into a `RecipeInput`. */
function assertRecipeInput(value: unknown): RecipeInput {
  if (!value || typeof value !== 'object') {
    throw unprocessable('A recipe is required.');
  }
  const recipe = value as Record<string, unknown>;
  const title = typeof recipe.title === 'string' ? recipe.title.trim() : '';
  const ingredients = Array.isArray(recipe.ingredients)
    ? recipe.ingredients.filter((i): i is string => typeof i === 'string')
    : [];
  const steps = Array.isArray(recipe.steps)
    ? recipe.steps.filter((s): s is string => typeof s === 'string')
    : [];

  if (!title || ingredients.length === 0) {
    throw unprocessable('The recipe needs a title and at least one ingredient.');
  }

  return {
    title,
    servings:
      typeof recipe.servings === 'number' && recipe.servings > 0 ? recipe.servings : undefined,
    ingredients,
    steps,
    macros:
      recipe.macros && typeof recipe.macros === 'object'
        ? (recipe.macros as RecipeInput['macros'])
        : undefined,
  };
}

/**
 * Registers `POST /improve`. Body: `{ mode, recipe, goal? }`. Validates the
 * body, charges the global daily ceiling, then dispatches to the matching AI
 * improvement (substitutes or healthier rewrite). Error mapping is handled
 * centrally.
 */
export function registerImproveRoute(app: FastifyInstance, deps: ImproveDeps): void {
  const { store, globalDailyImproveLimit } = deps;

  app.post<{ Body: ImproveBody }>('/improve', async (request) => {
    const mode = request.body?.mode as ImproveMode;
    if (mode !== 'substitutes' && mode !== 'healthier' && mode !== 'reconcile-steps') {
      throw unprocessable("mode must be 'substitutes', 'healthier', or 'reconcile-steps'.");
    }
    const recipe = assertRecipeInput(request.body?.recipe);

    // Charged after validation but before the call, and counted on every
    // attempt rather than on success: a Gemini request that errors out has
    // already been billed against the project's daily allowance, so only
    // counting successes would let a failing day run straight through the
    // ceiling. Rejected bodies never reach here and cost nothing.
    //
    // Unlike `/extract` this ceiling applies to Plus members too. It is not a
    // per-user allowance - it is the point past which the shared free-tier
    // quota is gone and the next call would 502 for everyone.
    const today = await store.incrWithTtl(`g:day:improve:${dayKey(new Date())}`, DAY_TTL_SECONDS);
    if (today > globalDailyImproveLimit) {
      request.log.warn({ today, mode }, 'global daily improve ceiling reached');
      throw atCapacity(
        "Morsel's AI assistant is at capacity today. Please try again tomorrow - everything else on the recipe still works.",
      );
    }

    if (mode === 'substitutes') {
      return deps.improver.suggestSubstitutes(recipe);
    }

    if (mode === 'reconcile-steps') {
      const from = typeof request.body?.from === 'string' ? request.body.from.trim() : '';
      const to = typeof request.body?.to === 'string' ? request.body.to.trim() : '';
      if (!from || !to) {
        throw unprocessable("'from' and 'to' ingredient lines are required.");
      }
      return deps.improver.reconcileSteps(recipe, from, to);
    }

    const goal =
      typeof request.body?.goal === 'string' && request.body.goal.trim()
        ? request.body.goal.trim()
        : 'make it healthier';
    return deps.improver.makeHealthier(recipe, goal);
  });
}
