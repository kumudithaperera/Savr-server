import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { resolveEntitlement } from './entitlement.js';
import { grantKey, type PlusGrant } from './grants.js';
import { createStore, type Store } from './store.js';
import type { Supabase, SubscriptionRow } from './supabase.js';

/**
 * The resolver decides who gets the 200/month AI extraction cap instead of 30,
 * which is the only Plus benefit that costs real money. These cases pin the two
 * directions it must not get wrong: a paying subscriber must not be treated as
 * free (the bug this whole change exists to fix), and merely holding an account
 * - or claiming one - must not be treated as paying.
 */

const NOW = 1_700_000_000_000;
const DEVICE = 'device-abc';

function request(headers: Record<string, string> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

function supabaseReturning(row: SubscriptionRow | null): Supabase {
  return {
    configured: true,
    canWrite: true,
    subscriptionForToken: vi.fn(async () => row),
    recordEvent: vi.fn(async () => 'recorded' as const),
    applySubscription: vi.fn(async () => true),
  };
}

/** Supabase unconfigured, as in local dev and in the test suite by default. */
const noSupabase: Supabase = {
  configured: false,
  canWrite: false,
  subscriptionForToken: vi.fn(async () => null),
  recordEvent: vi.fn(async () => 'failed' as const),
  applySubscription: vi.fn(async () => false),
};

function emptyStore(): Store {
  return createStore({ upstashUrl: '', upstashToken: '' });
}

async function storeWithGrant(grant: PlusGrant): Promise<Store> {
  const store = emptyStore();
  await store.setJson(grantKey(DEVICE), grant);
  return store;
}

const deviceHeader = { 'x-morsel-device-id': DEVICE };
const authHeader = { authorization: 'Bearer token-abc' };

describe('resolveEntitlement', () => {
  it('reports free for an anonymous caller with nothing', async () => {
    const result = await resolveEntitlement(
      { store: emptyStore(), supabase: noSupabase },
      request(deviceHeader),
      NOW,
    );
    expect(result).toEqual({ plus: false, source: null, expiresAt: null });
  });

  it('reports Plus from an active subscription', async () => {
    const supabase = supabaseReturning({
      user_id: 'user-1',
      plan: 'plus',
      expires_at: new Date(NOW + 86_400_000).toISOString(),
    });
    const result = await resolveEntitlement(
      { store: emptyStore(), supabase },
      request({ ...deviceHeader, ...authHeader }),
      NOW,
    );

    expect(result.plus).toBe(true);
    expect(result.source).toBe('subscription');
  });

  it('treats a subscription with no expiry as active, not expired', async () => {
    // A lifetime or promotional entitlement legitimately has no expiry.
    const supabase = supabaseReturning({ user_id: 'user-1', plan: 'plus', expires_at: null });
    const result = await resolveEntitlement(
      { store: emptyStore(), supabase },
      request({ ...deviceHeader, ...authHeader }),
      NOW,
    );

    expect(result).toEqual({ plus: true, source: 'subscription', expiresAt: null });
  });

  it('reports free once the subscription has lapsed', async () => {
    const supabase = supabaseReturning({
      user_id: 'user-1',
      plan: 'plus',
      expires_at: new Date(NOW - 1).toISOString(),
    });
    const result = await resolveEntitlement(
      { store: emptyStore(), supabase },
      request({ ...deviceHeader, ...authHeader }),
      NOW,
    );

    expect(result.plus).toBe(false);
  });

  it('does not grant Plus merely for being signed in', async () => {
    // The row exists but the plan is free - signing in is not subscribing.
    const supabase = supabaseReturning({ user_id: 'user-1', plan: 'free', expires_at: null });
    const result = await resolveEntitlement(
      { store: emptyStore(), supabase },
      request({ ...deviceHeader, ...authHeader }),
      NOW,
    );

    expect(result.plus).toBe(false);
  });

  it('ignores a token Supabase will not vouch for', async () => {
    // A forged or expired JWT yields no row, so it resolves to the free cap
    // rather than to an error or to trust.
    const supabase = supabaseReturning(null);
    const result = await resolveEntitlement(
      { store: emptyStore(), supabase },
      request({ ...deviceHeader, authorization: 'Bearer forged' }),
      NOW,
    );

    expect(result.plus).toBe(false);
  });

  it('never asks Supabase when the caller sent no token', async () => {
    const supabase = supabaseReturning({ user_id: 'user-1', plan: 'plus', expires_at: null });
    await resolveEntitlement({ store: emptyStore(), supabase }, request(deviceHeader), NOW);
    expect(supabase.subscriptionForToken).not.toHaveBeenCalled();
  });

  it('still honours a redeemed code with no account at all', async () => {
    const store = await storeWithGrant({ code: 'X', grantedAt: NOW, expiresAt: null });
    const result = await resolveEntitlement(
      { store, supabase: noSupabase },
      request(deviceHeader),
      NOW,
    );

    expect(result).toEqual({ plus: true, source: 'code', expiresAt: null });
  });

  it('reports an expired code as free', async () => {
    const store = await storeWithGrant({ code: 'X', grantedAt: NOW - 10, expiresAt: NOW - 1 });
    const result = await resolveEntitlement(
      { store, supabase: noSupabase },
      request(deviceHeader),
      NOW,
    );

    expect(result.plus).toBe(false);
  });

  it('prefers the subscription label but keeps the later expiry when both apply', async () => {
    const codeExpiry = NOW + 90 * 86_400_000;
    const store = await storeWithGrant({ code: 'X', grantedAt: NOW, expiresAt: codeExpiry });
    const supabase = supabaseReturning({
      user_id: 'user-1',
      plan: 'plus',
      expires_at: new Date(NOW + 86_400_000).toISOString(),
    });
    const result = await resolveEntitlement(
      { store, supabase },
      request({ ...deviceHeader, ...authHeader }),
      NOW,
    );

    expect(result.source).toBe('subscription');
    expect(result.expiresAt).toBe(codeExpiry);
  });

  it('parses only a well-formed Bearer header', async () => {
    const supabase = supabaseReturning({ user_id: 'user-1', plan: 'plus', expires_at: null });
    const result = await resolveEntitlement(
      { store: emptyStore(), supabase },
      request({ ...deviceHeader, authorization: 'token-abc' }),
      NOW,
    );

    expect(supabase.subscriptionForToken).not.toHaveBeenCalled();
    expect(result.plus).toBe(false);
  });
});
