import type { FastifyInstance } from 'fastify';

import type { CommunityDb } from '../lib/community-db.js';
import { asBody, createCommunityIdentity } from '../lib/community-kit.js';
import type { DiscoverDb } from '../lib/discover-db.js';
import { HttpError, rateLimited } from '../lib/errors.js';
import { DIET_TAGS, facetDto, plannerTerms, type DietTag, type RecipeFilters } from '../lib/recipe-facets.js';
import type { RecipeFeedDb } from '../lib/recipe-feed-db.js';
import type { Store } from '../lib/store.js';

/**
 * Smart Planner: recipes from outside someone's cookbook, for the meal slots
 * their own recipes can't fill.
 *
 * The planning itself happens on the device. This route only hands back
 * candidates - Discover web-index entries and community posts that match the
 * caller's diet tags, avoid their excluded ingredients and sit in a calorie
 * range - with their ingredient lines (the planner scores shared ingredients
 * on them). Never the steps: those still come only from the save routes, so
 * the planner can't be used to walk the index for full recipes.
 *
 * No AI call and no Plus check: every field here is already public through
 * `/discover/search` and `/community/recipes`; the per-device daily cap is
 * what bounds it, as on Discover.
 */

export interface PlannerOptions {
  discoverDb: DiscoverDb;
  recipeFeedDb: RecipeFeedDb;
  communityDb: CommunityDb;
  store: Store;
  hashPepper: string;
}

export const PLANNER_LIMITS = { maxCandidates: 60 } as const;
export const PLANNER_DAILY_CAP = 30;

export interface PlannerCandidateDto extends ReturnType<typeof facetDto> {
  id: string;
  kind: 'web' | 'post';
  imageUrl: string | null;
  /** Servings the ingredient list makes, or null when the source didn't say. */
  servings: number | null;
  ingredients: string[];
}

/** A positive whole serving count, or null. */
function servingsOf(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), 99) : null;
}

function kcal(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 9999) : fallback;
}

export function registerPlannerRoutes(app: FastifyInstance, deps: PlannerOptions): void {
  const { discoverDb, recipeFeedDb, communityDb, store } = deps;
  const { callerOf } = createCommunityIdentity(deps.hashPepper);

  app.post('/planner/candidates', async (request) => {
    if (!discoverDb.configured && !recipeFeedDb.configured) {
      throw new HttpError(503, 'planner_unavailable', 'Suggestions are unavailable right now.');
    }
    const me = callerOf(request);
    if (!me) throw new HttpError(400, 'device_required', 'Update the app to get suggestions.');
    if (communityDb.configured && (await communityDb.isBanned(me))) {
      throw new HttpError(403, 'banned', "You can't use suggestions.");
    }
    const day = new Date().toISOString().slice(0, 10);
    const count = await store.incrWithTtl(`planner:candidates:${me}:${day}`, 26 * 60 * 60);
    if (count > PLANNER_DAILY_CAP) {
      throw rateLimited("You've reached today's limit for suggestions. Try again tomorrow.");
    }

    const body = asBody(request);
    const diet = Array.isArray(body.dietTags)
      ? DIET_TAGS.filter((tag) => (body.dietTags as unknown[]).includes(tag))
      : ([] as DietTag[]);
    const minKcal = kcal(body.minKcal, 0);
    const maxKcal = Math.max(kcal(body.maxKcal, 9999), minKcal);
    const limit = Math.min(Math.max(Math.round(Number(body.limit) || 0), 1), PLANNER_LIMITS.maxCandidates);

    const filters: RecipeFilters = {
      terms: [],
      category: null,
      categories: ['meals', 'snacks'],
      diet: [...new Set(diet)],
      maxCalories: maxKcal,
      minCalories: minKcal > 0 ? minKcal : null,
      maxMinutes: null,
      excluded: plannerTerms(body.excluded),
    };

    // Half from each source, topped up by whichever has more.
    const half = Math.ceil(limit / 2);
    const [web, posts] = await Promise.all([
      discoverDb.configured ? discoverDb.plannerSearch(filters, limit) : Promise.resolve([]),
      recipeFeedDb.configured
        ? recipeFeedDb.list({ filters, sort: 'popular', offset: 0, limit, excludeAuthors: [me] })
        : Promise.resolve([]),
    ]);

    const webDtos: PlannerCandidateDto[] = web.map((row) => ({
      id: row.id,
      kind: 'web',
      ...facetDto(row),
      imageUrl: row.image_url,
      servings: servingsOf(row.servings),
      ingredients: row.ingredients,
    }));
    const postDtos: PlannerCandidateDto[] = posts.map((row) => ({
      id: row.id,
      kind: 'post',
      ...facetDto(row),
      imageUrl: row.image_url,
      servings: servingsOf(row.servings ?? row.recipe.servings),
      ingredients: row.recipe.ingredients ?? [],
    }));

    const takeWeb = Math.min(webDtos.length, Math.max(half, limit - postDtos.length));
    const takePosts = Math.min(postDtos.length, limit - takeWeb);
    return { candidates: [...webDtos.slice(0, takeWeb), ...postDtos.slice(0, takePosts)] };
  });
}
