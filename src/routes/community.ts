import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  CommentRow,
  CommunityDb,
  PostRow,
  PostStatus,
  ReportReason,
  TargetType,
} from '../lib/community-db.js';
import { TEAM_AUTHOR_HASH } from '../lib/community-seed.js';
import { asBody, cleanText, createCommunityIdentity, requireUuid } from '../lib/community-kit.js';
import { badRequest, HttpError, rateLimited } from '../lib/errors.js';
import type { Store } from '../lib/store.js';
import { localCheck, type ContentModerator } from '../services/moderation.js';

/**
 * The community ideas board: anonymous feature requests, votes, comments,
 * reports and blocks.
 *
 * **Identity.** There are no accounts. The caller is the hashed install id the
 * app already sends (`x-morsel-device-id`, see `lib/grants.ts`), hashed again
 * here with a server-only pepper into `author_hash`. That value is stored on
 * every row so an admin can trace and ban a device, and it is **never** put in
 * a response: the app gets `isMine` and per-thread labels ("op", "cook #2")
 * computed for the caller instead. A thread label is only stable within one
 * idea, so nobody can follow an author across threads.
 *
 * **Moderation.** Every post and comment passes `localCheck` and then the AI
 * moderator before it is stored. If the AI check can't run, a *post* is refused
 * (503) - an idea is the board's headline content - while a *comment* goes
 * through flagged `needs_review`, because refusing all replies during a Gemini
 * blip is worse than an admin skimming a few afterwards. Three distinct reports
 * hide anything that slipped through (`REPORT_HIDE_THRESHOLD`).
 *
 * **Abuse.** `/community/` is behind the app key and per-IP limit in
 * `guardrail.ts`; writes additionally get a per-device daily cap here. The
 * device id is client-supplied and therefore forgeable - Play Integrity / App
 * Attest is the real fix (MORSE-41) - but for a feature board that is enough.
 */

export interface CommunityOptions {
  db: CommunityDb;
  store: Store;
  /** Absent = local checks only (tests, local dev without a Gemini key). */
  moderator?: ContentModerator;
  /** Server-only secret mixed into `author_hash`. */
  hashPepper: string;
}

export const COMMUNITY_LIMITS = {
  titleMin: 5,
  titleMax: 80,
  bodyMax: 1000,
  commentMax: 500,
  noteMax: 500,
  pageSize: 20,
} as const;

/** Per-device writes per UTC day. */
export const DAILY_WRITE_CAPS = { post: 5, comment: 30, vote: 200, report: 20, block: 20 } as const;
type WriteKind = keyof typeof DAILY_WRITE_CAPS;

const REPORT_REASONS: readonly ReportReason[] = [
  'spam',
  'offensive',
  'harassment',
  'personal_info',
  'off_topic',
  'other',
];

const TABS: Record<string, { statuses: PostStatus[]; sorts: ('top' | 'new' | 'shipped')[] }> = {
  ideas: { statuses: ['open'], sorts: ['top', 'new'] },
  planned: { statuses: ['planned', 'in_progress'], sorts: ['top', 'new'] },
  shipped: { statuses: ['shipped'], sorts: ['shipped'] },
};

// --- DTOs (the only shapes that leave the server) ----------------------------

export interface PostDto {
  id: string;
  title: string;
  body: string;
  status: Exclude<PostStatus, 'removed'>;
  shippedVersion: string | null;
  shippedAt: string | null;
  score: number;
  myVote: -1 | 0 | 1;
  commentCount: number;
  createdAt: string;
  isMine: boolean;
  /** Posted by the Morsel team (the seeded roadmap), shown with a "Morsel" tag. */
  isTeam: boolean;
}

export interface CommentDto {
  id: string;
  body: string;
  createdAt: string;
  isMine: boolean;
  /** `op` = the idea's author; otherwise a number stable within this thread only. */
  author: 'op' | number;
}

function toPostDto(row: PostRow, me: string | null, myVote: -1 | 0 | 1): PostDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status as PostDto['status'],
    shippedVersion: row.shipped_version,
    shippedAt: row.shipped_at,
    score: row.score,
    myVote,
    commentCount: row.comment_count,
    createdAt: row.created_at,
    isMine: me !== null && row.author_hash === me,
    isTeam: row.author_hash === TEAM_AUTHOR_HASH,
  };
}

/** Numbers commenters by first appearance; the idea's author is always `op`. */
function toCommentDtos(post: PostRow, rows: CommentRow[], me: string | null): CommentDto[] {
  const numbers = new Map<string, number>();
  return rows.map((row) => {
    let author: CommentDto['author'] = 'op';
    if (row.author_hash !== post.author_hash) {
      if (!numbers.has(row.author_hash)) numbers.set(row.author_hash, numbers.size + 1);
      author = numbers.get(row.author_hash)!;
    }
    return {
      id: row.id,
      body: row.body,
      createdAt: row.created_at,
      isMine: me !== null && row.author_hash === me,
      author,
    };
  });
}

const rejected = () =>
  new HttpError(422, 'content_rejected', "This doesn't meet our community rules.");
const notFound = () => new HttpError(404, 'not_found', 'This idea is no longer available.');

export function registerCommunityRoutes(app: FastifyInstance, deps: CommunityOptions): void {
  const { db, store, moderator } = deps;

  const { callerOf } = createCommunityIdentity(deps.hashPepper);

  function ensureConfigured(): void {
    if (!db.configured) {
      throw new HttpError(503, 'community_unavailable', 'The ideas board is unavailable right now.');
    }
  }

  /** Resolves a writer: needs a device id, must not be banned, must be under today's cap. */
  async function writer(request: FastifyRequest, kind: WriteKind): Promise<string> {
    ensureConfigured();
    const me = callerOf(request);
    if (!me) throw new HttpError(400, 'device_required', 'Update the app to join the conversation.');
    if (await db.isBanned(me)) {
      throw new HttpError(403, 'banned', "You can't post on the ideas board.");
    }
    const day = new Date().toISOString().slice(0, 10);
    const count = await store.incrWithTtl(`community:${kind}:${me}:${day}`, 26 * 60 * 60);
    if (count > DAILY_WRITE_CAPS[kind]) {
      throw rateLimited("You've reached today's limit. Try again tomorrow.");
    }
    return me;
  }

  /** Runs the screening. Returns whether the item must be flagged for review. */
  async function screen(text: string, kind: 'post' | 'comment', request: FastifyRequest): Promise<boolean> {
    const local = localCheck(text);
    if (!local.allowed) {
      request.log.info({ category: local.category, kind }, 'community: rejected by local check');
      throw rejected();
    }
    if (!moderator) return false;
    try {
      const verdict = await moderator.review(text, kind);
      if (!verdict.allowed) {
        request.log.info({ category: verdict.category, kind }, 'community: rejected by moderator');
        throw rejected();
      }
      return false;
    } catch (error) {
      if (error instanceof HttpError && error.code === 'content_rejected') throw error;
      request.log.warn({ err: error, kind }, 'community: moderation unavailable');
      if (kind === 'post') {
        throw new HttpError(503, 'moderation_unavailable', "We couldn't check your idea right now. Please try again shortly.");
      }
      return true;
    }
  }

  /** A post that exists and is visible to everyone. */
  async function visiblePost(id: string): Promise<PostRow> {
    const post = await db.getPost(id);
    if (!post || post.hidden || post.status === 'removed') throw notFound();
    return post;
  }

  // --- reads --------------------------------------------------------------

  app.get('/community/posts', async (request) => {
    ensureConfigured();
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const tab = TABS[query.tab ?? 'ideas'];
    if (!tab) throw badRequest('Unknown tab.');
    const sort = tab.sorts.includes(query.sort as never)
      ? (query.sort as 'top' | 'new' | 'shipped')
      : tab.sorts[0];
    const offset = Math.max(0, Math.min(10_000, Number.parseInt(query.cursor ?? '0', 10) || 0));

    const me = callerOf(request);
    const excludeAuthors = me ? await db.blockedBy(me) : [];
    const rows = await db.listPosts({
      statuses: tab.statuses,
      sort,
      offset,
      // One extra row tells us whether there is another page without a count query.
      limit: COMMUNITY_LIMITS.pageSize + 1,
      excludeAuthors,
    });
    const page = rows.slice(0, COMMUNITY_LIMITS.pageSize);
    const votes = me ? await db.votesBy(me, page.map((p) => p.id)) : new Map<string, 1 | -1>();

    return {
      posts: page.map((row) => toPostDto(row, me, votes.get(row.id) ?? 0)),
      nextCursor: rows.length > page.length ? String(offset + page.length) : null,
    };
  });

  app.get('/community/posts/:id', async (request) => {
    ensureConfigured();
    const id = requireUuid((request.params as { id?: string }).id, 'idea');
    const post = await visiblePost(id);
    const me = callerOf(request);

    const [comments, votes, blocked] = await Promise.all([
      db.listComments(id),
      me ? db.votesBy(me, [id]) : Promise.resolve(new Map<string, 1 | -1>()),
      me ? db.blockedBy(me) : Promise.resolve([] as string[]),
    ]);
    if (blocked.includes(post.author_hash)) throw notFound();
    const visible = comments.filter((c) => !blocked.includes(c.author_hash));

    return {
      post: toPostDto(post, me, votes.get(id) ?? 0),
      // Numbering runs over what this caller sees, so a block never leaves a
      // gap ("#1, #3") that hints at a hidden participant.
      comments: toCommentDtos(post, visible, me),
    };
  });

  // --- writes -------------------------------------------------------------

  app.post('/community/posts', async (request, reply) => {
    const body = asBody(request);
    const title = cleanText(body.title, { singleLine: true });
    const details = cleanText(body.body, { singleLine: false });
    if (title.length < COMMUNITY_LIMITS.titleMin || title.length > COMMUNITY_LIMITS.titleMax) {
      throw badRequest(`Titles need ${COMMUNITY_LIMITS.titleMin}-${COMMUNITY_LIMITS.titleMax} characters.`);
    }
    if (details.length > COMMUNITY_LIMITS.bodyMax) {
      throw badRequest(`Details can be at most ${COMMUNITY_LIMITS.bodyMax} characters.`);
    }

    const me = await writer(request, 'post');
    await screen(details ? `${title}\n\n${details}` : title, 'post', request);
    const row = await db.insertPost({ author_hash: me, title, body: details });
    request.log.info({ postId: row.id }, 'community: post created');
    return reply.status(201).send({ post: toPostDto(row, me, 0) });
  });

  app.delete('/community/posts/:id', async (request) => {
    ensureConfigured();
    const id = requireUuid((request.params as { id?: string }).id, 'idea');
    const me = callerOf(request);
    const post = await db.getPost(id);
    // Same answer for "not yours" and "doesn't exist": no ownership oracle.
    if (!post || !me || post.author_hash !== me || post.status === 'removed') throw notFound();
    await db.removePost(id);
    return { deleted: true };
  });

  app.post('/community/posts/:id/vote', async (request) => {
    const id = requireUuid((request.params as { id?: string }).id, 'idea');
    const value = asBody(request).value;
    if (value !== 1 && value !== -1 && value !== 0) throw badRequest('Vote must be 1, -1 or 0.');
    const me = await writer(request, 'vote');
    const post = await visiblePost(id);
    if (post.status === 'shipped') throw badRequest('Shipped ideas can no longer be voted on.');
    await db.setVote(id, me, value);
    const updated = await db.getPost(id);
    return { score: updated?.score ?? post.score, myVote: value };
  });

  app.post('/community/posts/:id/comments', async (request, reply) => {
    const id = requireUuid((request.params as { id?: string }).id, 'idea');
    const text = cleanText(asBody(request).body, { singleLine: false });
    if (text.length < 1 || text.length > COMMUNITY_LIMITS.commentMax) {
      throw badRequest(`Comments need 1-${COMMUNITY_LIMITS.commentMax} characters.`);
    }
    const me = await writer(request, 'comment');
    const post = await visiblePost(id);
    const needsReview = await screen(text, 'comment', request);
    const row = await db.insertComment({ post_id: id, author_hash: me, body: text, needs_review: needsReview });

    // The new comment's thread label depends on who else has commented.
    const thread = await db.listComments(id);
    const [dto] = toCommentDtos(post, [...thread.filter((c) => c.id !== row.id), row], me).slice(-1);
    return reply.status(201).send({ comment: dto });
  });

  app.delete('/community/comments/:id', async (request) => {
    ensureConfigured();
    const id = requireUuid((request.params as { id?: string }).id, 'comment');
    const me = callerOf(request);
    const comment = await db.getComment(id);
    if (!comment || !me || comment.author_hash !== me || comment.removed) {
      throw new HttpError(404, 'not_found', 'This comment is no longer available.');
    }
    await db.removeComment(id);
    return { deleted: true };
  });

  /** The author of a post or comment, or 404. Hidden items stay reportable/blockable. */
  async function authorOf(targetType: TargetType, targetId: string): Promise<string> {
    const target = targetType === 'post' ? await db.getPost(targetId) : await db.getComment(targetId);
    if (!target) throw notFound();
    return target.author_hash;
  }

  function parseTarget(body: Record<string, unknown>): { targetType: TargetType; targetId: string } {
    const targetType = body.targetType;
    if (targetType !== 'post' && targetType !== 'comment') throw badRequest('Unknown target type.');
    return { targetType, targetId: requireUuid(body.targetId, targetType) };
  }

  app.post('/community/reports', async (request) => {
    const body = asBody(request);
    const { targetType, targetId } = parseTarget(body);
    const reason = body.reason;
    if (typeof reason !== 'string' || !REPORT_REASONS.includes(reason as ReportReason)) {
      throw badRequest('Pick a reason for the report.');
    }
    const note = cleanText(body.note, { singleLine: false });
    if (note.length > COMMUNITY_LIMITS.noteMax) {
      throw badRequest(`Notes can be at most ${COMMUNITY_LIMITS.noteMax} characters.`);
    }

    const me = await writer(request, 'report');
    const author = await authorOf(targetType, targetId);
    if (author === me) throw badRequest("You can't report your own post.");

    const outcome = await db.insertReport({
      target_type: targetType,
      target_id: targetId,
      reporter_hash: me,
      reason: reason as ReportReason,
      note: note || null,
    });
    request.log.info({ targetType, targetId, reason, outcome }, 'community: report');
    // A repeat report is acknowledged the same way; the person did nothing wrong.
    return { reported: true };
  });

  app.post('/community/blocks', async (request) => {
    const { targetType, targetId } = parseTarget(asBody(request));
    const me = await writer(request, 'block');
    const author = await authorOf(targetType, targetId);
    if (author === me) throw badRequest("You can't hide your own posts.");
    if (author === TEAM_AUTHOR_HASH) throw badRequest("Posts from the Morsel team can't be hidden.");
    await db.insertBlock(me, author);
    return { blocked: true };
  });
}
