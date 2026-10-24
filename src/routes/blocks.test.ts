import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from '../app.js';
import { createMemoryCommunityDb } from '../lib/community-db.js';
import { createMemoryRecipeFeedDb } from '../lib/recipe-feed-db.js';
import type { Supabase } from '../lib/supabase.js';

/**
 * Blocking users (MORSE-125), pinned across the board, the recipe feed and the
 * planner: blocks can be listed and undone, a signed-in block follows the
 * account to another device, a device's blocks move onto the account at
 * sign-in, the block signal reaches moderators without hiding anything, and
 * nobody can undo someone else's block.
 */

const PEPPER = 'test-pepper';
const hashOf = (deviceId: string) => createHash('sha256').update(`${PEPPER}:${deviceId}`).digest('hex');

const RECIPE = {
  title: 'Weeknight dal',
  category: 'meals',
  servings: 4,
  ingredients: ['200 g red lentils', '1 onion'],
  steps: ['Rinse the lentils.', 'Simmer 20 minutes.'],
  macros: { calories: 310, carbs: 45, protein: 18, fat: 6 },
  macrosSource: 'estimated',
  sourcePlatform: 'manual',
};

/** Tokens the fake Supabase Auth accepts, and whose account they are. */
const ACCOUNTS: Record<string, string> = {
  'token-ana': '11111111-1111-4111-8111-111111111111',
};

function fakeSupabase(): Supabase {
  return {
    configured: true,
    canWrite: true,
    subscriptionForToken: vi.fn(async () => null),
    recordEvent: vi.fn(async () => 'recorded' as const),
    applySubscription: vi.fn(async () => true),
    deleteUserForToken: vi.fn(async () => 'failed' as const),
    userIdForToken: vi.fn(async (token: string) => ACCOUNTS[token] ?? null),
  };
}

function setup() {
  const communityDb = createMemoryCommunityDb();
  const recipeFeedDb = createMemoryRecipeFeedDb();
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
    recipeFeedDb,
    supabase: fakeSupabase(),
    communityHashPepper: PEPPER,
    rateLimit: { max: 1000, windowMs: 60_000 },
  } as AppDeps);

  const as = (deviceId: string | null, token?: string) => {
    const headers: Record<string, string> = {};
    if (deviceId) headers['x-morsel-device-id'] = deviceId;
    if (token) headers.authorization = `Bearer ${token}`;
    return {
      get: (url: string) => app.inject({ method: 'GET', url, headers }),
      post: (url: string, payload: unknown = {}) =>
        app.inject({ method: 'POST', url, headers, payload: payload as object }),
      del: (url: string) => app.inject({ method: 'DELETE', url, headers }),
    };
  };

  async function idea(deviceId: string, title: string) {
    const res = await as(deviceId).post('/community/posts', { title });
    expect(res.statusCode).toBe(201);
    return res.json().post as { id: string };
  }

  async function recipe(deviceId: string, authorName?: string) {
    const res = await as(deviceId).post('/community/recipes', { recipe: RECIPE, authorName });
    expect(res.statusCode).toBe(201);
    return res.json().post as { id: string };
  }

  const titles = async (who: ReturnType<typeof as>) =>
    (await who.get('/community/posts')).json().posts.map((p: { title: string }) => p.title);
  const feedCount = async (who: ReturnType<typeof as>) =>
    (await who.get('/community/recipes')).json().posts.length;

  return { app, communityDb, as, idea, recipe, titles, feedCount };
}

describe('blocked users', () => {
  it('lists a block by name and an unblock brings the content back', async () => {
    const { as, idea, recipe, titles, feedCount } = setup();
    const post = await idea('mallory', 'Mallory has an idea');
    const shared = await recipe('mallory', 'Mal');
    await as('bob').post('/community/recipes/blocks', { targetType: 'recipe', targetId: shared.id });

    // One person, one entry, even though they post on both surfaces.
    expect(await titles(as('bob'))).toEqual([]);
    expect(await feedCount(as('bob'))).toBe(0);
    const { blocks } = (await as('bob').get('/community/blocks')).json();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].name).toBe('Mal');
    expect(JSON.stringify(blocks)).not.toContain(hashOf('mallory'));

    expect((await as('bob').del(`/community/blocks/${blocks[0].id}`)).statusCode).toBe(200);
    expect(await titles(as('bob'))).toEqual(['Mallory has an idea']);
    expect(await feedCount(as('bob'))).toBe(1);
    expect((await as('bob').get(`/community/posts/${post.id}`)).statusCode).toBe(200);
    expect((await as('bob').get('/community/blocks')).json().blocks).toEqual([]);
  });

  it('names a board author by their handle', async () => {
    const { as, idea } = setup();
    const post = await idea('mallory', 'Mallory has an idea');
    await as('bob').post('/community/blocks', { targetType: 'post', targetId: post.id });
    const [entry] = (await as('bob').get('/community/blocks')).json().blocks;
    expect(entry.name).toMatch(/^Cook [0-9A-F]{4}$/);
  });

  it('a block made while signed in holds on another device with the same account', async () => {
    const { as, idea, recipe, titles, feedCount } = setup();
    const post = await idea('mallory', 'Mallory has an idea');
    await recipe('mallory');
    await as('phone', 'token-ana').post('/community/blocks', { targetType: 'post', targetId: post.id });

    expect(await titles(as('tablet', 'token-ana'))).toEqual([]);
    expect(await feedCount(as('tablet', 'token-ana'))).toBe(0);
    // The tablet signed out, or someone else's device: not blocked.
    expect(await titles(as('tablet'))).toEqual(['Mallory has an idea']);

    // Unblocking on the tablet undoes it on the phone too.
    const [entry] = (await as('tablet', 'token-ana').get('/community/blocks')).json().blocks;
    expect((await as('tablet', 'token-ana').del(`/community/blocks/${entry.id}`)).statusCode).toBe(200);
    expect(await titles(as('phone', 'token-ana'))).toEqual(['Mallory has an idea']);
  });

  it('claim moves a device\'s blocks onto the account', async () => {
    const { as, idea, titles } = setup();
    const post = await idea('mallory', 'Mallory has an idea');
    await as('phone').post('/community/blocks', { targetType: 'post', targetId: post.id });
    expect(await titles(as('tablet', 'token-ana'))).toEqual(['Mallory has an idea']);

    const claim = await as('phone', 'token-ana').post('/community/blocks/claim');
    expect(claim.statusCode).toBe(200);
    expect(claim.json().claimed).toBe(1);
    expect(await titles(as('tablet', 'token-ana'))).toEqual([]);
    expect((await as('phone', 'token-ana').get('/community/blocks')).json().blocks).toHaveLength(1);
  });

  it('claim needs a valid session', async () => {
    const { as } = setup();
    expect((await as('phone').post('/community/blocks/claim')).statusCode).toBe(401);
    expect((await as('phone', 'forged').post('/community/blocks/claim')).statusCode).toBe(401);
  });

  it('an invalid token falls back to the device\'s own blocks', async () => {
    const { as, idea, titles } = setup();
    const post = await idea('mallory', 'Mallory has an idea');
    await as('phone', 'forged').post('/community/blocks', { targetType: 'post', targetId: post.id });
    expect(await titles(as('phone'))).toEqual([]);
  });

  it('tells moderators about a block without hiding anything', async () => {
    const { as, idea, communityDb, titles } = setup();
    const post = await idea('mallory', 'Mallory has an idea');
    for (const who of ['a', 'b', 'c', 'd']) {
      await as(who).post('/community/blocks', { targetType: 'post', targetId: post.id });
    }
    const signals = communityDb.admin.reports().filter((r) => r.startsWith(`post|${post.id}|`));
    expect(signals).toHaveLength(4);
    expect(signals.every((r) => r.endsWith('|blocked'))).toBe(true);
    // Four blocks, still visible to everyone who didn't block.
    expect(await titles(as('e'))).toEqual(['Mallory has an idea']);
    expect(communityDb.admin.posts().find((p) => p.id === post.id)?.hidden).toBe(false);

    // A real report from someone who also blocked still counts.
    const report = await as('a').post('/community/reports', { targetType: 'post', targetId: post.id, reason: 'spam' });
    expect(report.statusCode).toBe(200);
    expect(communityDb.admin.posts().find((p) => p.id === post.id)?.report_count).toBe(1);
  });

  it('nobody can undo someone else\'s block', async () => {
    const { as, idea, titles } = setup();
    const post = await idea('mallory', 'Mallory has an idea');
    await as('bob').post('/community/blocks', { targetType: 'post', targetId: post.id });
    const [entry] = (await as('bob').get('/community/blocks')).json().blocks;

    expect((await as('mallory').del(`/community/blocks/${entry.id}`)).statusCode).toBe(404);
    expect((await as('carol', 'token-ana').del(`/community/blocks/${entry.id}`)).statusCode).toBe(404);
    expect((await as('bob').del('/community/blocks/not-a-uuid')).statusCode).toBe(400);
    expect(await titles(as('bob'))).toEqual([]);
  });

  it('refuses to block yourself', async () => {
    const { as, idea } = setup();
    const post = await idea('mallory', 'Mallory has an idea');
    expect((await as('mallory').post('/community/blocks', { targetType: 'post', targetId: post.id })).statusCode).toBe(400);
    expect((await as('mallory').get('/community/blocks')).json().blocks).toEqual([]);
  });

  it('an anonymous caller with no device id has no blocks', async () => {
    const { as } = setup();
    const res = await as(null).get('/community/blocks');
    expect(res.statusCode).toBe(200);
    expect(res.json().blocks).toEqual([]);
  });
});
