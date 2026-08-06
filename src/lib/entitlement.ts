/**
 * The one place that answers "does this caller have Morsel Plus?".
 *
 * There are two ways to hold it and they arrive by completely different routes:
 *
 *  - a **redeemed code**, keyed on the anonymous install id, written by
 *    `routes/redeem.ts` into the Upstash store (see `lib/grants.ts`);
 *  - a **paid subscription**, keyed on a Supabase user, written into Postgres by
 *    the RevenueCat webhook and read back through RLS with the caller's own JWT
 *    (see `lib/supabase.ts`).
 *
 * Both `GET /entitlement` and the monthly cap in `routes/extract.ts` go through
 * this function, so the answer can't drift between what the app is told and what
 * the server actually enforces - which is what happened before it existed:
 * `/entitlement` and the cap both knew about codes, neither knew about paying
 * subscribers, and anyone who bought a subscription was still metered at the free
 * 30 a month.
 *
 * Nothing here reads a plan, a user id or an entitlement flag from the request.
 * The device id selects a grant record *this server wrote*; the JWT is verified
 * by Postgres before it yields a row. A client can present both and still be told
 * it is on the free plan.
 */

import type { FastifyRequest } from 'fastify';

import { deviceIdOf, readActiveGrant } from './grants.js';
import type { Store } from './store.js';
import type { Supabase } from './supabase.js';

/** How Plus was obtained. Reported to the app for display, never for gating. */
export type EntitlementSource = 'code' | 'subscription';

export interface Entitlement {
  plus: boolean;
  /** Null when `plus` is false. */
  source: EntitlementSource | null;
  /** Epoch ms, or null for an entitlement that does not expire. */
  expiresAt: number | null;
}

export const FREE: Entitlement = { plus: false, source: null, expiresAt: null };

/**
 * The bearer token on the request, if any. Anonymous callers - the overwhelming
 * majority, since signing in is optional and only needed for Plus - send none,
 * and get an empty string, which every downstream call treats as "no account".
 */
export function bearerToken(request: FastifyRequest): string {
  const raw = request.headers.authorization;
  if (typeof raw !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : '';
}

/** Whether a subscription's expiry (ISO or null) is still in the future. */
function activeUntil(expiresAt: string | null, now: number): number | null | false {
  if (expiresAt == null) return null; // lifetime / promotional: never expires
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return false; // unparseable expiry is not an entitlement
  return ms > now ? ms : false;
}

export interface EntitlementDeps {
  store: Store;
  supabase: Supabase;
}

/**
 * Resolves the caller's entitlement from every source that can grant it.
 *
 * The two lookups are independent, so they run together - this sits in front of
 * every metered extraction and a serial Upstash-then-Supabase round trip would
 * show up as latency on the add-recipe screen.
 */
export async function resolveEntitlement(
  { store, supabase }: EntitlementDeps,
  request: FastifyRequest,
  now: number = Date.now(),
): Promise<Entitlement> {
  const token = bearerToken(request);

  const [grant, subscription] = await Promise.all([
    readActiveGrant(store, deviceIdOf(request), now),
    token ? supabase.subscriptionForToken(token) : Promise.resolve(null),
  ]);

  // A signed-in user is not a subscriber. Requiring `plan === 'plus'` rather than
  // merely a row - or merely a valid token - is what stops Plus from being free to
  // anyone with a Google account.
  const subscriptionExpiry =
    subscription && subscription.plan === 'plus' ? activeUntil(subscription.expires_at, now) : false;
  const hasSubscription = subscriptionExpiry !== false;

  if (hasSubscription) {
    // The paid entitlement wins the `source` label when someone holds both, since
    // that is the one they'd be asking support about. If they also hold a code
    // that outlasts it, report the later expiry - Plus should not appear to end
    // on a date when it doesn't.
    const codeExpiry = grant?.expiresAt ?? null;
    const later =
      subscriptionExpiry === null || codeExpiry === null
        ? null
        : Math.max(subscriptionExpiry, codeExpiry);
    return {
      plus: true,
      source: 'subscription',
      expiresAt: grant ? later : subscriptionExpiry,
    };
  }

  if (grant) return { plus: true, source: 'code', expiresAt: grant.expiresAt };

  return FREE;
}
