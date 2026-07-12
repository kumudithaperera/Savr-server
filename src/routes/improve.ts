import type { FastifyInstance } from 'fastify';

import type { RecipeImprover } from '../services/improve.js';
import { unprocessable } from '../lib/errors.js';
import type { RecipeInput } from '../lib/types.js';

interface ImproveDeps {
  improver: RecipeImprover;
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
 * Registers `POST /improve`. Body: `{ mode, recipe, goal? }`. Dispatches to the
 * matching AI improvement (substitutes or healthier rewrite). Error mapping is
 * handled centrally.
 */
export function registerImproveRoute(app: FastifyInstance, deps: ImproveDeps): void {
  app.post<{ Body: ImproveBody }>('/improve', async (request) => {
    const mode = request.body?.mode as ImproveMode;
    if (mode !== 'substitutes' && mode !== 'healthier' && mode !== 'reconcile-steps') {
      throw unprocessable("mode must be 'substitutes', 'healthier', or 'reconcile-steps'.");
    }
    const recipe = assertRecipeInput(request.body?.recipe);

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
