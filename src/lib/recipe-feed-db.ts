/**
 * Storage for the community recipe feed (`routes/recipe-feed.ts`): posts,
 * suggestion comments and saves. Supabase / memory / unconfigured, like
 * `community-db.ts`; the memory version mirrors the triggers in
 * `supabase/005_discover.sql` (save, remix and comment counts, 3-report hide).
 *
 * Rows carry `author_hash`, which must never leave the server.
 */

import { randomUUID } from 'node:crypto';

import { REPORT_HIDE_THRESHOLD } from './community-db.js';
import { createPostgrest, inList, type PostgrestConfig } from './postgrest.js';
import { filterParams, matchesFilters, type FacetColumns, type RecipeFilters } from './recipe-facets.js';
import type { Macros } from './types.js';

export type FeedPlatform = 'instagram' | 'tiktok' | 'web' | 'manual';

/** The recipe body as shared (the `recipe` jsonb column). */
export interface SharedRecipe {
  title: string;
  category: FacetColumns['category'];
  servings?: number;
  ingredients: string[];
  steps: string[];
  macros: Macros;
  macrosSource: 'caption' | 'estimated';
  sourcePlatform: FeedPlatform;
  sourceUrl?: string;
}

export interface FeedPostRow extends FacetColumns {
  id: string;
  author_hash: string;
  author_name: string | null;
  remix_of: string | null;
  note: string;
  image_url: string | null;
  source_url: string | null;
  source_platform: FeedPlatform;
  servings: number | null;
  recipe: SharedRecipe;
  save_count: number;
  remix_count: number;
  comment_count: number;
  report_count: number;
  hidden: boolean;
  needs_review: boolean;
  removed: boolean;
  created_at: string;
  updated_at: string;
}

export type FeedPostWrite = Omit<
  FeedPostRow,
  | 'id'
  | 'save_count'
  | 'remix_count'
  | 'comment_count'
  | 'report_count'
  | 'hidden'
  | 'removed'
  | 'created_at'
  | 'updated_at'
>;

/** What an author may change when re-sharing. */
export type FeedPostUpdate = Omit<FeedPostWrite, 'author_hash' | 'remix_of'>;

export interface FeedCommentRow {
  id: string;
  post_id: string;
  author_hash: string;
  author_name: string | null;
  body: string;
  applied: boolean;
  report_count: number;
  hidden: boolean;
  needs_review: boolean;
  removed: boolean;
  created_at: string;
}

export type FeedSort = 'new' | 'popular' | 'most_remixed';

export interface FeedQuery {
  filters: RecipeFilters;
  sort: FeedSort;
  offset: number;
  limit: number;
  excludeAuthors: string[];
}

export type FeedTarget = 'recipe_post' | 'recipe_comment';

export interface RecipeFeedDb {
  readonly configured: boolean;
  /** Visible posts (not hidden, not removed). */
  list(query: FeedQuery): Promise<FeedPostRow[]>;
  get(id: string): Promise<FeedPostRow | null>;
  /** Visible remixes of a post, most saved first. */
  remixesOf(id: string, limit: number): Promise<FeedPostRow[]>;
  insert(row: FeedPostWrite): Promise<FeedPostRow>;
  update(id: string, patch: FeedPostUpdate): Promise<FeedPostRow | null>;
  remove(id: string): Promise<void>;
  recordSave(id: string, saverHash: string): Promise<void>;
  getComment(id: string): Promise<FeedCommentRow | null>;
  /** Visible comments, oldest first. */
  listComments(postId: string): Promise<FeedCommentRow[]>;
  insertComment(row: {
    post_id: string;
    author_hash: string;
    author_name: string | null;
    body: string;
    needs_review: boolean;
  }): Promise<FeedCommentRow>;
  removeComment(id: string): Promise<void>;
  setApplied(id: string, applied: boolean): Promise<void>;
  insertReport(row: {
    target_type: FeedTarget;
    target_id: string;
    reporter_hash: string;
    reason: string;
    note: string | null;
  }): Promise<'recorded' | 'duplicate'>;
}

const ORDER: Record<FeedSort, string> = {
  new: 'created_at.desc',
  popular: 'save_count.desc,created_at.desc',
  most_remixed: 'remix_count.desc,save_count.desc,created_at.desc',
};

// --- Supabase ---------------------------------------------------------------

export function createSupabaseRecipeFeedDb(
  config: PostgrestConfig,
  deps: { fetch?: typeof fetch } = {},
): RecipeFeedDb {
  const db = createPostgrest(config, deps.fetch, 'recipe feed db');
  const enc = encodeURIComponent;
  const visible = 'hidden=is.false&removed=is.false';

  return {
    configured: db.configured,

    async list(query) {
      const params = [
        visible,
        query.excludeAuthors.length > 0 ? `author_hash=not.in.${inList(query.excludeAuthors)}` : '',
        ...filterParams(query.filters),
      ].filter(Boolean);
      return db.request<FeedPostRow[]>(
        `recipe_posts?select=*&${params.join('&')}&order=${ORDER[query.sort]}` +
          `&offset=${query.offset}&limit=${query.limit}`,
      );
    },

    async get(id) {
      const rows = await db.request<FeedPostRow[]>(`recipe_posts?select=*&id=eq.${enc(id)}&limit=1`);
      return rows[0] ?? null;
    },

    async remixesOf(id, limit) {
      return db.request<FeedPostRow[]>(
        `recipe_posts?select=*&remix_of=eq.${enc(id)}&${visible}&order=${ORDER.popular}&limit=${limit}`,
      );
    },

    async insert(row) {
      const rows = await db.request<FeedPostRow[]>('recipe_posts', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      return rows[0];
    },

    async update(id, patch) {
      const rows = await db.request<FeedPostRow[]>(`recipe_posts?id=eq.${enc(id)}`, {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
      });
      return rows[0] ?? null;
    },

    async remove(id) {
      await db.request(`recipe_posts?id=eq.${enc(id)}`, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ removed: true }),
      });
    },

    async recordSave(id, saverHash) {
      await db.request('recipe_saves?on_conflict=target_type,target_id,saver_hash', {
        method: 'POST',
        headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ target_type: 'post', target_id: id, saver_hash: saverHash }),
      });
    },

    async getComment(id) {
      const rows = await db.request<FeedCommentRow[]>(`recipe_comments?select=*&id=eq.${enc(id)}&limit=1`);
      return rows[0] ?? null;
    },

    async listComments(postId) {
      return db.request<FeedCommentRow[]>(
        `recipe_comments?select=*&post_id=eq.${enc(postId)}&${visible}&order=created_at.asc&limit=500`,
      );
    },

    async insertComment(row) {
      const rows = await db.request<FeedCommentRow[]>('recipe_comments', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      return rows[0];
    },

    async removeComment(id) {
      await db.request(`recipe_comments?id=eq.${enc(id)}`, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ removed: true }),
      });
    },

    async setApplied(id, applied) {
      await db.request(`recipe_comments?id=eq.${enc(id)}`, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ applied }),
      });
    },

    insertReport: (row) => db.insertReport(row),
  };
}

// --- Memory -----------------------------------------------------------------

export function createMemoryRecipeFeedDb(): RecipeFeedDb & {
  admin: { posts(): FeedPostRow[] };
} {
  const posts = new Map<string, FeedPostRow>();
  const comments = new Map<string, FeedCommentRow>();
  const saves = new Set<string>(); // `${postId}|${saver}`
  const reports = new Set<string>(); // `${type}|${id}|${reporter}`
  let last = 0;
  const now = () => {
    last = Math.max(Date.now(), last + 1);
    return new Date(last).toISOString();
  };
  const isVisible = (p: { hidden: boolean; removed: boolean }) => !p.hidden && !p.removed;
  const copy = <T>(row: T): T => structuredClone(row);

  function recountRemixes(parentId: string | null): void {
    if (!parentId) return;
    const parent = posts.get(parentId);
    if (parent) {
      parent.remix_count = [...posts.values()].filter((p) => p.remix_of === parentId && isVisible(p)).length;
    }
  }

  function recountComments(postId: string): void {
    const post = posts.get(postId);
    if (post) {
      post.comment_count = [...comments.values()].filter((c) => c.post_id === postId && isVisible(c)).length;
    }
  }

  function sortRows(rows: FeedPostRow[], sort: FeedSort): FeedPostRow[] {
    return rows.sort((a, b) => {
      if (sort === 'most_remixed' && b.remix_count !== a.remix_count) return b.remix_count - a.remix_count;
      if (sort !== 'new' && b.save_count !== a.save_count) return b.save_count - a.save_count;
      return b.created_at.localeCompare(a.created_at);
    });
  }

  return {
    configured: true,

    async list(query) {
      const rows = [...posts.values()].filter(
        (p) => isVisible(p) && !query.excludeAuthors.includes(p.author_hash) && matchesFilters(p, query.filters),
      );
      return sortRows(rows, query.sort).slice(query.offset, query.offset + query.limit).map(copy);
    },

    async get(id) {
      const post = posts.get(id);
      return post ? copy(post) : null;
    },

    async remixesOf(id, limit) {
      const rows = [...posts.values()].filter((p) => p.remix_of === id && isVisible(p));
      return sortRows(rows, 'popular').slice(0, limit).map(copy);
    },

    async insert(row) {
      const at = now();
      const post: FeedPostRow = {
        ...row,
        id: randomUUID(),
        save_count: 0,
        remix_count: 0,
        comment_count: 0,
        report_count: 0,
        hidden: false,
        removed: false,
        created_at: at,
        updated_at: at,
      };
      posts.set(post.id, post);
      recountRemixes(post.remix_of);
      return copy(post);
    },

    async update(id, patch) {
      const post = posts.get(id);
      if (!post) return null;
      Object.assign(post, patch, { updated_at: now() });
      return copy(post);
    },

    async remove(id) {
      const post = posts.get(id);
      if (!post) return;
      post.removed = true;
      recountRemixes(post.remix_of);
    },

    async recordSave(id, saverHash) {
      saves.add(`${id}|${saverHash}`);
      const post = posts.get(id);
      if (post) post.save_count = [...saves].filter((key) => key.startsWith(`${id}|`)).length;
    },

    async getComment(id) {
      const comment = comments.get(id);
      return comment ? copy(comment) : null;
    },

    async listComments(postId) {
      return [...comments.values()]
        .filter((c) => c.post_id === postId && isVisible(c))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map(copy);
    },

    async insertComment(row) {
      const comment: FeedCommentRow = {
        ...row,
        id: randomUUID(),
        applied: false,
        report_count: 0,
        hidden: false,
        removed: false,
        created_at: now(),
      };
      comments.set(comment.id, comment);
      recountComments(row.post_id);
      return copy(comment);
    },

    async removeComment(id) {
      const comment = comments.get(id);
      if (!comment) return;
      comment.removed = true;
      recountComments(comment.post_id);
    },

    async setApplied(id, applied) {
      const comment = comments.get(id);
      if (comment) comment.applied = applied;
    },

    async insertReport(row) {
      const key = `${row.target_type}|${row.target_id}|${row.reporter_hash}`;
      if (reports.has(key)) return 'duplicate';
      reports.add(key);
      const count = [...reports].filter((r) => r.startsWith(`${row.target_type}|${row.target_id}|`)).length;
      const target = row.target_type === 'recipe_post' ? posts.get(row.target_id) : comments.get(row.target_id);
      if (target) {
        target.report_count = count;
        target.hidden = target.hidden || count >= REPORT_HIDE_THRESHOLD;
        if (row.target_type === 'recipe_post') recountRemixes((target as FeedPostRow).remix_of);
        else recountComments((target as FeedCommentRow).post_id);
      }
      return 'recorded';
    },

    admin: {
      posts: () => [...posts.values()].map(copy),
    },
  };
}

export function createUnconfiguredRecipeFeedDb(): RecipeFeedDb {
  const refuse = async (): Promise<never> => {
    throw new Error('recipe feed db is not configured');
  };
  return {
    configured: false,
    list: refuse,
    get: refuse,
    remixesOf: refuse,
    insert: refuse,
    update: refuse,
    remove: refuse,
    recordSave: refuse,
    getComment: refuse,
    listComments: refuse,
    insertComment: refuse,
    removeComment: refuse,
    setApplied: refuse,
    insertReport: refuse,
  };
}
