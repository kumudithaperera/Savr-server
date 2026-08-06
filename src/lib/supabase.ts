/**
 * Supabase access for subscription state, over PostgREST with plain `fetch`.
 *
 * No client library, for the same reason `store.ts` talks to Upstash directly:
 * two REST calls do not justify a dependency, and an injected `fetch` makes the
 * whole thing testable without a network.
 *
 * There are two very different callers here, and the difference is the security
 * model:
 *
 *  - **Reading** an entitlement uses the *caller's own JWT* plus the public anon
 *    key. Postgres verifies the signature and the RLS policy scopes the result to
 *    that token's `auth.uid()`, so identity and lookup are a single call and the
 *    server never has to be told - or trust - who is asking. A forged, expired or
 *    `alg:none` token simply returns nothing. See `supabase/001_subscriptions.sql`.
 *  - **Writing** a subscription uses the service role key, which bypasses RLS.
 *    Only the RevenueCat webhook path does this. That key must never appear in
 *    anything the app can reach.
 */

import { createHash } from 'node:crypto';

import type { Store } from './store.js';

export interface SupabaseConfig {
  /** Project URL, e.g. https://abcdefgh.supabase.co. Empty disables all of this. */
  url: string;
  /** Public anon key. Shipped in the app too; safe only because RLS is on. */
  anonKey: string;
  /** Service role key. Server-only, bypasses RLS. Empty disables writes. */
  serviceRoleKey: string;
}

/** The subset of `public.subscriptions` anything here actually reads. */
export interface SubscriptionRow {
  user_id: string;
  plan: 'free' | 'plus';
  /** ISO timestamp, or null for an entitlement with no expiry (lifetime/promo). */
  expires_at: string | null;
}

/** What the webhook writes. Field-by-field, never a spread of the event body. */
export interface SubscriptionWrite {
  user_id: string;
  plan: 'free' | 'plus';
  entitlement_id: string | null;
  store: string | null;
  product_id: string | null;
  period_type: string | null;
  expires_at: string | null;
  will_renew: boolean;
  last_event_ms: number;
  last_event_type: string;
}

export interface EventWrite {
  id: string;
  type: string;
  app_user_id: string | null;
  event_timestamp_ms: number;
  payload: unknown;
}

/** Outcome of recording an event, so the route can answer RevenueCat correctly. */
export type RecordOutcome = 'recorded' | 'duplicate' | 'failed';

export interface Supabase {
  /** False when the project isn't configured; every method then no-ops safely. */
  readonly configured: boolean;
  /** Whether writes are possible (needs the service role key on top of the URL). */
  readonly canWrite: boolean;
  /**
   * The caller's own subscription, resolved from their JWT. Returns null for no
   * token, an unverifiable token, or a user with no row.
   */
  subscriptionForToken(token: string): Promise<SubscriptionRow | null>;
  /** Append-only event log. `duplicate` means this delivery was already applied. */
  recordEvent(event: EventWrite): Promise<RecordOutcome>;
  /**
   * Applies a subscription state, but only if `last_event_ms` is newer than what
   * is stored. Returns whether the write landed; false means a newer event had
   * already won, which is a success from the caller's point of view.
   */
  applySubscription(row: SubscriptionWrite): Promise<boolean>;
}

type Fetch = typeof fetch;
type Warn = (message: string) => void;

/**
 * How long a resolved entitlement is reused before asking Supabase again. Short,
 * because it delays a cancellation taking effect - but non-zero, because
 * otherwise every metered extraction pays a round trip to Supabase.
 */
const FRESH_TTL_SECONDS = 5 * 60;

/**
 * How long the same entry is *kept* so it can be served stale when Supabase is
 * unreachable. Without this, a Supabase blip silently demotes paying subscribers
 * to the free cap mid-month - the same reasoning that makes the app keep its
 * stored grant when `/entitlement` fails.
 */
const STALE_TTL_SECONDS = 24 * 60 * 60;

interface CachedEntitlement {
  row: SubscriptionRow | null;
  /** Epoch ms this was read from Supabase. */
  at: number;
}

/**
 * Cache key for a token.
 *
 * Keyed on a hash of the **whole token**, deliberately, and never on the `sub`
 * claim inside it. Reading `sub` out of an unverified JWT and using it as a cache
 * key would let anyone mint a token naming a subscriber's user id and be handed
 * that subscriber's cached entitlement - a self-grant, exactly the hole this file
 * exists to close. Hashing the token means a forged one gets its own key, misses,
 * fails verification at Postgres and caches as "no entitlement".
 *
 * Supabase access tokens rotate roughly hourly, so entries turn over on their own.
 */
function tokenKey(token: string): string {
  return `ent:tok:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
}

export function createSupabase(
  config: SupabaseConfig,
  store: Store,
  deps: { fetch?: Fetch; warn?: Warn } = {},
): Supabase {
  const doFetch = deps.fetch ?? fetch;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const base = config.url.replace(/\/$/, '');
  const configured = Boolean(base && config.anonKey);
  const canWrite = Boolean(base && config.serviceRoleKey);

  /** Headers for a service-role call. Never used on a path the app can reach. */
  const serviceHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: config.serviceRoleKey,
    authorization: `Bearer ${config.serviceRoleKey}`,
    'content-type': 'application/json',
    ...extra,
  });

  async function readFromSupabase(token: string): Promise<SubscriptionRow | null> {
    // `limit=1` is belt and braces - RLS already restricts this to one row, and
    // `user_id` is the primary key - but it keeps a policy mistake from turning
    // into a full table read.
    const url =
      `${base}/rest/v1/subscriptions` +
      `?select=user_id,plan,expires_at&limit=1`;

    const response = await doFetch(url, {
      headers: {
        apikey: config.anonKey,
        // The caller's token, forwarded untouched. Postgres verifies it; we do
        // not parse it, and nothing in it is trusted before that point.
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });

    // 401/403 is the normal answer for an expired or invalid token, not an
    // outage - it means "no entitlement", and is cached as such.
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) {
      throw new Error(`supabase read failed: ${response.status}`);
    }

    const rows = (await response.json()) as SubscriptionRow[];
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  return {
    configured,
    canWrite,

    async subscriptionForToken(token: string): Promise<SubscriptionRow | null> {
      if (!configured || !token) return null;

      const key = tokenKey(token);
      const cached = await store.getJson<CachedEntitlement>(key);
      const now = Date.now();
      if (cached && now - cached.at < FRESH_TTL_SECONDS * 1000) return cached.row;

      try {
        const row = await readFromSupabase(token);
        await store.setJson(key, { row, at: now } satisfies CachedEntitlement, STALE_TTL_SECONDS);
        return row;
      } catch (error) {
        // Serve stale rather than demote a paying subscriber because Supabase
        // blinked. With nothing cached this returns null - i.e. the free cap -
        // which is the safe direction to fail: an outage must never *grant*.
        warn(`supabase: entitlement read failed, using cached value (${String(error)})`);
        return cached?.row ?? null;
      }
    },

    async recordEvent(event: EventWrite): Promise<RecordOutcome> {
      if (!canWrite) return 'failed';
      try {
        const response = await doFetch(`${base}/rest/v1/revenuecat_events`, {
          method: 'POST',
          headers: serviceHeaders({ prefer: 'return=minimal' }),
          body: JSON.stringify({
            id: event.id,
            type: event.type,
            app_user_id: event.app_user_id,
            event_timestamp_ms: event.event_timestamp_ms,
            payload: event.payload,
          }),
        });

        // 409 = primary-key conflict = RevenueCat redelivered an event we already
        // applied. That is the idempotency guarantee working, so it is a success.
        if (response.status === 409) return 'duplicate';
        if (!response.ok) {
          warn(`supabase: event insert failed (${response.status})`);
          return 'failed';
        }
        return 'recorded';
      } catch (error) {
        warn(`supabase: event insert threw (${String(error)})`);
        return 'failed';
      }
    },

    async applySubscription(row: SubscriptionWrite): Promise<boolean> {
      if (!canWrite) return false;

      // Two steps rather than an upsert, because the write has to be conditional
      // on the incoming event being newer and PostgREST's `merge-duplicates`
      // cannot express that. RevenueCat retries and does not guarantee ordering,
      // so an old CANCELLATION arriving after the RENEWAL that superseded it must
      // not revoke a live subscription.
      try {
        // 1. Update, but only over a strictly older row.
        const patch = await doFetch(
          `${base}/rest/v1/subscriptions` +
            `?user_id=eq.${encodeURIComponent(row.user_id)}` +
            `&last_event_ms=lt.${row.last_event_ms}`,
          {
            method: 'PATCH',
            headers: serviceHeaders({ prefer: 'return=representation' }),
            body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
          },
        );
        if (patch.ok) {
          const updated = (await patch.json()) as unknown[];
          if (Array.isArray(updated) && updated.length > 0) return true;
        } else {
          warn(`supabase: subscription patch failed (${patch.status})`);
          return false;
        }

        // 2. Nothing was updated: either there is no row yet, or the stored one is
        // already newer. Try a plain insert - a 409 tells us which, without a read
        // that another delivery could invalidate between check and write.
        const insert = await doFetch(`${base}/rest/v1/subscriptions`, {
          method: 'POST',
          headers: serviceHeaders({ prefer: 'return=minimal' }),
          body: JSON.stringify(row),
        });
        if (insert.status === 409) return false; // stored row is newer; nothing to do
        if (!insert.ok) {
          warn(`supabase: subscription insert failed (${insert.status})`);
          return false;
        }
        return true;
      } catch (error) {
        warn(`supabase: subscription write threw (${String(error)})`);
        return false;
      }
    },
  };
}
