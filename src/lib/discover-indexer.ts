import { AI_CACHE_TTL_SECONDS, facetsCacheKey } from './ai-cache.js';
import { countAi } from './ai-stats.js';
import { deriveFacets } from './facet-rules.js';
import type { ImageRehoster } from '../services/rehost.js';
import type { DiscoverDb } from './discover-db.js';
import { facetColumns, type RecipeFacets } from './recipe-facets.js';
import type { Store } from './store.js';
import type { ExtractedRecipe } from './types.js';
import { publicSourceUrl } from './url.js';

/**
 * Writes extractions into Discover's `recipe_index` and tags them.
 *
 * Called fire-and-forget from `/extract` after a validated cache fill, and by
 * the backfill script. Nothing here may fail an extraction: every error is
 * logged and swallowed. Tagging never calls a model (`deriveFacets`).
 */

export interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

type RecipeBody = { ingredients: readonly string[]; steps: readonly string[] };

/**
 * Tags a model already gave this recipe body (an extraction, or a share's
 * moderation call), for the next copy of it: a remix or a re-share.
 */
export async function knownFacets(store: Store, recipe: RecipeBody): Promise<RecipeFacets | null> {
  try {
    return (await store.getJson<RecipeFacets>(facetsCacheKey(recipe))) ?? null;
  } catch {
    return null;
  }
}

/** Stores a model's tags for this recipe body. */
export async function rememberFacets(store: Store, recipe: RecipeBody, facets: RecipeFacets): Promise<void> {
  try {
    await store.setJson(facetsCacheKey(recipe), facets, AI_CACHE_TTL_SECONDS);
  } catch {
    // the cache is an optimisation
  }
}

export interface DiscoverIndexer {
  /**
   * Indexes one extraction. `creator` is the scraper's owner username, when
   * known. Resolves to whether a row was written; never rejects.
   */
  index(
    canonical: string,
    recipe: ExtractedRecipe,
    creator?: string,
    log?: Logger,
    /** Tags the extraction's own model call returned, if any. */
    facets?: RecipeFacets | null,
    /** The page's own stated total time (JSON-LD), which beats an estimate. */
    statedMinutes?: number | null,
  ): Promise<boolean>;
  /**
   * Tags up to `limit` rows written before tagging moved to rules. No model
   * call. Returns how many were tagged.
   */
  sweep(limit: number, log?: Logger): Promise<number>;
}

export interface IndexerDeps {
  db: DiscoverDb;
  rehoster: ImageRehoster;
  store: Store;
}

export function createDiscoverIndexer(deps: IndexerDeps): DiscoverIndexer {
  const { db } = deps;

  return {
    async index(canonical, recipe, creator, log, facets, statedMinutes) {
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

        // Tagged from the extraction's own answer, else from a copy a model
        // already tagged, else by the word lists alone.
        const row = await db.getByKey(canonical);
        if (row && !row.classified_at) {
          let model = facets ?? null;
          if (model) {
            await countAi(deps.store, 'facetsFromExtraction');
            await rememberFacets(deps.store, recipe, model);
          } else {
            model = await knownFacets(deps.store, recipe);
            await countAi(deps.store, model ? 'facetsCacheHit' : 'facetsFromRules');
          }
          await db.setFacets(canonical, deriveFacets(recipe, model, statedMinutes));
        }
        return true;
      } catch (error) {
        log?.warn({ err: (error as Error).message, canonical }, 'discover: indexing failed');
        return false;
      }
    },

    async sweep(limit, log) {
      if (!db.configured) return 0;
      let tagged = 0;
      try {
        for (const row of await db.unclassified(limit)) {
          const model = await knownFacets(deps.store, row.recipe);
          await db.setFacets(row.canonical_key, deriveFacets(row.recipe, model));
          tagged++;
        }
      } catch (error) {
        log?.warn({ err: (error as Error).message }, 'discover: sweep failed');
      }
      return tagged;
    },
  };
}
