import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from '../app.js';
import { grantKey } from '../lib/grants.js';
import { createStore, type Store } from '../lib/store.js';
import type { ScrapedPost } from '../lib/types.js';

/**
 * Redemption is the one place where getting the state wrong hands out a paid
 * tier for free, so these cases pin the behaviour that matters: a code is
 * single-use across installs, re-entering it on the *same* install is harmless,
 * and guessing is rate limited.
 */

const CODE = 'MORSELPLUS01';

function stubScraper(caption: string) {
  return { scrape: vi.fn(async (): Promise<ScrapedPost> => ({ caption })) };
}

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    instagramScraper: stubScraper('ig'),
    tiktokScraper: stubScraper('tt'),
    webScraper: stubScraper('web'),
    parser: {
      parse: vi.fn(async () => ({
        title: 'Pancakes',
        servings: 2,
        ingredients: ['flour'],
        steps: ['mix'],
        macros: { calories: 100, carbs: 10, protein: 5, fat: 2 },
        macrosStatedInCaption: false,
        suggestedCategory: 'meals' as const,
      })),
    },
    improver: {} as AppDeps['improver'],
    photoSearch: { search: vi.fn(async () => null) },
    nutrition: { search: vi.fn(async () => null) },
    appSharedSecret: '',
    redeem: { plusRedeemCodes: [CODE], plusGrantDays: 0 },
    ...overrides,
  };
}

/** One store shared across several apps, standing in for a persistent Redis. */
function sharedStore(): Store {
  return createStore({ upstashUrl: '', upstashToken: '' });
}

function redeem(app: ReturnType<typeof buildApp>, code: string, deviceId: string) {
  return app.inject({
    method: 'POST',
    url: '/redeem',
    headers: { 'x-morsel-device-id': deviceId },
    payload: { code },
  });
}

describe('POST /redeem', () => {
  it('grants Plus for an issued code', async () => {
    const app = buildApp(makeDeps({ store: sharedStore() }));
    const res = await redeem(app, CODE, 'device-a');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ plus: true, expiresAt: null });
    await app.close();
  });

  it('ignores case, spaces and hyphens in what the user types', async () => {
    const app = buildApp(makeDeps({ store: sharedStore() }));
    const res = await redeem(app, ' morsel-plus 01 ', 'device-a');
    expect(res.statusCode).toBe(200);
    expect(res.json().plus).toBe(true);
    await app.close();
  });

  it('rejects a code we never issued', async () => {
    const app = buildApp(makeDeps({ store: sharedStore() }));
    const res = await redeem(app, 'NOPE12345', 'device-a');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('invalid_code');
    await app.close();
  });

  it('rejects everything when no codes are issued', async () => {
    const app = buildApp(
      makeDeps({ store: sharedStore(), redeem: { plusRedeemCodes: [], plusGrantDays: 0 } }),
    );
    const res = await redeem(app, CODE, 'device-a');
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('invalid_code');
    await app.close();
  });

  it('rejects an empty code as a bad request rather than a failed guess', async () => {
    const app = buildApp(makeDeps({ store: sharedStore() }));
    const res = await redeem(app, '   ', 'device-a');
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('is idempotent for the install that already redeemed', async () => {
    const store = sharedStore();
    const app = buildApp(makeDeps({ store }));
    expect((await redeem(app, CODE, 'device-a')).statusCode).toBe(200);
    const again = await redeem(app, CODE, 'device-a');
    expect(again.statusCode).toBe(200);
    expect(again.json().plus).toBe(true);
    await app.close();
  });

  it('refuses a code already claimed by another install', async () => {
    const store = sharedStore();
    const app = buildApp(makeDeps({ store }));
    expect((await redeem(app, CODE, 'device-a')).statusCode).toBe(200);
    const other = await redeem(app, CODE, 'device-b');
    expect(other.statusCode).toBe(409);
    expect(other.json().code).toBe('code_already_used');
    await app.close();
  });

  it('locks out after five wrong codes', async () => {
    const store = sharedStore();
    // The per-IP guardrail would fire first at its default of 30/min, so give
    // this case room: we are testing the redeem-specific limiter.
    const app = buildApp(makeDeps({ store, rateLimit: { max: 1000, windowMs: 60_000 } }));
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await redeem(app, `WRONG${attempt}`, 'device-a')).statusCode).toBe(422);
    }
    // Even the real code is refused once the install is locked out.
    const locked = await redeem(app, CODE, 'device-a');
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe('rate_limited');
    await app.close();
  });

  it('does not count a successful redemption against the attempt limit', async () => {
    const store = sharedStore();
    const app = buildApp(makeDeps({ store, rateLimit: { max: 1000, windowMs: 60_000 } }));
    for (let attempt = 0; attempt < 5; attempt++) {
      await redeem(app, CODE, 'device-a');
    }
    expect((await redeem(app, CODE, 'device-a')).statusCode).toBe(200);
    await app.close();
  });
});

describe('GET /entitlement', () => {
  function entitlement(app: ReturnType<typeof buildApp>, deviceId: string) {
    return app.inject({
      method: 'GET',
      url: '/entitlement',
      headers: { 'x-morsel-device-id': deviceId },
    });
  }

  it('reports no Plus for an install that never redeemed', async () => {
    const app = buildApp(makeDeps({ store: sharedStore() }));
    const res = await entitlement(app, 'device-a');
    expect(res.json()).toEqual({ plus: false, expiresAt: null, source: null });
    await app.close();
  });

  it('reports Plus after redeeming', async () => {
    const store = sharedStore();
    const app = buildApp(makeDeps({ store }));
    await redeem(app, CODE, 'device-a');
    const res = await entitlement(app, 'device-a');
    expect(res.json()).toEqual({ plus: true, expiresAt: null, source: 'code' });
    await app.close();
  });

  it('sets an expiry when the grant is time-limited', async () => {
    const store = sharedStore();
    const app = buildApp(makeDeps({ store, redeem: { plusRedeemCodes: [CODE], plusGrantDays: 1 } }));
    const before = Date.now();
    const res = await redeem(app, CODE, 'device-a');
    const { expiresAt } = res.json();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    expect((await entitlement(app, 'device-a')).json()).toEqual({
      plus: true,
      expiresAt,
      source: 'code',
    });
    await app.close();
  });

  // Written straight into the store rather than advancing a clock: Fastify's
  // inject() runs on real timers, so faking them deadlocks the request.
  it('reports no Plus once a grant has lapsed', async () => {
    const store = sharedStore();
    await store.setJson(grantKey('device-a'), {
      code: CODE,
      grantedAt: Date.now() - 2000,
      expiresAt: Date.now() - 1000,
    });
    const app = buildApp(makeDeps({ store }));
    expect((await entitlement(app, 'device-a')).json()).toEqual({
      plus: false,
      expiresAt: null,
      source: null,
    });
    await app.close();
  });

  it('requires the app key when a shared secret is set', async () => {
    const app = buildApp(makeDeps({ store: sharedStore(), appSharedSecret: 'sekret' }));
    expect((await entitlement(app, 'device-a')).statusCode).toBe(401);
    expect((await redeem(app, CODE, 'device-a')).statusCode).toBe(401);
    await app.close();
  });
});

/**
 * The extraction cap is the only Plus benefit that costs real money, so it is
 * decided from the grant record the server wrote - never from a client claim.
 */
describe('extraction quota with a Plus grant', () => {
  const LIMITS = {
    monthlyDeviceExtractionLimit: 1,
    plusDeviceExtractionLimit: 3,
    globalDailyExtractionLimit: 100,
    extractCacheTtlDays: 30,
  };

  // Distinct links, so the second call is a real extraction rather than a cache
  // hit (hits deliberately cost no quota).
  function extract(app: ReturnType<typeof buildApp>, videoId: string, deviceId: string) {
    return app.inject({
      method: 'POST',
      url: '/extract',
      headers: { 'x-morsel-device-id': deviceId },
      payload: { url: `https://www.tiktok.com/@x/video/${videoId}` },
    });
  }

  it('cuts a free install off at the free limit', async () => {
    const app = buildApp(makeDeps({ store: sharedStore(), limits: LIMITS }));
    expect((await extract(app, '1', 'device-free')).statusCode).toBe(200);
    const second = await extract(app, '2', 'device-free');
    expect(second.statusCode).toBe(429);
    expect(second.json().code).toBe('quota_exceeded');
    await app.close();
  });

  it('lets a granted install past the free limit', async () => {
    const store = sharedStore();
    const app = buildApp(makeDeps({ store, limits: LIMITS }));
    expect((await redeem(app, CODE, 'device-plus')).statusCode).toBe(200);
    expect((await extract(app, '3', 'device-plus')).statusCode).toBe(200);
    expect((await extract(app, '4', 'device-plus')).statusCode).toBe(200);
    await app.close();
  });
});
