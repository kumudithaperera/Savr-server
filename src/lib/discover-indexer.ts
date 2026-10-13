import type { ClassifyInput, RecipeClassifier } from '../services/classify.js';
import type { ImageRehoster } from '../services/rehost.js';
import type { DiscoverDb } from './discover-db.js';
import type { RecipeFeedDb } from './recipe-feed-db.js';
import { DAY_TTL_SECONDS, dayKey } from './period.js';
import { facetColumns, type RecipeFacets } from './recipe-facets.js';
import type { Store } from './store.js';
import type { ExtractedRecipe } from './types.js';
import { publicSourceUrl } from './url.js';

/**
 * Writes extractions into Discover's `recipe_index` and tags them.
 *
 * Called fire-and-forget from `/extract` after a validated cache fill, and by
 * the backfill script. Nothing here may fail an extraction: every error is
 * logged and swallowed.
 */

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export interface ClassifyBudget {
  store: Store;
  classifier?: RecipeClassifier;
  /** Service-wide classify calls per UTC day; its own budget, not `/improve`'s. */
  dailyClassifyLimit: number;
}

/**
 * Classifies under the daily ceiling. Null = over budget, no classifier, or the
 * call failed; the caller stores null facets and the sweep retries later.
 * Counted per attempt, like `/improve`, because a failed Gemini call is still
 * billed against the project's quota.
 */
export async function classifyWithinBudget(
  budget: ClassifyBudget,
  recipe: ClassifyInput,
  log?: Logger,
): Promise<RecipeFacets | null> {
  if (!budget.classifier) return null;
  const today = await budget.store.incrWithTtl(`g:day:classify:${dayKey(new Date())}`, DAY_TTL_SECONDS);
  if (today > budget.dailyClassifyLimit) return null;
  try {
    return await budget.classifier.classify(recipe);
  } catch (error) {
    log?.warn({ err: (error as Error).message }, 'classify failed');
    return null;
  }
}

export interface DiscoverIndexer {
  /**
   * Indexes one extraction. `creator` is the scraper's owner username, when
   * known. Resolves to whether a row was written; never rejects.
   */
  index(canonical: string, recipe: ExtractedRecipe, creator?: string, log?: Logger): Promise<boolean>;
  /** Classifies up to `limit` untagged rows. Returns how many were tagged. */
  sweep(limit: number, log?: Logger): Promise<number>;
}

export interface IndexerDeps extends ClassifyBudget {
  db: DiscoverDb;
  rehoster: ImageRehoster;
}

export function createDiscoverIndexer(deps: IndexerDeps): DiscoverIndexer {
  const { db } = deps;

  return {
    async index(canonical, recipe, creator, log) {
      if (!db.configured) return false;
      try {
        // Not publishable (a web link with a private-looking query, an
        // unrecognised shape): it stays a private cache entry only.
        const handle = creator && /^[A-Za-z0-9._]{1,40}$/.test(creator) ? creator : null;
        const sourceUrl = publicSourceUrl(canonical, handle, recipe.sourceUrl);
        if (!sourceUrl) return false;

        // Only an Instagram/TikTok thumbnail copied into our bucket is shown in
        // search. A blog's own photo stays in `recipe` and is downloaded by the
        // app only after someone saves it (see services/rehost.ts for why).
        const imageUrl = await deps.rehoster.rehost(recipe.imageRemoteUrl);
        const publicRecipe: ExtractedRecipe = { ...recipe, sourceUrl };
        await db.upsert({
          canonical_key: canonical,
          source_url: sourceUrl,
          source_platform: recipe.sourcePlatform,
          creator: handle && recipe.sourcePlatform !== 'web' ? `@${handle}` : null,
          image_url: imageUrl,
          servings: recipe.servings ?? null,
          ingredients: recipe.ingredients,
          recipe: publicRecipe,
          ...facetColumns(recipe, null),
        });

        const row = await db.getByKey(canonical);
        if (row && !row.classified_at) {
          const facets = await classifyWithinBudget(deps, recipe, log);
          if (facets) await db.setFacets(canonical, facets);
        }
        return true;
      } catch (error) {
        log?.warn({ err: (error as Error).message, canonical }, 'discover: indexing failed');
        return false;
      }
    },

    async sweep(limit, log) {
      if (!db.configured || !deps.classifier) return 0;
      let tagged = 0;
      try {
        for (const row of await db.unclassified(limit)) {
          const facets = await classifyWithinBudget(deps, row.recipe, log);
          if (!facets) break; // over budget or failing: try again next sweep
          await db.setFacets(row.canonical_key, facets);
          tagged++;
        }
      } catch (error) {
        log?.warn({ err: (error as Error).message }, 'discover: sweep failed');
      }
      return tagged;
    },
  };
}

/**
 * The same retry for community posts: a share whose classify call failed
 * (usually a Gemini rate limit right after its moderation call) is tagged
 * later instead of never. Returns how many were tagged; never rejects.
 */
export async function sweepUntaggedPosts(
  db: RecipeFeedDb,
  budget: ClassifyBudget,
  limit: number,
  log?: Logger,
): Promise<number> {
  if (!db.configured || !budget.classifier) return 0;
  let tagged = 0;
  try {
    for (const post of await db.untagged(limit)) {
      const facets = await classifyWithinBudget(budget, post.recipe, log);
      if (!facets) break;
      await db.setFacets(post.id, facets);
      tagged++;
    }
  } catch (error) {
    log?.warn({ err: (error as Error).message }, 'feed: tag sweep failed');
  }
  return tagged;
}
