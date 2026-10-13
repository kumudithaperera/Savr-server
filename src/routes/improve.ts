import type { FastifyInstance } from 'fastify';

import type { RecipeImprover } from '../services/improve.js';
import { AI_CACHE_TTL_SECONDS, improveCacheKey } from '../lib/ai-cache.js';
import { countAi } from '../lib/ai-stats.js';
import { atCapacity, rateLimited, unprocessable } from '../lib/errors.js';
import { deviceIdOf } from '../lib/grants.js';
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
  /** AI improvements per install per day. Defaults to `DEFAULT_DEVICE_DAILY_IMPROVE_LIMIT`. */
  deviceDailyImproveLimit?: number;
}

/**
 * Generous for one person cooking (a substitution, a few adjustments, the
 * step reconciles they trigger), small next to the global ceiling.
 */
export const DEFAULT_DEVICE_DAILY_IMPROVE_LIMIT = 40;

type ImproveMode =
  | 'substitutes'
  | 'healthier'
  | 'adjust'
  | 'reconcile-steps'
  | 'reconcile-steps-batch';

interface ImproveBody {
  mode?: unknown;
  recipe?: unknown;
  goal?: unknown;
  target?: unknown;
  direction?: unknown;
  amount?: unknown;
  from?: unknown;
  to?: unknown;
  swaps?: unknown;
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
 * Validates the mode-specific fields and returns the call to make. Throws 422
 * on a bad body, before anything is charged.
 */
function plan(
  mode: ImproveMode,
  recipe: RecipeInput,
  body: ImproveBody,
  improver: RecipeImprover,
): { params: unknown; run: () => Promise<unknown> } {
  if (mode === 'substitutes') {
    return { params: null, run: () => improver.suggestSubstitutes(recipe) };
  }

  if (mode === 'adjust') {
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    if (!target) {
      throw unprocessable("'target' is required.");
    }
    const direction = body.direction;
    if (direction !== 'less' && direction !== 'more') {
      throw unprocessable("'direction' must be 'less' or 'more'.");
    }
    const amount = body.amount;
    const resolvedAmount =
      amount === 'a little' || amount === 'moderately' || amount === 'a lot' ? amount : 'moderately';
    const params = { target, direction, amount: resolvedAmount } as const;
    return { params, run: () => improver.adjust(recipe, params) };
  }

  if (mode === 'reconcile-steps') {
    const from = typeof body.from === 'string' ? body.from.trim() : '';
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (!from || !to) {
      throw unprocessable("'from' and 'to' ingredient lines are required.");
    }
    return { params: { from, to }, run: () => improver.reconcileSteps(recipe, from, to) };
  }

  if (mode === 'reconcile-steps-batch') {
    if (!Array.isArray(body.swaps)) {
      throw unprocessable("'swaps' must be an array.");
    }
    const swaps = body.swaps as unknown[];
    if (swaps.length === 0) {
      throw unprocessable("'swaps' must not be empty.");
    }
    if (swaps.length > 10) {
      throw unprocessable("'swaps' must not exceed 10 entries.");
    }
    const validated: { from: string; to: string }[] = [];
    for (let i = 0; i < swaps.length; i++) {
      const s = swaps[i] as Record<string, unknown>;
      const from = typeof s?.from === 'string' ? s.from.trim() : '';
      const to = typeof s?.to === 'string' ? s.to.trim() : '';
      if (!from || !to) {
        throw unprocessable(`'swaps[${i}]' must have non-empty 'from' and 'to' strings.`);
      }
      validated.push({ from, to });
    }
    return { params: validated, run: () => improver.reconcileStepsBatch(recipe, validated) };
  }

  const goal = typeof body.goal === 'string' && body.goal.trim() ? body.goal.trim() : 'make it healthier';
  return { params: { goal }, run: () => improver.makeHealthier(recipe, goal) };
}

/**
 * Registers `POST /improve`. Body: `{ mode, recipe, goal? }`. Validates the
 * body, charges the global daily ceiling, then dispatches to the matching AI
 * improvement (substitutes or healthier rewrite). Error mapping is handled
 * centrally.
 */
export function registerImproveRoute(app: FastifyInstance, deps: ImproveDeps): void {
  const { store, globalDailyImproveLimit } = deps;
  const deviceDailyImproveLimit = deps.deviceDailyImproveLimit ?? DEFAULT_DEVICE_DAILY_IMPROVE_LIMIT;

  app.post<{ Body: ImproveBody }>('/improve', async (request) => {
    const mode = request.body?.mode as ImproveMode;
    if (
      mode !== 'substitutes' &&
      mode !== 'healthier' &&
      mode !== 'adjust' &&
      mode !== 'reconcile-steps' &&
      mode !== 'reconcile-steps-batch'
    ) {
      throw unprocessable(
        "mode must be 'substitutes', 'healthier', 'adjust', 'reconcile-steps', or 'reconcile-steps-batch'.",
      );
    }
    const recipe = assertRecipeInput(request.body?.recipe);
    // Validated up front so a bad body costs nothing; `params` is everything
    // besides the recipe that shapes the answer, and part of the cache key.
    const { params, run } = plan(mode, recipe, request.body ?? {}, deps.improver);

    // The same recipe gets the same request often - Discover and the feed
    // hand one recipe to many people - so a repeat is answered from the cache
    // and costs neither allowance nor a model call.
    const cacheKey = improveCacheKey(mode, { recipe, params });
    const cached = await store.getJson<unknown>(cacheKey);
    if (cached) {
      await countAi(store, 'improveCacheHit');
      return cached;
    }

    // Charged after validation but before the call, and counted on every
    // attempt rather than on success: a Gemini request that errors out has
    // already been billed against the project's daily allowance, so only
    // counting successes would let a failing day run straight through the
    // ceiling. Rejected bodies never reach here and cost nothing.
    //
    // The per-install cap comes first, so one busy device can't spend the
    // shared ceiling for everyone. Unlike `/extract`, both apply to Plus
    // members too: the global one is not a per-user allowance - it is the
    // point past which the shared free-tier quota is gone and the next call
    // would 502 for everyone.
    const day = dayKey(new Date());
    const mine = await store.incrWithTtl(`q:improve:${deviceIdOf(request)}:${day}`, DAY_TTL_SECONDS);
    if (mine > deviceDailyImproveLimit) {
      throw rateLimited("You've used today's AI assistant requests. Please try again tomorrow.");
    }
    const today = await store.incrWithTtl(`g:day:improve:${day}`, DAY_TTL_SECONDS);
    if (today > globalDailyImproveLimit) {
      request.log.warn({ today, mode }, 'global daily improve ceiling reached');
      throw atCapacity(
        "Morsel's AI assistant is at capacity today. Please try again tomorrow - everything else on the recipe still works.",
      );
    }

    await countAi(store, 'improve');
    const result = await run();
    try {
      await store.setJson(cacheKey, result, AI_CACHE_TTL_SECONDS);
    } catch {
      // the cache is an optimisation
    }
    return result;
  });
}
