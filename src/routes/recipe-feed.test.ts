import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from '../app.js';
import { createMemoryCommunityDb } from '../lib/community-db.js';
import { upstreamError } from '../lib/errors.js';
import { sweepUntaggedPosts } from '../lib/discover-indexer.js';
import { createMemoryRecipeFeedDb } from '../lib/recipe-feed-db.js';
import { createStore } from '../lib/store.js';
import type { ContentModerator } from '../services/moderation.js';
import type { ImageRehoster } from '../services/rehost.js';

/** Stands in for the Supabase bucket: uploads get a fake public URL. */
const fakeRehoster = (): ImageRehoster => ({
  rehost: vi.fn(async (url) => (url?.includes('cdninstagram.com') ? 'https://bucket.test/thumb.jpg' : null)),
  storeUpload: vi.fn(async (image) => `https://bucket.test/${image.mimeType.split('/')[1]}-${image.bytes.length}`),
});

// The smallest valid JPEG signature is enough for the type sniff.
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString('base64');

/**
 * The recipe feed's promises, pinned: posts show a moderated display name or a
 * stable handle and never the author hash, links are cleaned, remixes and
 * saves are counted, only the post's author marks a suggestion applied, three
 * reports hide, blocks and bans hold, and moderation fails closed for posts.
 */

const PEPPER = 'test-pepper';
const hashOf = (deviceId: string) => createHash('sha256').update(`${PEPPER}:${deviceId}`).digest('hex');

const shared = (over: Record<string, unknown> = {}) => ({
  title: 'Weeknight dal',
  category: 'meals',
  servings: 4,
  ingredients: ['200 g red lentils', '1 onion', '2 tsp cumin'],
  steps: ['Rinse the lentils.', 'Simmer 20 minutes with the spices.'],
  macros: { calories: 310, carbs: 45, protein: 18, fat: 6 },
  macrosSource: 'estimated',
  sourcePlatform: 'instagram',
  sourceUrl: 'https://www.instagram.com/reel/DAL1/?igsh=my-share-id',
  imageRemoteUrl: 'https://example.com/dal.jpg',
  ...over,
});

function setup(options: { moderator?: ContentModerator; configured?: boolean } = {}) {
  const db = createMemoryRecipeFeedDb();
  const rehoster = fakeRehoster();
  const communityDb = createMemoryCommunityDb();
  const app = buildApp({
    instagramScraper: { scrape: vi.fn() },
    tiktokScraper: { scrape: vi.fn() },
    webScraper: { scrape: vi.fn() },
    parser: { parse: vi.fn() },
    improver: {} as AppDeps['improver'],
    photoSearch: { search: vi.fn(async () => null) },
    nutrition: { search: vi.fn(async () => null) },
    appSharedSecret: '',
    communityDb,
    recipeFeedDb: options.configured === false ? undefined : db,
    moderator: options.moderator,
    communityHashPepper: PEPPER,
    rehoster,
    rateLimit: { max: 1000, windowMs: 60_000 },
  } as AppDeps);

  const as = (deviceId: string | null) => {
    const headers: Record<string, string> = deviceId ? { 'x-morsel-device-id': deviceId } : {};
    return {
      get: (url: string) => app.inject({ method: 'GET', url, headers }),
      post: (url: string, payload: unknown = {}) =>
        app.inject({ method: 'POST', url, headers, payload: payload as object }),
      put: (url: string, payload: unknown) => app.inject({ method: 'PUT', url, headers, payload: payload as object }),
      del: (url: string) => app.inject({ method: 'DELETE', url, headers }),
    };
  };

  async function share(deviceId: string, body: Record<string, unknown> = {}) {
    const res = await as(deviceId).post('/community/recipes', { recipe: shared(), ...body });
    expect(res.statusCode).toBe(201);
    return res.json().post as { id: string; authorName: string; imageUrl: string | null };
  }

  return { app, db, communityDb, rehoster, as, share };
}

describe('community recipe feed', () => {
  it('answers 503 when no database is configured', async () => {
    const { as } = setup({ configured: false });
    expect((await as('alice').get('/community/recipes')).statusCode).toBe(503);
  });

  it('shares a recipe with a display name, a cleaned link and no author hash', async () => {
    const { as, share } = setup();
    const post = await share('alice', { authorName: 'Alice', note: 'My go-to.' });
    expect(post.authorName).toBe('Alice');

    const detail = await as(null).get(`/community/recipes/${post.id}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.post).toMatchObject({
      title: 'Weeknight dal',
      note: 'My go-to.',
      steps: ['Rinse the lentils.', 'Simmer 20 minutes with the spices.'],
      sourceUrl: 'https://www.instagram.com/p/DAL1/',
      isMine: false,
    });
    expect(detail.body).not.toContain(hashOf('alice'));
    expect(detail.body).not.toContain('my-share-id');
  });

  it('falls back to a stable handle when no usable name is given', async () => {
    const { share } = setup();
    const first = await share('bob');
    const second = await share('bob', { authorName: '<script>' });
    expect(first.authorName).toMatch(/^Cook [0-9A-F]{4}$/);
    expect(second.authorName).toBe(first.authorName);
    expect((await share('carol')).authorName).not.toBe(first.authorName);
  });

  it('validates the recipe', async () => {
    const { as } = setup();
    const bad = [shared({ title: '' }), shared({ ingredients: [] }), shared({ category: 'brunch' }), shared({ steps: 'x' })];
    for (const recipe of bad) {
      expect((await as('alice').post('/community/recipes', { recipe })).statusCode).toBe(400);
    }
  });

  it('rejects contact details in what the person typed', async () => {
    const { as } = setup();
    const res = await as('alice').post('/community/recipes', { recipe: shared(), note: 'DM me at a@b.co' });
    expect(res.statusCode).toBe(422);
  });

  it('fails closed for posts and open for suggestions when moderation is down', async () => {
    const moderator: ContentModerator = { review: vi.fn(async () => { throw upstreamError('down'); }) };
    const { as, db } = setup({ moderator });
    expect((await as('alice').post('/community/recipes', { recipe: shared() })).statusCode).toBe(503);

    const row = await db.insert({
      author_hash: hashOf('alice'), author_name: null, remix_of: null, note: '', image_url: null, source_url: null,
      source_platform: 'manual', servings: null, recipe: shared() as never, needs_review: false, title: 'Dal',
      category: 'meals', calories: 0, protein: 0, carbs: 0, fat: 0, diet_tags: [], total_minutes: null,
      difficulty: null, search_text: 'dal',
    });
    const res = await as('bob').post(`/community/recipes/${row.id}/comments`, { body: 'Add lemon at the end.' });
    expect(res.statusCode).toBe(201);
  });

  it('filters the feed and sorts by saves', async () => {
    const { as, share } = setup();
    const dal = await share('alice');
    await as('alice').post('/community/recipes', {
      recipe: shared({ title: 'Mango lassi', category: 'drinks', ingredients: ['mango', 'yogurt'], macros: { calories: 180, carbs: 30, protein: 6, fat: 4 } }),
    });
    await as('bob').post(`/community/recipes/${dal.id}/save`);

    const drinks = (await as(null).get('/community/recipes?category=drinks')).json();
    expect(drinks.posts.map((p: { title: string }) => p.title)).toEqual(['Mango lassi']);
    expect((await as(null).get('/community/recipes?q=lent')).json().posts).toHaveLength(1);
    const popular = (await as(null).get('/community/recipes?sort=popular')).json();
    expect(popular.posts[0]).toMatchObject({ id: dal.id, saveCount: 1 });
  });

  it('save returns the full recipe and counts each device once, never the author', async () => {
    const { as, share, db } = setup();
    const post = await share('alice');
    const saved = (await as('bob').post(`/community/recipes/${post.id}/save`)).json();
    expect(saved.recipe).toMatchObject({ title: 'Weeknight dal', sourceUrl: 'https://www.instagram.com/p/DAL1/' });
    await as('bob').post(`/community/recipes/${post.id}/save`);
    await as('alice').post(`/community/recipes/${post.id}/save`);
    expect(db.admin.posts()[0].save_count).toBe(1);
  });

  it('links remixes and counts them on the original', async () => {
    const { as, share } = setup();
    const original = await share('alice', { authorName: 'Alice' });
    const remix = await share('bob', { remixOf: original.id, recipe: shared({ title: 'Spicy dal' }) });

    const parent = (await as(null).get(`/community/recipes/${original.id}`)).json();
    expect(parent.post.remixCount).toBe(1);
    expect(parent.remixes.map((r: { id: string }) => r.id)).toEqual([remix.id]);

    const child = (await as(null).get(`/community/recipes/${remix.id}`)).json();
    expect(child.remixOf).toEqual({ id: original.id, title: 'Weeknight dal', authorName: 'Alice' });

    const missing = await as('bob').post('/community/recipes', { recipe: shared(), remixOf: '00000000-0000-4000-8000-000000000000' });
    expect(missing.statusCode).toBe(404);
  });

  it('lets only the post author mark a suggestion applied', async () => {
    const { as, share } = setup();
    const post = await share('alice');
    const comment = (await as('bob').post(`/community/recipes/${post.id}/comments`, { body: 'Temper the cumin in ghee first.' })).json().comment;
    expect(comment).toMatchObject({ isMine: true, isAuthor: false, applied: false });

    expect((await as('bob').post(`/community/recipes/comments/${comment.id}/applied`, { applied: true })).statusCode).toBe(404);
    expect((await as('alice').post(`/community/recipes/comments/${comment.id}/applied`, { applied: true })).statusCode).toBe(200);
    const detail = (await as(null).get(`/community/recipes/${post.id}`)).json();
    expect(detail.comments[0].applied).toBe(true);
    expect(detail.post.commentCount).toBe(1);
  });

  it('only the author can update or delete, with no ownership oracle', async () => {
    const { as, share } = setup();
    const post = await share('alice');
    expect((await as('bob').put(`/community/recipes/${post.id}`, { recipe: shared({ title: 'Hijacked' }) })).statusCode).toBe(404);
    expect((await as('bob').del(`/community/recipes/${post.id}`)).statusCode).toBe(404);

    const updated = await as('alice').put(`/community/recipes/${post.id}`, { recipe: shared({ title: 'Better dal' }) });
    expect(updated.json().post.title).toBe('Better dal');
    expect((await as('alice').del(`/community/recipes/${post.id}`)).statusCode).toBe(200);
    expect((await as(null).get(`/community/recipes/${post.id}`)).statusCode).toBe(404);
  });

  it('hides a post after three distinct reports', async () => {
    const { as, share } = setup();
    const post = await share('alice');
    expect((await as('alice').post('/community/recipes/reports', { targetType: 'recipe', targetId: post.id, reason: 'spam' })).statusCode).toBe(400);
    for (const who of ['a', 'b', 'b', 'c']) {
      await as(who).post('/community/recipes/reports', { targetType: 'recipe', targetId: post.id, reason: 'spam' });
    }
    expect((await as(null).get('/community/recipes')).json().posts).toHaveLength(0);
  });

  it('blocks hide an author everywhere for the blocker only, and bans stop writes', async () => {
    const { as, share, communityDb } = setup();
    const post = await share('alice');
    expect((await as('bob').post('/community/recipes/blocks', { targetType: 'recipe', targetId: post.id })).statusCode).toBe(200);
    expect((await as('bob').get('/community/recipes')).json().posts).toHaveLength(0);
    expect((await as('bob').get(`/community/recipes/${post.id}`)).statusCode).toBe(404);
    expect((await as('carol').get('/community/recipes')).json().posts).toHaveLength(1);

    communityDb.admin.ban(hashOf('mallory'));
    expect((await as('mallory').post('/community/recipes', { recipe: shared() })).statusCode).toBe(403);
  });

  it('caps posts per device per day', async () => {
    const { as } = setup();
    for (let i = 0; i < 5; i++) {
      expect((await as('alice').post('/community/recipes', { recipe: shared() })).statusCode).toBe(201);
    }
    expect((await as('alice').post('/community/recipes', { recipe: shared() })).statusCode).toBe(429);
  });

  describe('photos', () => {
    it('never publishes an image URL the client chose', async () => {
      const { share } = setup();
      const post = await share('alice', { recipe: shared({ imageRemoteUrl: 'https://tracker.example/pixel.jpg' }) });
      expect(post.imageUrl).toBeNull();
    });

    it('copies an Instagram thumbnail into the bucket', async () => {
      const { share } = setup();
      const post = await share('alice', { recipe: shared({ imageRemoteUrl: 'https://scontent.cdninstagram.com/v/t.jpg' }) });
      expect(post.imageUrl).toBe('https://bucket.test/thumb.jpg');
    });

    it('stores an uploaded photo and has the moderator judge it', async () => {
      const review = vi.fn(async () => ({ allowed: true as const }));
      const { share } = setup({ moderator: { review } });
      const post = await share('alice', { image: { mimeType: 'image/png', data: JPEG_B64 } });
      // The bytes decide the type, not the claimed mimeType.
      expect(post.imageUrl).toBe('https://bucket.test/jpeg-8');
      expect(review).toHaveBeenCalledWith(expect.any(String), 'recipe', { mimeType: 'image/jpeg', data: JPEG_B64 });
    });

    it('refuses an upload that is not an image', async () => {
      const { as } = setup();
      const res = await as('alice').post('/community/recipes', {
        recipe: shared(),
        image: { mimeType: 'image/jpeg', data: Buffer.from('<svg onload=alert(1)>').toString('base64') },
      });
      expect(res.statusCode).toBe(400);
    });

    it('keeps the published photo when a re-share sends none', async () => {
      const { as, share } = setup();
      const post = await share('alice', { image: { mimeType: 'image/jpeg', data: JPEG_B64 } });
      const updated = await as('alice').put(`/community/recipes/${post.id}`, { recipe: shared({ title: 'Dal v2' }) });
      expect(updated.json().post.imageUrl).toBe('https://bucket.test/jpeg-8');
    });
  });

  it('tags a post later when classification failed at share time', async () => {
    const { db, share } = setup();
    const post = await share('alice');
    expect(db.admin.posts()[0].difficulty).toBeNull();
    const classifier = { classify: vi.fn(async () => ({ dietTags: ['vegan' as const], totalMinutes: 30, difficulty: 'easy' as const })) };
    const store = createStore({ upstashUrl: '', upstashToken: '' });
    expect(await sweepUntaggedPosts(db, { store, classifier, dailyClassifyLimit: 10 }, 10)).toBe(1);
    expect(db.admin.posts().find((p) => p.id === post.id)).toMatchObject({ difficulty: 'easy', diet_tags: ['vegan'] });
  });
});
