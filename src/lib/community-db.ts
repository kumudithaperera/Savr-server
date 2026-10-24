/**
 * Storage for the community ideas board (`routes/community.ts`).
 *
 * Two implementations behind one interface, the same split as `store.ts`:
 *
 *  - **Supabase** (PostgREST over plain `fetch`, service role). Production. The
 *    tables, counters and the report threshold live in
 *    `supabase/003_community.sql`; the triggers there keep `score`,
 *    `comment_count`, `report_count` and `hidden` correct, so this file only
 *    ever writes the primary rows and reads the results back.
 *  - **Memory**. Tests, and local dev when `COMMUNITY_DB=memory`. It mirrors the
 *    triggers in JS so the route behaves identically against either.
 *
 * Everything here deals in `author_hash` values. They identify a device for
 * moderation and must never leave the server - the route maps rows to DTOs that
 * carry `isMine` and per-thread labels instead.
 *
 * Unlike the store, nothing here fails open. A board write that silently went
 * nowhere would look like moderation to the person posting.
 */

import { randomUUID } from 'node:crypto';

import type { BlockCaller } from './community-kit.js';
import { TEAM_AUTHOR_HASH, type SeedPost } from './community-seed.js';

/** Distinct reporters that hide an item until an admin looks. Mirrors the SQL trigger. */
export const REPORT_HIDE_THRESHOLD = 3;

export type PostStatus = 'open' | 'planned' | 'in_progress' | 'shipped' | 'removed';
export type ReportReason =
  | 'spam'
  | 'offensive'
  | 'harassment'
  | 'personal_info'
  | 'off_topic'
  | 'other';
export type TargetType = 'post' | 'comment';
/**
 * What a report row can carry. `blocked` is filed alongside a block: admins see
 * it, but it never counts towards `REPORT_HIDE_THRESHOLD`.
 */
export type StoredReason = ReportReason | 'blocked';

/** One person someone blocked, as Profile -> Blocked users lists it. */
export interface BlockEntry {
  /** Opaque handle the app unblocks by. Never the blocked author's hash. */
  id: string;
  name: string | null;
  created_at: string;
}

/** Above this many blocked authors, feeds filter in memory instead of in the URL. */
export const MAX_URL_EXCLUSIONS = 200;

export interface PostRow {
  id: string;
  author_hash: string;
  title: string;
  body: string;
  status: PostStatus;
  shipped_version: string | null;
  shipped_at: string | null;
  score: number;
  comment_count: number;
  report_count: number;
  hidden: boolean;
  needs_review: boolean;
  created_at: string;
}

export interface CommentRow {
  id: string;
  post_id: string;
  author_hash: string;
  body: string;
  report_count: number;
  hidden: boolean;
  needs_review: boolean;
  removed: boolean;
  created_at: string;
}

export interface ListPostsQuery {
  statuses: PostStatus[];
  sort: 'top' | 'new' | 'shipped';
  offset: number;
  limit: number;
  /** Authors the caller has blocked; their posts are left out. */
  excludeAuthors: string[];
}

/** The two columns the board's counts need. */
export interface PostKind {
  status: PostStatus;
  author_hash: string;
}

export interface CommunityDb {
  /** False when no backend is configured; the route then answers 503. */
  readonly configured: boolean;
  listPosts(query: ListPostsQuery): Promise<PostRow[]>;
  /** Status and author of every visible post in `statuses` - just enough to count the board. */
  listPostKinds(query: Pick<ListPostsQuery, 'statuses' | 'excludeAuthors'>): Promise<PostKind[]>;
  getPost(id: string): Promise<PostRow | null>;
  getComment(id: string): Promise<CommentRow | null>;
  /** Visible comments of a post (not hidden, not removed), oldest first. */
  listComments(postId: string): Promise<CommentRow[]>;
  insertPost(row: { author_hash: string; title: string; body: string }): Promise<PostRow>;
  insertComment(row: {
    post_id: string;
    author_hash: string;
    body: string;
    needs_review: boolean;
  }): Promise<CommentRow>;
  /** Soft-deletes; the row stays for an admin reviewing a report. */
  removePost(id: string): Promise<void>;
  removeComment(id: string): Promise<void>;
  /** The caller's vote on each of `postIds` (missing = no vote). */
  votesBy(voterHash: string, postIds: string[]): Promise<Map<string, 1 | -1>>;
  /** 0 clears the vote. */
  setVote(postId: string, voterHash: string, value: -1 | 0 | 1): Promise<void>;
  /** `duplicate` when this device already reported this target. */
  insertReport(row: {
    target_type: TargetType;
    target_id: string;
    reporter_hash: string;
    reason: StoredReason;
    note: string | null;
  }): Promise<'recorded' | 'duplicate'>;
  /**
   * Records a block. A signed-in caller's block goes on the account, so it
   * follows them to every device; otherwise it is kept for this device only.
   */
  insertBlock(caller: { hash: string; userId: string | null }, blockedHash: string, name: string | null): Promise<void>;
  /** Author hashes the caller blocked, from this device and their account. */
  blockedBy(caller: BlockCaller): Promise<string[]>;
  /** The caller's blocks, one per blocked author, newest first. */
  listBlocks(caller: BlockCaller): Promise<BlockEntry[]>;
  /** Unblocks, from the device and the account. False when `id` isn't the caller's. */
  deleteBlock(caller: BlockCaller, id: string): Promise<boolean>;
  /** Moves this device's blocks onto the account (after sign-in). Returns how many. */
  claimBlocks(hash: string, userId: string): Promise<number>;
  isBanned(authorHash: string): Promise<boolean>;
}

// --- Supabase (PostgREST) ---------------------------------------------------

type Fetch = typeof fetch;

export interface SupabaseCommunityConfig {
  url: string;
  serviceRoleKey: string;
}

/** PostgREST `in.(...)` list. Values are hex hashes or uuids, but quote anyway. */
function inList(values: string[]): string {
  return `(${values.map((v) => `"${v.replace(/["\\]/g, '')}"`).join(',')})`;
}

/** One entry per blocked author (the first row wins), newest first. */
function toEntries(rows: { id: string; blocked_hash: string; blocked_name: string | null; created_at: string }[]): BlockEntry[] {
  const seen = new Set<string>();
  const entries: BlockEntry[] = [];
  for (const row of rows) {
    if (seen.has(row.blocked_hash)) continue;
    seen.add(row.blocked_hash);
    entries.push({ id: row.id, name: row.blocked_name, created_at: row.created_at });
  }
  return entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function createSupabaseCommunityDb(
  config: SupabaseCommunityConfig,
  deps: { fetch?: Fetch } = {},
): CommunityDb {
  const doFetch = deps.fetch ?? fetch;
  const base = config.url.replace(/\/$/, '');
  const configured = Boolean(base && config.serviceRoleKey);

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: config.serviceRoleKey,
    authorization: `Bearer ${config.serviceRoleKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
    ...extra,
  });

  async function request<T>(path: string, init: RequestInit = {}, ok: number[] = []): Promise<T> {
    const response = await doFetch(`${base}/rest/v1/${path}`, {
      ...init,
      headers: headers((init.headers as Record<string, string>) ?? {}),
    });
    if (!response.ok && !ok.includes(response.status)) {
      throw new Error(`community db: ${init.method ?? 'GET'} ${path.split('?')[0]} -> ${response.status}`);
    }
    if (response.status === 204 || ok.includes(response.status)) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const enc = encodeURIComponent;

  const ORDER: Record<ListPostsQuery['sort'], string> = {
    top: 'score.desc,created_at.desc',
    new: 'created_at.desc',
    shipped: 'shipped_at.desc.nullslast,created_at.desc',
  };

  /**
   * `listPosts` for a caller with more blocks than fit in a URL: reads pages in
   * order and drops blocked authors here, until `offset + limit` survivors.
   */
  async function listPostsFiltered(query: ListPostsQuery): Promise<PostRow[]> {
    const excluded = new Set(query.excludeAuthors);
    const wanted = query.offset + query.limit;
    const kept: PostRow[] = [];
    const batch = 200;
    for (let from = 0; kept.length < wanted && from < 20_000; from += batch) {
      const rows = await request<PostRow[]>(
        `community_posts?select=*&status=in.${inList(query.statuses)}&hidden=is.false` +
          `&order=${ORDER[query.sort]}&offset=${from}&limit=${batch}`,
      );
      kept.push(...rows.filter((row) => !excluded.has(row.author_hash)));
      if (rows.length < batch) break;
    }
    return kept.slice(query.offset, wanted);
  }

  type BlockRow = { id: string; blocked_hash: string; blocked_name: string | null; created_at: string };

  /** The caller's device rows and account rows, in one list. */
  async function blockRows(caller: BlockCaller, select: string): Promise<BlockRow[]> {
    const [device, account] = await Promise.all([
      caller.hash
        ? request<BlockRow[]>(`community_blocks?select=${select}&blocker_hash=eq.${enc(caller.hash)}&limit=1000`)
        : Promise.resolve([]),
      caller.userId
        ? request<BlockRow[]>(
            `community_account_blocks?select=${select}&user_id=eq.${enc(caller.userId)}&limit=1000`,
          )
        : Promise.resolve([]),
    ]);
    return [...account, ...device];
  }

  return {
    configured,

    async listPosts(query) {
      const filters = [
        `status=in.${inList(query.statuses)}`,
        'hidden=is.false',
        query.excludeAuthors.length > 0 ? `author_hash=not.in.${inList(query.excludeAuthors)}` : '',
      ].filter(Boolean);
      if (query.excludeAuthors.length > MAX_URL_EXCLUSIONS) return listPostsFiltered(query);
      return request<PostRow[]>(
        `community_posts?select=*&${filters.join('&')}&order=${ORDER[query.sort]}` +
          `&offset=${query.offset}&limit=${query.limit}`,
      );
    },

    async listPostKinds(query) {
      const tooMany = query.excludeAuthors.length > MAX_URL_EXCLUSIONS;
      const filters = [
        `status=in.${inList(query.statuses)}`,
        'hidden=is.false',
        query.excludeAuthors.length > 0 && !tooMany ? `author_hash=not.in.${inList(query.excludeAuthors)}` : '',
      ].filter(Boolean);
      const rows = await request<PostKind[]>(`community_posts?select=status,author_hash&${filters.join('&')}`);
      if (!tooMany) return rows;
      const excluded = new Set(query.excludeAuthors);
      return rows.filter((row) => !excluded.has(row.author_hash));
    },

    async getPost(id) {
      const rows = await request<PostRow[]>(`community_posts?select=*&id=eq.${enc(id)}&limit=1`);
      return rows[0] ?? null;
    },

    async getComment(id) {
      const rows = await request<CommentRow[]>(`community_comments?select=*&id=eq.${enc(id)}&limit=1`);
      return rows[0] ?? null;
    },

    async listComments(postId) {
      return request<CommentRow[]>(
        `community_comments?select=*&post_id=eq.${enc(postId)}` +
          `&hidden=is.false&removed=is.false&order=created_at.asc&limit=500`,
      );
    },

    async insertPost(row) {
      const rows = await request<PostRow[]>('community_posts', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      return rows[0];
    },

    async insertComment(row) {
      const rows = await request<CommentRow[]>('community_comments', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      return rows[0];
    },

    async removePost(id) {
      await request(`community_posts?id=eq.${enc(id)}`, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'removed' }),
      });
    },

    async removeComment(id) {
      await request(`community_comments?id=eq.${enc(id)}`, {
        method: 'PATCH',
        headers: { prefer: 'return=minimal' },
        body: JSON.stringify({ removed: true }),
      });
    },

    async votesBy(voterHash, postIds) {
      const votes = new Map<string, 1 | -1>();
      if (postIds.length === 0) return votes;
      const rows = await request<{ post_id: string; value: 1 | -1 }[]>(
        `community_votes?select=post_id,value&voter_hash=eq.${enc(voterHash)}` +
          `&post_id=in.${inList(postIds)}`,
      );
      for (const row of rows) votes.set(row.post_id, row.value);
      return votes;
    },

    async setVote(postId, voterHash, value) {
      if (value === 0) {
        await request(
          `community_votes?post_id=eq.${enc(postId)}&voter_hash=eq.${enc(voterHash)}`,
          { method: 'DELETE', headers: { prefer: 'return=minimal' } },
        );
        return;
      }
      // Upsert on the (post_id, voter_hash) primary key; the trigger rescores.
      await request('community_votes?on_conflict=post_id,voter_hash', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ post_id: postId, voter_hash: voterHash, value }),
      });
    },

    async insertReport(row) {
      const response = await doFetch(`${base}/rest/v1/community_reports`, {
        method: 'POST',
        headers: headers({ prefer: 'return=minimal' }),
        body: JSON.stringify(row),
      });
      // 409 = the unique (target, reporter) constraint: already reported.
      if (response.status === 409) return 'duplicate';
      if (!response.ok) throw new Error(`community db: POST community_reports -> ${response.status}`);
      return 'recorded';
    },

    async insertBlock(caller, blockedHash, name) {
      const [path, row] = caller.userId
        ? [
            'community_account_blocks?on_conflict=user_id,blocked_hash',
            { user_id: caller.userId, blocked_hash: blockedHash, blocked_name: name },
          ]
        : [
            'community_blocks?on_conflict=blocker_hash,blocked_hash',
            { blocker_hash: caller.hash, blocked_hash: blockedHash, blocked_name: name },
          ];
      await request(path, {
        method: 'POST',
        headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(row),
      });
    },

    async blockedBy(caller) {
      const rows = await blockRows(caller, 'blocked_hash');
      return [...new Set(rows.map((row) => row.blocked_hash))];
    },

    async listBlocks(caller) {
      return toEntries(await blockRows(caller, 'id,blocked_hash,blocked_name,created_at'));
    },

    async deleteBlock(caller, id) {
      const [device, account] = await Promise.all([
        caller.hash
          ? request<{ blocked_hash: string }[]>(
              `community_blocks?select=blocked_hash&id=eq.${enc(id)}&blocker_hash=eq.${enc(caller.hash)}&limit=1`,
            )
          : Promise.resolve([]),
        caller.userId
          ? request<{ blocked_hash: string }[]>(
              `community_account_blocks?select=blocked_hash&id=eq.${enc(id)}&user_id=eq.${enc(caller.userId)}&limit=1`,
            )
          : Promise.resolve([]),
      ]);
      const blocked = device[0]?.blocked_hash ?? account[0]?.blocked_hash;
      if (!blocked) return false;
      const gone = { method: 'DELETE', headers: { prefer: 'return=minimal' } };
      await Promise.all([
        caller.hash
          ? request(`community_blocks?blocker_hash=eq.${enc(caller.hash)}&blocked_hash=eq.${enc(blocked)}`, gone)
          : Promise.resolve(),
        caller.userId
          ? request(`community_account_blocks?user_id=eq.${enc(caller.userId)}&blocked_hash=eq.${enc(blocked)}`, gone)
          : Promise.resolve(),
      ]);
      return true;
    },

    async claimBlocks(hash, userId) {
      const rows = await request<{ blocked_hash: string; blocked_name: string | null; created_at: string }[]>(
        `community_blocks?select=blocked_hash,blocked_name,created_at&blocker_hash=eq.${enc(hash)}&limit=1000`,
      );
      if (rows.length === 0) return 0;
      await request('community_account_blocks?on_conflict=user_id,blocked_hash', {
        method: 'POST',
        headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(rows.map((row) => ({ user_id: userId, ...row }))),
      });
      // Off the device once they're on the account, so an unblock on another
      // phone can't be undone by a stale copy left here.
      await request(`community_blocks?blocker_hash=eq.${enc(hash)}`, {
        method: 'DELETE',
        headers: { prefer: 'return=minimal' },
      });
      return rows.length;
    },

    async isBanned(authorHash) {
      const rows = await request<unknown[]>(
        `community_banned_devices?select=author_hash&author_hash=eq.${enc(authorHash)}&limit=1`,
      );
      return rows.length > 0;
    },
  };
}

// --- Memory -----------------------------------------------------------------

/**
 * In-process board for tests and local dev. Mirrors the SQL triggers. Pass
 * `seed` (local dev passes `SEED_POSTS`) to start with the roadmap, as the
 * Supabase board does after `004_seed_roadmap.sql`.
 */
export function createMemoryCommunityDb(options: { seed?: SeedPost[] } = {}): CommunityDb & {
  /** Test/admin hooks standing in for the Supabase dashboard. */
  admin: {
    setStatus(id: string, status: PostStatus, shippedVersion?: string): void;
    ban(authorHash: string): void;
    posts(): PostRow[];
    /** `${type}|${id}|${reporter}|${'blocked' | 'report'}` for every report row. */
    reports(): string[];
  };
} {
  const posts = new Map<string, PostRow>();
  const comments = new Map<string, CommentRow>();
  const votes = new Map<string, 1 | -1>(); // `${postId}|${voter}`
  const reports = new Set<string>(); // `${type}|${id}|${reporter}|${'blocked' | 'report'}`
  type MemoryBlock = { id: string; owner: string; blocked_hash: string; blocked_name: string | null; created_at: string };
  // Keyed `${owner}|${blocked}`; owner is a device hash or `user:${id}`.
  const blocks = new Map<string, MemoryBlock>();
  const ownersOf = (caller: BlockCaller) =>
    [caller.userId ? `user:${caller.userId}` : null, caller.hash].filter((o): o is string => Boolean(o));
  const banned = new Set<string>();
  let last = 0;

  // Real time, nudged forward so two writes in the same millisecond still order.
  const now = () => {
    last = Math.max(Date.now(), last + 1);
    return new Date(last).toISOString();
  };

  // Earlier in the seed list = newer, matching the SQL seed's timestamps.
  const seedStart = Date.now();
  (options.seed ?? []).forEach((post, index) => {
    const at = new Date(seedStart - (index + 1) * 60_000).toISOString();
    posts.set(post.id, {
      id: post.id,
      author_hash: TEAM_AUTHOR_HASH,
      title: post.title,
      body: post.body,
      status: post.status,
      shipped_version: null,
      shipped_at: post.status === 'shipped' ? at : null,
      score: 0,
      comment_count: 0,
      report_count: 0,
      hidden: false,
      needs_review: false,
      created_at: at,
    });
  });

  function rescore(postId: string): void {
    const post = posts.get(postId);
    if (!post) return;
    let score = 0;
    for (const [key, value] of votes) if (key.startsWith(`${postId}|`)) score += value;
    post.score = score;
  }

  function recount(postId: string): void {
    const post = posts.get(postId);
    if (!post) return;
    post.comment_count = [...comments.values()].filter(
      (c) => c.post_id === postId && !c.hidden && !c.removed,
    ).length;
  }

  return {
    configured: true,

    async listPosts(query) {
      const rows = [...posts.values()].filter(
        (p) =>
          query.statuses.includes(p.status) &&
          !p.hidden &&
          !query.excludeAuthors.includes(p.author_hash),
      );
      rows.sort((a, b) => {
        if (query.sort === 'top' && b.score !== a.score) return b.score - a.score;
        if (query.sort === 'shipped') {
          const sa = a.shipped_at ?? '';
          const sb = b.shipped_at ?? '';
          if (sa !== sb) return sb.localeCompare(sa);
        }
        return b.created_at.localeCompare(a.created_at);
      });
      return rows.slice(query.offset, query.offset + query.limit).map((p) => ({ ...p }));
    },

    async listPostKinds(query) {
      return [...posts.values()]
        .filter((p) => query.statuses.includes(p.status) && !p.hidden && !query.excludeAuthors.includes(p.author_hash))
        .map((p) => ({ status: p.status, author_hash: p.author_hash }));
    },

    async getPost(id) {
      const post = posts.get(id);
      return post ? { ...post } : null;
    },

    async getComment(id) {
      const comment = comments.get(id);
      return comment ? { ...comment } : null;
    },

    async listComments(postId) {
      return [...comments.values()]
        .filter((c) => c.post_id === postId && !c.hidden && !c.removed)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((c) => ({ ...c }));
    },

    async insertPost(row) {
      const post: PostRow = {
        id: randomUUID(),
        ...row,
        status: 'open',
        shipped_version: null,
        shipped_at: null,
        score: 0,
        comment_count: 0,
        report_count: 0,
        hidden: false,
        needs_review: false,
        created_at: now(),
      };
      posts.set(post.id, post);
      return { ...post };
    },

    async insertComment(row) {
      const comment: CommentRow = {
        id: randomUUID(),
        ...row,
        report_count: 0,
        hidden: false,
        removed: false,
        created_at: now(),
      };
      comments.set(comment.id, comment);
      recount(row.post_id);
      return { ...comment };
    },

    async removePost(id) {
      const post = posts.get(id);
      if (post) post.status = 'removed';
    },

    async removeComment(id) {
      const comment = comments.get(id);
      if (!comment) return;
      comment.removed = true;
      recount(comment.post_id);
    },

    async votesBy(voterHash, postIds) {
      const result = new Map<string, 1 | -1>();
      for (const id of postIds) {
        const value = votes.get(`${id}|${voterHash}`);
        if (value) result.set(id, value);
      }
      return result;
    },

    async setVote(postId, voterHash, value) {
      const key = `${postId}|${voterHash}`;
      if (value === 0) votes.delete(key);
      else votes.set(key, value);
      rescore(postId);
    },

    async insertReport(row) {
      const kind = row.reason === 'blocked' ? 'blocked' : 'report';
      const key = `${row.target_type}|${row.target_id}|${row.reporter_hash}|${kind}`;
      if (reports.has(key)) return 'duplicate';
      reports.add(key);
      if (kind === 'blocked') return 'recorded';
      const prefix = `${row.target_type}|${row.target_id}|`;
      const count = [...reports].filter((r) => r.startsWith(prefix) && r.endsWith('|report')).length;
      const target = row.target_type === 'post' ? posts.get(row.target_id) : comments.get(row.target_id);
      if (target) {
        target.report_count = count;
        target.hidden = target.hidden || count >= REPORT_HIDE_THRESHOLD;
        if (row.target_type === 'comment') recount((target as CommentRow).post_id);
      }
      return 'recorded';
    },

    async insertBlock(caller, blockedHash, name) {
      const owner = caller.userId ? `user:${caller.userId}` : caller.hash;
      const key = `${owner}|${blockedHash}`;
      if (blocks.has(key)) return;
      blocks.set(key, { id: randomUUID(), owner, blocked_hash: blockedHash, blocked_name: name, created_at: now() });
    },

    async blockedBy(caller) {
      const owners = ownersOf(caller);
      return [...new Set([...blocks.values()].filter((b) => owners.includes(b.owner)).map((b) => b.blocked_hash))];
    },

    async listBlocks(caller) {
      const owners = ownersOf(caller);
      // Account rows first, as the Supabase read returns them.
      const rows = [...blocks.values()]
        .filter((b) => owners.includes(b.owner))
        .sort((a, b) => owners.indexOf(a.owner) - owners.indexOf(b.owner));
      return toEntries(rows);
    },

    async deleteBlock(caller, id) {
      const owners = ownersOf(caller);
      const row = [...blocks.values()].find((b) => b.id === id && owners.includes(b.owner));
      if (!row) return false;
      for (const owner of owners) blocks.delete(`${owner}|${row.blocked_hash}`);
      return true;
    },

    async claimBlocks(hash, userId) {
      const mine = [...blocks.values()].filter((b) => b.owner === hash);
      for (const row of mine) {
        const key = `user:${userId}|${row.blocked_hash}`;
        if (!blocks.has(key)) blocks.set(key, { ...row, id: randomUUID(), owner: `user:${userId}` });
        blocks.delete(`${hash}|${row.blocked_hash}`);
      }
      return mine.length;
    },

    async isBanned(authorHash) {
      return banned.has(authorHash);
    },

    admin: {
      setStatus(id, status, shippedVersion) {
        const post = posts.get(id);
        if (!post) return;
        if (status === 'shipped' && post.status !== 'shipped' && !post.shipped_at) post.shipped_at = now();
        post.status = status;
        if (shippedVersion !== undefined) post.shipped_version = shippedVersion;
      },
      ban(authorHash) {
        banned.add(authorHash);
      },
      posts() {
        return [...posts.values()].map((p) => ({ ...p }));
      },
      reports() {
        return [...reports];
      },
    },
  };
}

/** Placeholder used when nothing is configured: every call is refused upstream. */
export function createUnconfiguredCommunityDb(): CommunityDb {
  const refuse = async (): Promise<never> => {
    throw new Error('community db is not configured');
  };
  return {
    configured: false,
    listPosts: refuse,
    listPostKinds: refuse,
    getPost: refuse,
    getComment: refuse,
    listComments: refuse,
    insertPost: refuse,
    insertComment: refuse,
    removePost: refuse,
    removeComment: refuse,
    votesBy: refuse,
    setVote: refuse,
    insertReport: refuse,
    insertBlock: refuse,
    blockedBy: refuse,
    listBlocks: refuse,
    deleteBlock: refuse,
    claimBlocks: refuse,
    isBanned: refuse,
  };
}
