import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from '../app.js';
import type { Store } from '../lib/store.js';
import { createStore } from '../lib/store.js';
import type { Supabase, SubscriptionRow, SubscriptionWrite } from '../lib/supabase.js';
import type { ScrapedPost } from '../lib/types.js';

/**
 * This endpoint is the only writer of paid entitlements and it is reachable by
 * the whole internet, so these cases pin the three properties that keep that
 * safe: it authenticates (and fails *closed* when unconfigured), a redelivery
 * can't apply twice, and a late event can't revoke a live subscription.
 */

const SECRET = 'webhook-secret-value';
const USER = '11111111-2222-3333-4444-555555555555';
const ENTITLEMENT = 'Morsel Plus';

function stubScraper(caption: string) {
  return { scrape: vi.fn(async (): Promise<ScrapedPost> => ({ caption })) };
}

/**
 * An in-memory stand-in for Supabase that keeps the one rule the real schema
 * enforces: a write only lands if its event is newer than the stored one.
 */
function fakeSupabase(): Supabase & {
  rows: Map<string, SubscriptionWrite>;
  events: Set<string>;
  subscription: SubscriptionRow | null;
} {
  const rows = new Map<string, SubscriptionWrite>();
  const events = new Set<string>();
  return {
    rows,
    events,
    subscription: null,
    configured: true,
    canWrite: true,
    async subscriptionForToken() {
      return this.subscription;
    },
    async recordEvent(event) {
      if (events.has(event.id)) return 'duplicate';
      events.add(event.id);
      return 'recorded';
    },
    async applySubscription(row) {
      const existing = rows.get(row.user_id);
      if (existing && existing.last_event_ms >= row.last_event_ms) return false;
      rows.set(row.user_id, row);
      return true;
    },
  };
}

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    instagramScraper: stubScraper('ig'),
    tiktokScraper: stubScraper('tt'),
    webScraper: stubScraper('web'),
    parser: { parse: vi.fn() } as unknown as AppDeps['parser'],
    improver: {} as AppDeps['improver'],
    photoSearch: { search: vi.fn(async () => null) },
    nutrition: { search: vi.fn(async () => null) },
    appSharedSecret: '',
    revenueCatWebhookSecret: SECRET,
    revenueCatEntitlementId: ENTITLEMENT,
    ...overrides,
  };
}

interface EventOverrides {
  id?: string;
  type?: string;
  app_user_id?: string;
  entitlement_ids?: string[];
  expiration_at_ms?: number | null;
  event_timestamp_ms?: number;
}

function event(overrides: EventOverrides = {}) {
  return {
    event: {
      id: 'evt-1',
      type: 'INITIAL_PURCHASE',
      app_user_id: USER,
      entitlement_ids: [ENTITLEMENT],
      product_id: 'plus_morsel_yearly_1',
      period_type: 'NORMAL',
      store: 'PLAY_STORE',
      expiration_at_ms: Date.now() + 30 * 24 * 60 * 60 * 1000,
      event_timestamp_ms: 1_000,
      ...overrides,
    },
  };
}

/** `null` sends no `Authorization` header at all (not `undefined`, which would
 * fall through to the default and send the real secret). */
function post(app: ReturnType<typeof buildApp>, payload: unknown, authorization: string | null = SECRET) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/revenuecat',
    headers: authorization === null ? {} : { authorization },
    payload: payload as object,
  });
}

describe('POST /webhooks/revenuecat', () => {
  it('rejects a delivery with no authorization header', async () => {
    const app = buildApp(makeDeps({ supabase: fakeSupabase() }));
    const res = await post(app, event(), null);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a delivery with the wrong secret', async () => {
    const supabase = fakeSupabase();
    const app = buildApp(makeDeps({ supabase }));
    const res = await post(app, event(), 'not-the-secret');
    expect(res.statusCode).toBe(401);
    // Nothing was recorded, so a wrong secret costs no Supabase write.
    expect(supabase.events.size).toBe(0);
  });

  it('accepts the secret sent as a Bearer token', async () => {
    const app = buildApp(makeDeps({ supabase: fakeSupabase() }));
    const res = await post(app, event(), `Bearer ${SECRET}`);
    expect(res.statusCode).toBe(200);
  });

  it('fails closed when no webhook secret is configured', async () => {
    // The app-key guardrail deliberately fails open when unset; this must not.
    // An unauthenticated route that decides who has paid is a "grant me Plus"
    // button, so an unconfigured deploy has to reject everything.
    const supabase = fakeSupabase();
    const app = buildApp(makeDeps({ supabase, revenueCatWebhookSecret: '' }));
    const res = await post(app, event(), '');
    expect(res.statusCode).toBe(401);
    expect(supabase.rows.size).toBe(0);
  });

  it('grants Plus on an initial purchase', async () => {
    const supabase = fakeSupabase();
    const app = buildApp(makeDeps({ supabase }));
    const res = await post(app, event());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', applied: true });
    expect(supabase.rows.get(USER)).toMatchObject({ plan: 'plus', will_renew: true });
  });

  it('ignores a redelivered event', async () => {
    const supabase = fakeSupabase();
    const app = buildApp(makeDeps({ supabase }));
    await post(app, event());
    const res = await post(app, event());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'duplicate' });
  });

  it('keeps Plus on cancellation until the period actually ends', async () => {
    // Cancelling turns off auto-renewal; the subscriber keeps what they paid
    // for. Revoking here would take Plus away from someone still owed it.
    const supabase = fakeSupabase();
    const app = buildApp(makeDeps({ supabase }));
    await post(app, event());
    await post(app, event({ id: 'evt-2', type: 'CANCELLATION', event_timestamp_ms: 2_000 }));

    expect(supabase.rows.get(USER)).toMatchObject({ plan: 'plus', will_renew: false });
  });

  it('revokes Plus on expiration', async () => {
    const supabase = fakeSupabase();
    const app = buildApp(makeDeps({ supabase }));
    await post(app, event());
    await post(
      app,
      event({
        id: 'evt-2',
        type: 'EXPIRATION',
        event_timestamp_ms: 2_000,
        expiration_at_ms: Date.now() - 1_000,
      }),
    );

    expect(supabase.rows.get(USER)).toMatchObject({ plan: 'free' });
  });

  it('does not let a late cancellation revoke a newer renewal', async () => {
    // RevenueCat does not guarantee ordering and retries on failure, so this
    // sequence is realistic, not contrived.
    const supabase = fakeSupabase();
    const app = buildApp(makeDeps({ supabase }));
    await post(app, event({ id: 'renewal', type: 'RENEWAL', event_timestamp_ms: 5_000 }));
    const res = await post(
      app,
      event({
        id: 'stale-expiry',
        type: 'EXPIRATION',
        event_timestamp_ms: 1_000,
        expiration_at_ms: Date.now() - 1_000,
      }),
    );

    expect(res.json()).toMatchObject({ applied: false });
    expect(supabase.rows.get(USER)).toMatchObject({ plan: 'plus' });
  });

  it('ignores an event for an entitlement we do not sell', async () => {
    const supabase = fakeSupabase();
    const app = buildApp(makeDeps({ supabase }));
    const res = await post(app, event({ entitlement_ids: ['Something Else'] }));

    expect(res.json()).toMatchObject({ applied: false, reason: 'other_entitlement' });
    expect(supabase.rows.size).toBe(0);
  });

  it('ignores a purchase made before signing in, rather than guessing a user', async () => {
    const supabase = fakeSupabase();
    const app = buildApp(makeDeps({ supabase }));
    const res = await post(app, event({ app_user_id: '$RCAnonymousID:abc123' }));

    expect(res.json()).toMatchObject({ applied: false, reason: 'anonymous_user' });
    expect(supabase.rows.size).toBe(0);
    // Still logged, so the purchase isn't lost while it waits to be aliased.
    expect(supabase.events.size).toBe(1);
  });

  it('answers a dashboard test event without touching subscriptions', async () => {
    const supabase = fakeSupabase();
    const app = buildApp(makeDeps({ supabase }));
    const res = await post(app, event({ type: 'TEST', entitlement_ids: [] }));

    expect(res.statusCode).toBe(200);
    expect(supabase.rows.size).toBe(0);
  });

  it('asks for a retry when the event could not be stored', async () => {
    const supabase = fakeSupabase();
    supabase.recordEvent = async () => 'failed';
    const app = buildApp(makeDeps({ supabase }));
    const res = await post(app, event());

    // 500 so RevenueCat redelivers rather than silently dropping a purchase.
    expect(res.statusCode).toBe(500);
  });

  it('is reachable without the app key, which RevenueCat cannot send', async () => {
    const store: Store = createStore({ upstashUrl: '', upstashToken: '' });
    const app = buildApp(makeDeps({ supabase: fakeSupabase(), appSharedSecret: 'app-key', store }));
    const res = await post(app, event());
    expect(res.statusCode).toBe(200);
  });
});
