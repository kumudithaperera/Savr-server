import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from '../app.js';
import { createMemoryCommunityDb } from '../lib/community-db.js';
import { upstreamError } from '../lib/errors.js';
import type { ContentModerator } from '../services/moderation.js';

/**
 * The board's promises, pinned: authors are anonymous to everyone but the
 * admin, only an author can delete their own words, three distinct reports
 * hide an item, blocks and bans hold, and moderation fails closed for posts.
 */

const PEPPER = 'test-pepper';
const hashOf = (deviceId: string) =>
  createHash('sha256').update(`${PEPPER}:${deviceId}`).digest('hex');

function setup(options: { moderator?: ContentModerator; configured?: boolean } = {}) {
  const db = createMemoryCommunityDb();
  const deps = {
    instagramScraper: { scrape: vi.fn() },
    tiktokScraper: { scrape: vi.fn() },
    webScraper: { scrape: vi.fn() },
    parser: { parse: vi.fn() },
    improver: {} as AppDeps['improver'],
    photoSearch: { search: vi.fn(async () => null) },
    nutrition: { search: vi.fn(async () => null) },
    appSharedSecret: '',
    communityDb: options.configured === false ? undefined : db,
    moderator: options.moderator,
    communityHashPepper: PEPPER,
    // Generous, so the per-IP guard never interferes with a scenario.
    rateLimit: { max: 1000, windowMs: 60_000 },
  } as AppDeps;
  const app = buildApp(deps);

  const as = (deviceId: string | null) => {
    const headers: Record<string, string> = deviceId ? { 'x-morsel-device-id': deviceId } : {};
    return {
      get: (url: string) => app.inject({ method: 'GET', url, headers }),
      post: (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers, payload: payload as object }),
      del: (url: string) => app.inject({ method: 'DELETE', url, headers }),
    };
  };

  async function createPost(deviceId: string, title = 'Grocery list from recipes', body = '') {
    const res = await as(deviceId).post('/community/posts', { title, body });
    expect(res.statusCode).toBe(201);
    return res.json().post as { id: string };
  }

  return { app, db, as, createPost };
}

describe('community board', () => {
  it('answers 503 when no database is configured', async () => {
    const { as } = setup({ configured: false });
    const res = await as('alice').get('/community/posts');
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('community_unavailable');
  });

  it('creates and lists a post without ever exposing the author hash', async () => {
    const { as, createPost } = setup();
    const post = await createPost('alice', '  Grocery   list from recipes ', 'Group by aisle');

    const mine = await as('alice').get('/community/posts');
    const theirs = await as('bob').get('/community/posts');
    expect(mine.json().posts[0]).toMatchObject({ id: post.id, title: 'Grocery list from recipes', isMine: true });
    expect(theirs.json().posts[0]).toMatchObject({ id: post.id, isMine: false });

    for (const raw of [mine.body, theirs.body]) {
      expect(raw).not.toContain(hashOf('alice'));
      expect(raw).not.toContain('author_hash');
      expect(raw).not.toContain('alice');
    }
  });

  it('validates title length and requires a device id to write', async () => {
    const { as } = setup();
    expect((await as('alice').post('/community/posts', { title: 'hey' })).statusCode).toBe(400);
    expect((await as('alice').post('/community/posts', { title: 'x'.repeat(81) })).statusCode).toBe(400);
    const anon = await as(null).post('/community/posts', { title: 'A perfectly fine idea' });
    expect(anon.statusCode).toBe(400);
    expect(anon.json().code).toBe('device_required');
  });

  it('rejects contact details and link spam before the moderator runs', async () => {
    const moderator = { review: vi.fn(async () => ({ allowed: true as const })) };
    const { as } = setup({ moderator });
    const email = await as('alice').post('/community/posts', { title: 'Email me at a@b.com please' });
    const links = await as('alice').post('/community/posts', {
      title: 'Great deals here',
      body: 'https://a.example https://b.example',
    });
    expect(email.statusCode).toBe(422);
    expect(email.json().code).toBe('content_rejected');
    expect(links.statusCode).toBe(422);
    expect(moderator.review).not.toHaveBeenCalled();
  });

  it('rejects what the moderator rejects', async () => {
    const moderator = { review: vi.fn(async () => ({ allowed: false as const, category: 'harassment' })) };
    const { as, db } = setup({ moderator });
    const res = await as('alice').post('/community/posts', { title: 'Something nasty here' });
    expect(res.statusCode).toBe(422);
    expect(db.admin.posts()).toHaveLength(0);
  });

  it('fails closed for posts and open-but-flagged for comments when moderation is down', async () => {
    let down = false;
    const moderator: ContentModerator = {
      review: vi.fn(async () => {
        if (down) throw upstreamError('gemini down');
        return { allowed: true as const };
      }),
    };
    const { as, db, createPost } = setup({ moderator });
    const post = await createPost('alice');

    down = true;
    const blocked = await as('bob').post('/community/posts', { title: 'Another good idea' });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().code).toBe('moderation_unavailable');

    const comment = await as('bob').post(`/community/posts/${post.id}/comments`, { body: 'Yes please' });
    expect(comment.statusCode).toBe(201);
    const stored = await db.listComments(post.id);
    expect(stored[0].needs_review).toBe(true);
  });

  it('votes, flips and clears, keeping one vote per device', async () => {
    const { as, createPost } = setup();
    const post = await createPost('alice');
    const vote = (device: string, value: number) =>
      as(device).post(`/community/posts/${post.id}/vote`, { value });

    expect((await vote('bob', 1)).json()).toEqual({ score: 1, myVote: 1 });
    expect((await vote('bob', 1)).json().score).toBe(1);
    expect((await vote('carol', -1)).json().score).toBe(0);
    expect((await vote('bob', -1)).json().score).toBe(-2);
    expect((await vote('bob', 0)).json().score).toBe(-1);
    expect((await vote('bob', 5)).statusCode).toBe(400);

    const list = await as('carol').get('/community/posts');
    expect(list.json().posts[0]).toMatchObject({ score: -1, myVote: -1 });
  });

  it('labels commenters per thread, with the author as op', async () => {
    const { as, createPost } = setup();
    const post = await createPost('alice');
    await as('bob').post(`/community/posts/${post.id}/comments`, { body: 'first' });
    await as('alice').post(`/community/posts/${post.id}/comments`, { body: 'thanks' });
    await as('carol').post(`/community/posts/${post.id}/comments`, { body: 'me too' });
    await as('bob').post(`/community/posts/${post.id}/comments`, { body: 'again' });

    const detail = await as('carol').get(`/community/posts/${post.id}`);
    const authors = detail.json().comments.map((c: { author: unknown; isMine: boolean }) => [c.author, c.isMine]);
    expect(authors).toEqual([[1, false], ['op', false], [2, true], [1, false]]);
    expect(detail.json().post.commentCount).toBe(4);
    expect(detail.body).not.toContain(hashOf('bob'));
  });

  it('only lets the author delete their own post or comment', async () => {
    const { as, createPost } = setup();
    const post = await createPost('alice');
    const comment = (await as('bob').post(`/community/posts/${post.id}/comments`, { body: 'hi' })).json().comment;

    expect((await as('bob').del(`/community/posts/${post.id}`)).statusCode).toBe(404);
    expect((await as('alice').del(`/community/comments/${comment.id}`)).statusCode).toBe(404);

    expect((await as('bob').del(`/community/comments/${comment.id}`)).statusCode).toBe(200);
    expect((await as('alice').del(`/community/posts/${post.id}`)).statusCode).toBe(200);
    expect((await as('bob').get('/community/posts')).json().posts).toHaveLength(0);
    expect((await as('bob').get(`/community/posts/${post.id}`)).statusCode).toBe(404);
  });

  it('hides a post after three distinct reporters, not three reports from one', async () => {
    const { as, createPost } = setup();
    const post = await createPost('alice');
    const report = (device: string) =>
      as(device).post('/community/reports', { targetType: 'post', targetId: post.id, reason: 'spam', note: 'ad' });

    expect((await report('bob')).statusCode).toBe(200);
    expect((await report('bob')).statusCode).toBe(200);
    expect((await report('bob')).statusCode).toBe(200);
    expect((await as('dave').get('/community/posts')).json().posts).toHaveLength(1);

    await report('carol');
    await report('erin');
    expect((await as('dave').get('/community/posts')).json().posts).toHaveLength(0);
  });

  it('validates reports and refuses self-reports', async () => {
    const { as, createPost } = setup();
    const post = await createPost('alice');
    const bad = await as('bob').post('/community/reports', { targetType: 'post', targetId: post.id, reason: 'meh' });
    expect(bad.statusCode).toBe(400);
    const self = await as('alice').post('/community/reports', { targetType: 'post', targetId: post.id, reason: 'spam' });
    expect(self.statusCode).toBe(400);
    const long = await as('bob').post('/community/reports', {
      targetType: 'post',
      targetId: post.id,
      reason: 'other',
      note: 'x'.repeat(501),
    });
    expect(long.statusCode).toBe(400);
  });

  it('hides a blocked author from the blocker only', async () => {
    const { as, createPost } = setup();
    const post = await createPost('alice', 'Alice has an idea');
    await createPost('carol', 'Carol has an idea');
    const comment = (await as('alice').post(`/community/posts/${post.id}/comments`, { body: 'more' })).json().comment;

    // Blocking via a comment hides the same person's posts too.
    const res = await as('bob').post('/community/blocks', { targetType: 'comment', targetId: comment.id });
    expect(res.statusCode).toBe(200);

    const bobSees = (await as('bob').get('/community/posts')).json().posts.map((p: { title: string }) => p.title);
    const daveSees = (await as('dave').get('/community/posts')).json().posts;
    expect(bobSees).toEqual(['Carol has an idea']);
    expect(daveSees).toHaveLength(2);
    expect((await as('bob').get(`/community/posts/${post.id}`)).statusCode).toBe(404);
  });

  it('refuses every write from a banned device', async () => {
    const { as, db, createPost } = setup();
    const post = await createPost('alice');
    db.admin.ban(hashOf('mallory'));
    const write = await as('mallory').post(`/community/posts/${post.id}/comments`, { body: 'hi' });
    expect(write.statusCode).toBe(403);
    expect((await as('mallory').post('/community/posts', { title: 'Let me in please' })).statusCode).toBe(403);
    // Reading stays open.
    expect((await as('mallory').get('/community/posts')).statusCode).toBe(200);
  });

  it('caps posts per device per day', async () => {
    const { as } = setup();
    for (let i = 0; i < 5; i++) {
      expect((await as('alice').post('/community/posts', { title: `Idea number ${i}` })).statusCode).toBe(201);
    }
    const sixth = await as('alice').post('/community/posts', { title: 'Idea number 6' });
    expect(sixth.statusCode).toBe(429);
  });

  it('sorts by top or new and moves admin-marked ideas between tabs', async () => {
    const { as, db, createPost } = setup();
    const older = await createPost('alice', 'Older but popular');
    const newer = await createPost('bob', 'Newer and quiet');
    await as('carol').post(`/community/posts/${older.id}/vote`, { value: 1 });

    const titles = async (query: string) =>
      (await as('dave').get(`/community/posts?${query}`)).json().posts.map((p: { title: string }) => p.title);
    expect(await titles('tab=ideas&sort=top')).toEqual(['Older but popular', 'Newer and quiet']);
    expect(await titles('tab=ideas&sort=new')).toEqual(['Newer and quiet', 'Older but popular']);

    db.admin.setStatus(older.id, 'planned');
    db.admin.setStatus(newer.id, 'shipped', '1.0.21');
    expect(await titles('tab=ideas')).toEqual([]);
    expect(await titles('tab=planned')).toEqual(['Older but popular']);
    const shipped = (await as('dave').get('/community/posts?tab=shipped')).json().posts[0];
    expect(shipped).toMatchObject({ title: 'Newer and quiet', status: 'shipped', shippedVersion: '1.0.21' });

    // Shipped ideas are settled.
    expect((await as('dave').post(`/community/posts/${newer.id}/vote`, { value: 1 })).statusCode).toBe(400);
    expect((await as('dave').get('/community/posts?tab=nope')).statusCode).toBe(400);
  });

  it('pages with a cursor', async () => {
    const { as, db } = setup();
    for (let i = 0; i < 25; i++) await db.insertPost({ author_hash: `h${i}`, title: `Idea ${i}`, body: '' });
    const first = (await as('dave').get('/community/posts?sort=new')).json();
    expect(first.posts).toHaveLength(20);
    expect(first.nextCursor).toBe('20');
    const second = (await as('dave').get(`/community/posts?sort=new&cursor=${first.nextCursor}`)).json();
    expect(second.posts).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects malformed ids before touching the database', async () => {
    const { as } = setup();
    expect((await as('alice').get('/community/posts/not-a-uuid')).statusCode).toBe(400);
    expect((await as('alice').post('/community/posts/1;drop/vote', { value: 1 })).statusCode).toBe(400);
  });

  it('puts the board behind the app key', async () => {
    const db = createMemoryCommunityDb();
    const app = buildApp({
      instagramScraper: { scrape: vi.fn() },
      tiktokScraper: { scrape: vi.fn() },
      webScraper: { scrape: vi.fn() },
      parser: { parse: vi.fn() },
      improver: {} as AppDeps['improver'],
      photoSearch: { search: vi.fn(async () => null) },
      nutrition: { search: vi.fn(async () => null) },
      appSharedSecret: 'secret',
      communityDb: db,
    } as AppDeps);
    expect((await app.inject({ method: 'GET', url: '/community/posts' })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/community/posts', headers: { 'x-morsel-app-key': 'secret' } });
    expect(ok.statusCode).toBe(200);
  });
});
