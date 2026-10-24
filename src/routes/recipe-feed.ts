import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { CommunityDb } from '../lib/community-db.js';
import {
  asBody,
  asQuery,
  cleanDisplayName,
  cleanText,
  createCommunityIdentity,
  offsetOf,
  REPORT_REASONS,
  requireUuid,
} from '../lib/community-kit.js';
import { ingredientsHash, recipeBodyHash } from '../lib/ai-cache.js';
import { countAi } from '../lib/ai-stats.js';
import type { DiscoverDb } from '../lib/discover-db.js';
import { knownFacets, rememberFacets } from '../lib/discover-indexer.js';
import { deriveFacets } from '../lib/facet-rules.js';
import { badRequest, HttpError, rateLimited } from '../lib/errors.js';
import {
  facetColumns,
  facetDto,
  hasFilters,
  parseFilters,
  storedFacets,
  type RecipeFacets,
} from '../lib/recipe-facets.js';
import type {
  FeedCommentRow,
  FeedPlatform,
  FeedPostRow,
  FeedSort,
  RecipeFeedDb,
  SharedRecipe,
} from '../lib/recipe-feed-db.js';
import { cachedSnapshot, invalidateSnapshots } from '../lib/snapshot-cache.js';
import type { Store } from '../lib/store.js';
import { CATEGORIES, type Category } from '../lib/types.js';
import { canonicalCacheKey, publicShareUrl } from '../lib/url.js';
import {
  localCheck,
  recipeBodyCheck,
  type ContentModerator,
  type ModerationImage,
  type ModerationKind,
} from '../services/moderation.js';
import { MAX_IMAGE_BYTES, sniffImageType, type ImageRehoster, type UploadedImage } from '../services/rehost.js';

/**
 * The community recipe feed: people share recipes from their library, others
 * save them, remix them (a new post linked with `remix_of`) and suggest
 * improvements (comments the post's author can mark "applied").
 *
 * **Not a social network.** No follows, no profiles, no per-person pages. A
 * post shows the display name the person set in Profile (moderated with the
 * post), or a stable "Cook XXXX" handle when they never set one. `author_hash`
 * never leaves the server; responses carry `isMine` / `isAuthor` instead.
 *
 * **Moderation** follows the ideas board (`routes/community.ts`): local checks,
 * then the AI moderator with the recipe-feed prompt. A post fails closed when
 * the AI check can't run; a suggestion goes through flagged `needs_review`.
 * Three distinct reports hide anything. Bans and blocks are shared with the
 * board, so one ban covers every community surface.
 *
 * **Credit.** A recipe that came from a link keeps a cleaned link to it
 * (`publicShareUrl`: no share ids, no private-looking query strings).
 *
 * **Photos.** Only a photo the app uploads with the post (moderated with it)
 * or a copied Instagram/TikTok thumbnail is published - both from our own
 * bucket. Any other image URL is dropped and the app shows a placeholder, so
 * viewing the feed never makes a phone call a host someone else chose.
 */

/** Largest request body for share / re-share: a base64 photo plus the recipe. */
export const FEED_BODY_LIMIT = 8 * 1024 * 1024;

export interface RecipeFeedOptions {
  db: RecipeFeedDb;
  store: Store;
  /** Discover's index: a share of a recipe we extracted reuses its checks and tags. */
  discoverDb?: DiscoverDb;
  /** Bans and blocks (shared tables). */
  communityDb: CommunityDb;
  moderator?: ContentModerator;
  rehoster: ImageRehoster;
  hashPepper: string;
}

export const FEED_LIMITS = {
  titleMax: 120,
  noteMax: 500,
  commentMax: 500,
  reportNoteMax: 500,
  ingredientsMax: 80,
  ingredientMax: 300,
  stepsMax: 60,
  stepMax: 1500,
  pageSize: 20,
  remixPreview: 10,
} as const;

export const FEED_DAILY_CAPS = {
  post: 5,
  update: 20,
  comment: 30,
  save: 100,
  applied: 100,
  report: 20,
  block: 20,
} as const;
type FeedWrite = keyof typeof FEED_DAILY_CAPS;

const SORTS: FeedSort[] = ['new', 'popular', 'most_remixed'];
/** Shared first-page snapshots, one per sort. Dropped when a post changes. */
const LIST_SNAPSHOT_KEYS = SORTS.map((sort) => `feed:list:${sort}`);
const PLATFORMS: FeedPlatform[] = ['instagram', 'tiktok', 'web', 'manual'];

// --- DTOs ---------------------------------------------------------------------

export interface FeedPostDto extends ReturnType<typeof facetDto> {
  id: string;
  imageUrl: string | null;
  authorName: string;
  isMine: boolean;
  note: string;
  sourcePlatform: FeedPlatform;
  remixOf: string | null;
  saveCount: number;
  remixCount: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FeedCommentDto {
  id: string;
  body: string;
  authorName: string;
  isMine: boolean;
  /** Written by the post's author. */
  isAuthor: boolean;
  applied: boolean;
  createdAt: string;
}

// --- input ------------------------------------------------------------------

function numberIn(raw: unknown, min: number, max: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : 0;
}

function lines(raw: unknown, maxItems: number, maxLength: number, what: string): string[] {
  if (!Array.isArray(raw)) throw badRequest(`The recipe needs ${what}.`);
  const items = raw.map((line) => cleanText(line, { singleLine: false })).filter(Boolean);
  if (items.length === 0) throw badRequest(`The recipe needs ${what}.`);
  if (items.length > maxItems) throw badRequest(`A recipe can have at most ${maxItems} ${what}.`);
  if (items.some((line) => line.length > maxLength)) throw badRequest(`One of the ${what} is too long.`);
  return items;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The photo uploaded with a share (`{ mimeType, data }`, base64). The bytes'
 * own signature decides the type; the claimed mimeType is ignored. Absent =
 * null; present but unusable = 400, so the person learns the photo was
 * refused instead of it silently vanishing.
 */
function parseUpload(raw: unknown): UploadedImage | null {
  if (raw == null) return null;
  const data = (raw as { data?: unknown }).data;
  if (typeof data !== 'string' || data.length === 0 || data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) {
    throw badRequest('That photo is too large to share.');
  }
  if (!BASE64.test(data)) throw badRequest('That photo could not be read.');
  const bytes = Buffer.from(data, 'base64');
  const mimeType = sniffImageType(bytes);
  if (!mimeType) throw badRequest('Photos must be JPEG, PNG or WebP.');
  return { bytes, mimeType };
}

/** Validates the recipe someone is sharing. Returns it plus the photo to keep. */
function parseRecipe(raw: unknown): { recipe: SharedRecipe; imageUrl: string | null } {
  if (!raw || typeof raw !== 'object') throw badRequest('Missing recipe.');
  const value = raw as Record<string, unknown>;

  const title = cleanText(value.title, { singleLine: true });
  if (title.length < 1 || title.length > FEED_LIMITS.titleMax) {
    throw badRequest(`Titles need 1-${FEED_LIMITS.titleMax} characters.`);
  }
  if (!(CATEGORIES as readonly string[]).includes(value.category as string)) {
    throw badRequest('Unknown category.');
  }
  const platform = PLATFORMS.includes(value.sourcePlatform as FeedPlatform)
    ? (value.sourcePlatform as FeedPlatform)
    : 'manual';
  const macros = (value.macros && typeof value.macros === 'object' ? value.macros : {}) as Record<string, unknown>;
  const servings =
    typeof value.servings === 'number' && Number.isInteger(value.servings) && value.servings >= 1 && value.servings <= 100
      ? value.servings
      : undefined;

  let sourceUrl: string | undefined;
  if (platform !== 'manual' && typeof value.sourceUrl === 'string' && value.sourceUrl.length <= 2000) {
    try {
      const parsed = new URL(value.sourceUrl);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        sourceUrl = publicShareUrl(parsed.toString(), platform) ?? undefined;
      }
    } catch {
      // An unparseable link is dropped, not fatal.
    }
  }

  const imageUrl =
    typeof value.imageRemoteUrl === 'string' && value.imageRemoteUrl.startsWith('https://') && value.imageRemoteUrl.length <= 2000
      ? value.imageRemoteUrl
      : null;

  return {
    recipe: {
      title,
      category: value.category as Category,
      servings,
      ingredients: lines(value.ingredients, FEED_LIMITS.ingredientsMax, FEED_LIMITS.ingredientMax, 'ingredients'),
      steps: lines(value.steps, FEED_LIMITS.stepsMax, FEED_LIMITS.stepMax, 'steps'),
      macros: {
        calories: Math.round(numberIn(macros.calories, 0, 9999)),
        protein: Math.round(numberIn(macros.protein, 0, 9999)),
        carbs: Math.round(numberIn(macros.carbs, 0, 9999)),
        fat: Math.round(numberIn(macros.fat, 0, 9999)),
      },
      macrosSource: value.macrosSource === 'caption' ? 'caption' : 'estimated',
      sourcePlatform: platform,
      sourceUrl,
    },
    imageUrl,
  };
}

const rejected = () => new HttpError(422, 'content_rejected', "This doesn't meet our community rules.");
const notFound = () => new HttpError(404, 'not_found', 'This recipe is no longer available.');
const commentNotFound = () => new HttpError(404, 'not_found', 'This suggestion is no longer available.');

export function registerRecipeFeedRoutes(app: FastifyInstance, deps: RecipeFeedOptions): void {
  const { db, communityDb, store, moderator } = deps;
  const { callerOf, handleOf } = createCommunityIdentity(deps.hashPepper);

  const nameOf = (row: { author_hash: string; author_name: string | null }) =>
    row.author_name ?? handleOf(row.author_hash);

  function toPostDto(row: FeedPostRow, me: string | null): FeedPostDto {
    return {
      id: row.id,
      ...facetDto(row),
      imageUrl: row.image_url,
      authorName: nameOf(row),
      isMine: me !== null && row.author_hash === me,
      note: row.note,
      sourcePlatform: row.source_platform,
      remixOf: row.remix_of,
      saveCount: row.save_count,
      remixCount: row.remix_count,
      commentCount: row.comment_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function toCommentDto(row: FeedCommentRow, post: FeedPostRow, me: string | null): FeedCommentDto {
    return {
      id: row.id,
      body: row.body,
      authorName: nameOf(row),
      isMine: me !== null && row.author_hash === me,
      isAuthor: row.author_hash === post.author_hash,
      applied: row.applied,
      createdAt: row.created_at,
    };
  }

  function ensureConfigured(): void {
    if (!db.configured) {
      throw new HttpError(503, 'feed_unavailable', 'Community recipes are unavailable right now.');
    }
  }

  async function writer(request: FastifyRequest, kind: FeedWrite): Promise<string> {
    ensureConfigured();
    const me = callerOf(request);
    if (!me) throw new HttpError(400, 'device_required', 'Update the app to join the community.');
    if (communityDb.configured && (await communityDb.isBanned(me))) {
      throw new HttpError(403, 'banned', "You can't post to the community.");
    }
    const day = new Date().toISOString().slice(0, 10);
    const count = await store.incrWithTtl(`feed:${kind}:${me}:${day}`, 26 * 60 * 60);
    if (count > FEED_DAILY_CAPS[kind]) {
      throw rateLimited("You've reached today's limit. Try again tomorrow.");
    }
    return me;
  }

  const blockedBy = async (me: string | null): Promise<string[]> =>
    me && communityDb.configured ? communityDb.blockedBy(me) : [];

  /**
   * Local checks, then the AI moderator. `typed` is what the person wrote
   * themselves (full `localCheck`); `body` is recipe content (relaxed check).
   *
   * `bodyKnown`: this exact body is already public (our own extraction in
   * Discover, or a visible post it was copied from), so the model only sees
   * what is new - the typed text and the photo. `wantFacets`: the model also
   * tags the body in the same request (better than the word lists alone).
   */
  async function screen(
    typed: string,
    body: string,
    kind: Extract<ModerationKind, 'recipe' | 'suggestion'>,
    request: FastifyRequest,
    options: { image?: ModerationImage; bodyKnown?: boolean; wantFacets?: boolean } = {},
  ): Promise<{ needsReview: boolean; facets: RecipeFacets | null }> {
    for (const verdict of [localCheck(typed), recipeBodyCheck(body)]) {
      if (!verdict.allowed) {
        request.log.info({ category: verdict.category, kind }, 'feed: rejected by local check');
        throw rejected();
      }
    }
    if (!moderator) return { needsReview: false, facets: null };
    const judgeBody = Boolean(body) && !options.bodyKnown;
    if (body && options.bodyKnown) await countAi(store, 'moderateBodySkipped');
    try {
      const verdict = await moderator.review(judgeBody ? `${typed}\n\n${body}` : typed, kind, options.image, {
        facets: judgeBody && options.wantFacets,
      });
      if (!verdict.allowed) {
        request.log.info({ category: verdict.category, kind }, 'feed: rejected by moderator');
        throw rejected();
      }
      return { needsReview: false, facets: verdict.facets ?? null };
    } catch (error) {
      if (error instanceof HttpError && error.code === 'content_rejected') throw error;
      request.log.warn({ err: error, kind }, 'feed: moderation unavailable');
      if (kind === 'recipe') {
        throw new HttpError(503, 'moderation_unavailable', "We couldn't check your recipe right now. Please try again shortly.");
      }
      return { needsReview: true, facets: null };
    }
  }

  /**
   * Public copies of a shared recipe that the server already trusts: its
   * Discover row (when it came from a link we extracted), the post it remixes,
   * and the post being re-shared. Hidden, removed or under-review copies don't
   * count - their content is exactly what can't be vouched for.
   */
  async function knownCopies(
    recipe: SharedRecipe,
    related: (FeedPostRow | null)[],
  ): Promise<{ recipe: { ingredients: string[]; steps: string[] }; facets: RecipeFacets | null }[]> {
    const copies: { recipe: { ingredients: string[]; steps: string[] }; facets: RecipeFacets | null }[] = [];
    for (const post of related) {
      if (post && !post.hidden && !post.removed && !post.needs_review) copies.push({ recipe: post.recipe, facets: storedFacets(post) });
    }
    if (deps.discoverDb?.configured && recipe.sourceUrl && recipe.sourcePlatform !== 'manual') {
      try {
        const row = await deps.discoverDb.getByKey(canonicalCacheKey(recipe.sourceUrl, recipe.sourcePlatform));
        if (row && !row.hidden) copies.push({ recipe: row.recipe, facets: storedFacets(row) });
      } catch (error) {
        void error; // a lookup miss only means the full check runs
      }
    }
    return copies;
  }

  async function visiblePost(id: string, me: string | null): Promise<FeedPostRow> {
    const post = await db.get(id);
    if (!post || post.hidden || post.removed) throw notFound();
    if ((await blockedBy(me)).includes(post.author_hash)) throw notFound();
    return post;
  }

  /** Parses + screens + enriches a share/re-share body into the stored columns. */
  async function prepare(request: FastifyRequest) {
    const body = asBody(request);
    const { recipe, imageUrl } = parseRecipe(body.recipe);
    const note = cleanText(body.note, { singleLine: false });
    if (note.length > FEED_LIMITS.noteMax) throw badRequest(`Notes can be at most ${FEED_LIMITS.noteMax} characters.`);
    const authorName = cleanDisplayName(body.authorName);
    const upload = parseUpload(body.image);
    return { body, recipe, imageUrl, upload, note, authorName };
  }

  async function enrich(
    request: FastifyRequest,
    input: Awaited<ReturnType<typeof prepare>>,
    related: (FeedPostRow | null)[] = [],
  ) {
    const { recipe, imageUrl, upload, note, authorName } = input;
    const typed = [authorName ? `Display name: ${authorName}` : '', `Title: ${recipe.title}`, note ? `Note: ${note}` : '']
      .filter(Boolean)
      .join('\n');
    const content = [...recipe.ingredients, ...recipe.steps].join('\n');

    // Reuse what is already known about this body: an identical public copy
    // vouches for the body and carries its tags; a remix with the same
    // ingredients keeps the original's tags; failing those, the shared tag
    // cache, and failing that the moderation call tags it on the side.
    const copies = await knownCopies(recipe, related);
    const bodyHash = recipeBodyHash(recipe);
    const sameBody = copies.filter((copy) => recipeBodyHash(copy.recipe) === bodyHash);
    let facets =
      sameBody.find((copy) => copy.facets)?.facets ??
      copies.find((copy) => copy.facets && ingredientsHash(copy.recipe) === ingredientsHash(recipe))?.facets ??
      (await knownFacets(store, recipe));
    if (facets) await countAi(store, 'facetsReused');

    const verdict = await screen(typed, content, 'recipe', request, {
      image: upload ? { mimeType: upload.mimeType, data: upload.bytes.toString('base64') } : undefined,
      bodyKnown: sameBody.length > 0,
      wantFacets: !facets,
    });
    if (!facets && verdict.facets) {
      facets = verdict.facets;
      await rememberFacets(store, recipe, verdict.facets);
    }
    // Still no model answer (moderation unavailable, or a vouched-for body
    // with no stored tags): the word lists decide on their own.
    if (!facets) await countAi(store, 'facetsFromRules');

    // Their own (moderated) photo first, else a copied Instagram/TikTok
    // thumbnail, else none - the app draws a placeholder.
    const image = upload ? await deps.rehoster.storeUpload(upload) : await deps.rehoster.rehost(imageUrl);

    return {
      author_name: authorName,
      note,
      image_url: image,
      source_url: recipe.sourceUrl ?? null,
      source_platform: recipe.sourcePlatform,
      servings: recipe.servings ?? null,
      recipe,
      needs_review: verdict.needsReview,
      ...facetColumns(recipe, deriveFacets(recipe, facets)),
    };
  }

  // --- reads ------------------------------------------------------------------

  app.get('/community/recipes', async (request) => {
    ensureConfigured();
    const query = asQuery(request);
    const sort = SORTS.includes(query.sort as FeedSort) ? (query.sort as FeedSort) : 'new';
    const offset = offsetOf(query.cursor);
    const me = callerOf(request);
    const filters = parseFilters(query);
    const blocked = await blockedBy(me);
    const list = (excludeAuthors: string[]): Promise<FeedPostRow[]> =>
      db.list({ filters, sort, offset, limit: FEED_LIMITS.pageSize + 1, excludeAuthors });
    // The default first page is the same rows for every caller; only `isMine`
    // and the caller's blocks differ, so the shared snapshot holds raw rows and
    // both are applied per request. Searches and filters stay live.
    const rows =
      offset === 0 && !hasFilters(filters)
        ? (
            await cachedSnapshot({
              store,
              key: `feed:list:${sort}`,
              refresh: () => list([]),
              warn: (message) => request.log.warn(message),
            })
          ).filter((row) => !blocked.includes(row.author_hash))
        : await list(blocked);
    const page = rows.slice(0, FEED_LIMITS.pageSize);
    return {
      posts: page.map((row) => toPostDto(row, me)),
      nextCursor: rows.length > page.length ? String(offset + page.length) : null,
    };
  });

  app.get('/community/recipes/:id', async (request) => {
    ensureConfigured();
    const id = requireUuid((request.params as { id?: string }).id, 'recipe');
    const me = callerOf(request);
    const post = await visiblePost(id, me);
    const blocked = await blockedBy(me);

    const [parent, remixes, comments] = await Promise.all([
      post.remix_of ? db.get(post.remix_of) : Promise.resolve(null),
      db.remixesOf(id, FEED_LIMITS.remixPreview),
      db.listComments(id),
    ]);
    const parentVisible = parent && !parent.hidden && !parent.removed && !blocked.includes(parent.author_hash);

    return {
      post: {
        ...toPostDto(post, me),
        servings: post.servings,
        ingredients: post.recipe.ingredients,
        steps: post.recipe.steps,
        macrosSource: post.recipe.macrosSource,
        sourceUrl: post.source_url,
      },
      remixOf: parentVisible ? { id: parent.id, title: parent.title, authorName: nameOf(parent) } : null,
      remixes: remixes.filter((r) => !blocked.includes(r.author_hash)).map((r) => toPostDto(r, me)),
      comments: comments.filter((c) => !blocked.includes(c.author_hash)).map((c) => toCommentDto(c, post, me)),
    };
  });

  // --- writes -----------------------------------------------------------------

  app.post('/community/recipes', { bodyLimit: FEED_BODY_LIMIT }, async (request, reply) => {
    const input = await prepare(request);
    const remixOf = input.body.remixOf == null ? null : requireUuid(input.body.remixOf, 'original recipe');
    const me = await writer(request, 'post');
    const parent = remixOf ? await visiblePost(remixOf, me) : null;

    const columns = await enrich(request, input, [parent]);
    const row = await db.insert({ ...columns, author_hash: me, remix_of: remixOf });
    await invalidateSnapshots(store, LIST_SNAPSHOT_KEYS);
    request.log.info({ postId: row.id, remixOf }, 'feed: recipe shared');
    return reply.status(201).send({ post: toPostDto(row, me) });
  });

  app.put('/community/recipes/:id', { bodyLimit: FEED_BODY_LIMIT }, async (request) => {
    const id = requireUuid((request.params as { id?: string }).id, 'recipe');
    const input = await prepare(request);
    const me = await writer(request, 'update');
    const post = await db.get(id);
    // Same answer for "not yours" and "doesn't exist": no ownership oracle.
    if (!post || post.author_hash !== me || post.removed) throw notFound();

    const columns = await enrich(request, input, [post]);
    // A re-share without a new photo keeps the one already published.
    const row = await db.update(id, { ...columns, image_url: columns.image_url ?? post.image_url });
    if (!row) throw notFound();
    await invalidateSnapshots(store, LIST_SNAPSHOT_KEYS);
    return { post: toPostDto(row, me) };
  });

  app.delete('/community/recipes/:id', async (request) => {
    ensureConfigured();
    const id = requireUuid((request.params as { id?: string }).id, 'recipe');
    const me = callerOf(request);
    const post = await db.get(id);
    if (!post || !me || post.author_hash !== me || post.removed) throw notFound();
    await db.remove(id);
    await invalidateSnapshots(store, LIST_SNAPSHOT_KEYS);
    return { deleted: true };
  });

  app.post('/community/recipes/:id/save', async (request) => {
    const id = requireUuid((request.params as { id?: string }).id, 'recipe');
    const me = await writer(request, 'save');
    const post = await visiblePost(id, me);
    if (post.author_hash !== me) await db.recordSave(id, me);
    const { recipe } = post;
    return {
      recipe: {
        sourceUrl: post.source_url ?? '',
        sourcePlatform: recipe.sourcePlatform,
        title: recipe.title,
        imageRemoteUrl: post.image_url ?? undefined,
        category: recipe.category,
        servings: recipe.servings,
        ingredients: recipe.ingredients,
        steps: recipe.steps,
        macros: recipe.macros,
        macrosSource: recipe.macrosSource,
      },
    };
  });

  app.post('/community/recipes/:id/comments', async (request, reply) => {
    const id = requireUuid((request.params as { id?: string }).id, 'recipe');
    const body = asBody(request);
    const text = cleanText(body.body, { singleLine: false });
    if (text.length < 1 || text.length > FEED_LIMITS.commentMax) {
      throw badRequest(`Suggestions need 1-${FEED_LIMITS.commentMax} characters.`);
    }
    const authorName = cleanDisplayName(body.authorName);
    const me = await writer(request, 'comment');
    const post = await visiblePost(id, me);
    const typed = authorName ? `Display name: ${authorName}\n${text}` : text;
    const { needsReview } = await screen(typed, '', 'suggestion', request);
    const row = await db.insertComment({
      post_id: id,
      author_hash: me,
      author_name: authorName,
      body: text,
      needs_review: needsReview,
    });
    return reply.status(201).send({ comment: toCommentDto(row, post, me) });
  });

  app.delete('/community/recipes/comments/:id', async (request) => {
    ensureConfigured();
    const id = requireUuid((request.params as { id?: string }).id, 'suggestion');
    const me = callerOf(request);
    const comment = await db.getComment(id);
    if (!comment || !me || comment.author_hash !== me || comment.removed) throw commentNotFound();
    await db.removeComment(id);
    return { deleted: true };
  });

  app.post('/community/recipes/comments/:id/applied', async (request) => {
    const id = requireUuid((request.params as { id?: string }).id, 'suggestion');
    const applied = asBody(request).applied;
    if (typeof applied !== 'boolean') throw badRequest('applied must be true or false.');
    const me = await writer(request, 'applied');
    const comment = await db.getComment(id);
    if (!comment || comment.hidden || comment.removed) throw commentNotFound();
    const post = await db.get(comment.post_id);
    // Only the recipe's author decides what they applied.
    if (!post || post.author_hash !== me || post.removed) throw commentNotFound();
    await db.setApplied(id, applied);
    return { applied };
  });

  /** Author of a post or suggestion, or 404. Hidden items stay reportable/blockable. */
  async function authorOf(targetType: 'recipe' | 'suggestion', targetId: string): Promise<string> {
    const target = targetType === 'recipe' ? await db.get(targetId) : await db.getComment(targetId);
    if (!target) throw notFound();
    return target.author_hash;
  }

  function parseTarget(body: Record<string, unknown>) {
    const targetType = body.targetType;
    if (targetType !== 'recipe' && targetType !== 'suggestion') throw badRequest('Unknown target type.');
    return { targetType, targetId: requireUuid(body.targetId, targetType) } as const;
  }

  app.post('/community/recipes/reports', async (request) => {
    const body = asBody(request);
    const { targetType, targetId } = parseTarget(body);
    const reason = body.reason;
    if (typeof reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(reason)) {
      throw badRequest('Pick a reason for the report.');
    }
    const note = cleanText(body.note, { singleLine: false });
    if (note.length > FEED_LIMITS.reportNoteMax) {
      throw badRequest(`Notes can be at most ${FEED_LIMITS.reportNoteMax} characters.`);
    }
    const me = await writer(request, 'report');
    const author = await authorOf(targetType, targetId);
    if (author === me) throw badRequest("You can't report your own post.");
    const outcome = await db.insertReport({
      target_type: targetType === 'recipe' ? 'recipe_post' : 'recipe_comment',
      target_id: targetId,
      reporter_hash: me,
      reason,
      note: note || null,
    });
    request.log.info({ targetType, targetId, reason, outcome }, 'feed: report');
    return { reported: true };
  });

  app.post('/community/recipes/blocks', async (request) => {
    const { targetType, targetId } = parseTarget(asBody(request));
    const me = await writer(request, 'block');
    if (!communityDb.configured) throw new HttpError(503, 'feed_unavailable', 'Blocking is unavailable right now.');
    const author = await authorOf(targetType, targetId);
    if (author === me) throw badRequest("You can't hide your own posts.");
    await communityDb.insertBlock(me, author);
    return { blocked: true };
  });
}
