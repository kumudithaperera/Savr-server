import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { CommunityDb } from '../lib/community-db.js';
import {
  asBody,
  asQuery,
  cleanText,
  createCommunityIdentity,
  offsetOf,
  REPORT_REASONS,
  requireUuid,
} from '../lib/community-kit.js';
import type { DiscoverDb, DiscoverSort, IndexListRow, IndexRow } from '../lib/discover-db.js';
import { badRequest, HttpError, rateLimited } from '../lib/errors.js';
import { facetDto, hasFilters, parseFilters } from '../lib/recipe-facets.js';
import { cachedSnapshot } from '../lib/snapshot-cache.js';
import type { Store } from '../lib/store.js';
import type { ExtractedRecipe } from '../lib/types.js';

/**
 * Discover: search every recipe Morsel has already extracted for anyone.
 *
 * **Preview, then save.** Search and detail return a preview - title, photo
 * (only when it's our own copy; otherwise the app shows a placeholder),
 * macros, tags, ingredient list and a credit link to the original post - but
 * never the steps. The full recipe is only handed out by `POST .../save`, which
 * the app calls when someone adds it to their library. That keeps Discover a
 * way to find and credit recipes, not a mirror of other people's content, and
 * makes every hand-out a counted, capped event.
 *
 * **Free.** A save costs no AI call and no quota: the recipe was extracted
 * already. The per-device daily cap below is what stops a script from walking
 * the whole index.
 *
 * Identity, bans and reports work exactly as on the community board.
 */

export interface DiscoverOptions {
  db: DiscoverDb;
  /** For bans (shared with the ideas board). */
  communityDb: CommunityDb;
  store: Store;
  hashPepper: string;
}

export const DISCOVER_LIMITS = { pageSize: 20, noteMax: 500 } as const;
export const DISCOVER_DAILY_CAPS = { save: 50, report: 20 } as const;

const SORTS: DiscoverSort[] = ['popular', 'new'];

export interface DiscoverItemDto extends ReturnType<typeof facetDto> {
  id: string;
  imageUrl: string | null;
  sourcePlatform: IndexRow['source_platform'];
  sourceUrl: string;
  /** "@username" for social posts, the site's host for web pages. */
  creator: string;
  servings: number | null;
  saveCount: number;
}

function creatorOf(row: Pick<IndexRow, 'creator' | 'source_url' | 'source_platform'>): string {
  if (row.creator) return row.creator;
  // A social post whose author we don't know (backfilled entries) is credited to the platform.
  if (row.source_platform === 'instagram') return 'Instagram';
  if (row.source_platform === 'tiktok') return 'TikTok';
  try {
    return new URL(row.source_url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function toItemDto(row: IndexListRow | IndexRow): DiscoverItemDto {
  return {
    id: row.id,
    ...facetDto(row),
    imageUrl: row.image_url,
    sourcePlatform: row.source_platform,
    sourceUrl: row.source_url,
    creator: creatorOf(row),
    servings: row.servings,
    saveCount: row.save_count,
  };
}

const notFound = () => new HttpError(404, 'not_found', 'This recipe is no longer available.');

export function registerDiscoverRoutes(app: FastifyInstance, deps: DiscoverOptions): void {
  const { db, communityDb, store } = deps;
  const { callerOf } = createCommunityIdentity(deps.hashPepper);

  function ensureConfigured(): void {
    if (!db.configured) {
      throw new HttpError(503, 'discover_unavailable', 'Discover is unavailable right now.');
    }
  }

  async function actor(request: FastifyRequest, kind: keyof typeof DISCOVER_DAILY_CAPS): Promise<string> {
    ensureConfigured();
    const me = callerOf(request);
    if (!me) throw new HttpError(400, 'device_required', 'Update the app to use Discover.');
    if (communityDb.configured && (await communityDb.isBanned(me))) {
      throw new HttpError(403, 'banned', "You can't use Discover.");
    }
    const day = new Date().toISOString().slice(0, 10);
    const count = await store.incrWithTtl(`discover:${kind}:${me}:${day}`, 26 * 60 * 60);
    if (count > DISCOVER_DAILY_CAPS[kind]) {
      throw rateLimited("You've reached today's limit. Try again tomorrow.");
    }
    return me;
  }

  async function visible(id: string): Promise<IndexRow> {
    const row = await db.getById(id);
    if (!row || row.hidden) throw notFound();
    return row;
  }

  app.get('/discover/search', async (request) => {
    ensureConfigured();
    const query = asQuery(request);
    const sort = SORTS.includes(query.sort as DiscoverSort) ? (query.sort as DiscoverSort) : 'popular';
    const offset = offsetOf(query.cursor);
    const filters = parseFilters(query);
    const search = (): Promise<IndexListRow[]> =>
      db.search({ filters, sort, offset, limit: DISCOVER_LIMITS.pageSize + 1 });
    // The first page of an unfiltered sort is identical for every caller and is
    // what almost every visit asks for, so it comes from a shared snapshot
    // instead of a Supabase query per device. Searches and filters stay live.
    const rows =
      offset === 0 && !hasFilters(filters)
        ? await cachedSnapshot({
            store,
            key: `discover:search:${sort}`,
            refresh: search,
            warn: (message) => request.log.warn(message),
          })
        : await search();
    const page = rows.slice(0, DISCOVER_LIMITS.pageSize);
    return {
      items: page.map(toItemDto),
      nextCursor: rows.length > page.length ? String(offset + page.length) : null,
    };
  });

  app.get('/discover/items/:id', async (request) => {
    ensureConfigured();
    const row = await visible(requireUuid((request.params as { id?: string }).id, 'recipe'));
    // Ingredients yes (that's how people judge a recipe), steps no.
    return { item: { ...toItemDto(row), ingredients: row.ingredients } };
  });

  app.post('/discover/items/:id/save', async (request) => {
    const id = requireUuid((request.params as { id?: string }).id, 'recipe');
    const me = await actor(request, 'save');
    const row = await visible(id);
    await db.recordSave(id, me);
    const recipe: ExtractedRecipe = {
      ...row.recipe,
      sourceUrl: row.source_url,
      // Our copy when there is one; otherwise the page's own photo, which the
      // app downloads once, now that the person chose to save this recipe.
      imageRemoteUrl: row.image_url ?? row.recipe.imageRemoteUrl,
    };
    return { recipe };
  });

  app.post('/discover/reports', async (request) => {
    const body = asBody(request);
    const targetId = requireUuid(body.targetId, 'recipe');
    const reason = body.reason;
    if (typeof reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(reason)) {
      throw badRequest('Pick a reason for the report.');
    }
    const note = cleanText(body.note, { singleLine: false });
    if (note.length > DISCOVER_LIMITS.noteMax) {
      throw badRequest(`Notes can be at most ${DISCOVER_LIMITS.noteMax} characters.`);
    }
    const me = await actor(request, 'report');
    const row = await db.getById(targetId);
    if (!row) throw notFound();
    const outcome = await db.insertReport({ target_id: targetId, reporter_hash: me, reason, note: note || null });
    request.log.info({ targetId, reason, outcome }, 'discover: report');
    return { reported: true };
  });
}
