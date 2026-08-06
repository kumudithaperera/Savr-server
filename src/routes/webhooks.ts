/**
 * `POST /webhooks/revenuecat` - the only writer of subscription state.
 *
 * RevenueCat calls this whenever a subscription starts, renews, is cancelled or
 * expires. It is the piece that makes a purchase mean something on the server:
 * without it the backend knows about redeemed codes and nothing else, and a
 * paying subscriber is metered at the free 30 extractions a month.
 *
 * Three things make this endpoint safe to expose to the internet:
 *
 *  1. **It authenticates.** RevenueCat sends a value we choose in its
 *     `Authorization` header; anything else is rejected 401, compared in constant
 *     time. Unlike the app-key guardrail - which fails *open* on purpose, because
 *     a missing key there only costs us scraping budget - this fails **closed**
 *     when `REVENUECAT_WEBHOOK_SECRET` is unset. An unauthenticated route whose
 *     whole job is to decide who has paid is a "give me Plus" button.
 *  2. **It is idempotent.** Every event id is inserted into `revenuecat_events`,
 *     whose primary key rejects a redelivery. RevenueCat retries on any non-2xx,
 *     so this is not theoretical.
 *  3. **It ignores stale events.** Delivery is not ordered, so the subscription
 *     write only applies over a strictly older `event_timestamp_ms` (see
 *     `lib/supabase.ts`). A CANCELLATION overtaking the RENEWAL that superseded
 *     it must not revoke a live subscription.
 *
 * Response discipline: 2xx means "we're done with this event, stop retrying".
 * Anything we genuinely failed to store returns 500 so RevenueCat retries; an
 * event we understood and deliberately ignored returns 200.
 */

import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { Supabase, SubscriptionWrite } from '../lib/supabase.js';

/** Path is exact-matched by the guardrail's exemption - keep the two in step. */
export const REVENUECAT_WEBHOOK_PATH = '/webhooks/revenuecat';

export interface WebhookOptions {
  supabase: Supabase;
  /** Value RevenueCat is configured to send in `Authorization`. Empty = disabled. */
  webhookSecret: string;
  /** Entitlement identifier that means Plus, exactly as spelled in the dashboard. */
  entitlementId: string;
}

/** The fields we read off a RevenueCat event. Everything else is logged, not used. */
interface RevenueCatEvent {
  id?: unknown;
  type?: unknown;
  app_user_id?: unknown;
  original_app_user_id?: unknown;
  entitlement_ids?: unknown;
  entitlement_id?: unknown;
  product_id?: unknown;
  period_type?: unknown;
  store?: unknown;
  expiration_at_ms?: unknown;
  event_timestamp_ms?: unknown;
  environment?: unknown;
}

/**
 * Constant-time comparison, same reasoning as `lib/guardrail.ts`: `!==` leaks the
 * matching prefix through timing, which is enough to recover a secret byte by
 * byte. Length is compared first because `timingSafeEqual` throws on a mismatch.
 */
function secretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  // RevenueCat sends the header value verbatim, but a "Bearer " prefix typed into
  // the dashboard is an easy mistake to make and an awful one to debug.
  const value = provided.replace(/^Bearer\s+/i, '');
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * A Supabase user id, or null.
 *
 * The app calls `Purchases.logIn()` with the Supabase user id on sign-in, so a
 * subscriber's `app_user_id` is a UUID. Anything else is RevenueCat's own
 * anonymous id (`$RCAnonymousID:…`) for someone who bought before signing in -
 * there is no account to attach it to yet, and the app reconciles it by aliasing
 * on their next sign-in. The shape check also keeps a hostile value from being
 * interpolated into a PostgREST filter.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function supabaseUserId(event: RevenueCatEvent): string | null {
  for (const candidate of [event.app_user_id, event.original_app_user_id]) {
    const value = str(candidate);
    if (value && UUID.test(value)) return value;
  }
  return null;
}

/** Whether this event mentions the Plus entitlement at all. */
function grantsPlus(event: RevenueCatEvent, entitlementId: string): boolean {
  const ids = Array.isArray(event.entitlement_ids)
    ? event.entitlement_ids.filter((id): id is string => typeof id === 'string')
    : [];
  const single = str(event.entitlement_id); // deprecated by RevenueCat, still sent
  return ids.includes(entitlementId) || single === entitlementId;
}

/**
 * Event types that end access immediately, regardless of the expiry on the event.
 *
 * `CANCELLATION` is deliberately **not** here: cancelling turns off auto-renewal
 * but the subscriber keeps what they paid for until the period ends. Revoking on
 * cancellation would take Plus away from someone who is still owed it.
 */
const REVOKING_TYPES = new Set(['EXPIRATION', 'SUBSCRIPTION_PAUSED', 'TRANSFER']);
/** Types after which auto-renewal is off, even though access may continue. */
const NON_RENEWING_TYPES = new Set(['CANCELLATION', 'EXPIRATION', 'SUBSCRIPTION_PAUSED']);

export function registerRevenueCatWebhook(app: FastifyInstance, options: WebhookOptions): void {
  const { supabase, webhookSecret, entitlementId } = options;

  app.post<{ Body: { event?: RevenueCatEvent } }>(REVENUECAT_WEBHOOK_PATH, async (request, reply) => {
    if (!webhookSecret) {
      // Fail closed. A deploy that forgot the secret should look broken in the
      // RevenueCat dashboard's delivery log, not quietly accept anything.
      request.log.error('revenuecat webhook: REVENUECAT_WEBHOOK_SECRET is unset, rejecting');
      return reply.status(401).send({ code: 'unauthorized' });
    }
    if (!secretMatches(request.headers.authorization, webhookSecret)) {
      request.log.warn({ ip: request.ip }, 'revenuecat webhook: bad authorization');
      return reply.status(401).send({ code: 'unauthorized' });
    }

    const event = request.body?.event;
    if (!event || typeof event !== 'object') {
      return reply.status(400).send({ code: 'bad_request' });
    }

    const id = str(event.id);
    const type = str(event.type) ?? 'UNKNOWN';
    const eventMs = num(event.event_timestamp_ms) ?? Date.now();
    if (!id) {
      // No id means no idempotency key, so there is no safe way to apply it.
      request.log.warn({ type }, 'revenuecat webhook: event without an id');
      return reply.status(400).send({ code: 'bad_request' });
    }

    if (!supabase.canWrite) {
      request.log.error('revenuecat webhook: Supabase is not configured for writes');
      return reply.status(500).send({ code: 'not_configured' });
    }

    // Log first: the event is recorded whether or not it changes an entitlement,
    // so there is an audit trail for the one system that decides who has paid.
    // Only the type and id are logged to our own logger - the body can carry
    // store receipts and is kept in Postgres, not in Render's log stream.
    const outcome = await supabase.recordEvent({
      id,
      type,
      app_user_id: str(event.app_user_id),
      event_timestamp_ms: eventMs,
      payload: request.body,
    });

    if (outcome === 'duplicate') {
      request.log.info({ id, type }, 'revenuecat webhook: duplicate delivery ignored');
      return { status: 'duplicate' };
    }
    if (outcome === 'failed') {
      // Couldn't even record it - ask for a retry rather than silently dropping
      // a purchase.
      request.log.error({ id, type }, 'revenuecat webhook: could not record event');
      return reply.status(500).send({ code: 'store_failed' });
    }

    // RevenueCat's dashboard "send test event" button, and events for entitlements
    // we don't sell. Understood and deliberately ignored - 200 so it stops.
    if (type === 'TEST') return { status: 'ok', applied: false, reason: 'test_event' };
    if (!grantsPlus(event, entitlementId)) {
      request.log.info({ id, type }, 'revenuecat webhook: event is not for the Plus entitlement');
      return { status: 'ok', applied: false, reason: 'other_entitlement' };
    }

    const userId = supabaseUserId(event);
    if (!userId) {
      // An anonymous RevenueCat id: bought before signing in. Nothing to attach it
      // to yet; the app aliases the purchase onto the account at next sign-in and
      // RevenueCat re-sends the state then. Recorded above, so it isn't lost.
      request.log.info(
        { id, type, appUserId: str(event.app_user_id) },
        'revenuecat webhook: no Supabase user on this event, entitlement not applied',
      );
      return { status: 'ok', applied: false, reason: 'anonymous_user' };
    }

    const expirationMs = num(event.expiration_at_ms);
    const revoked = REVOKING_TYPES.has(type);
    // Expiry decides access; the event type only forces it off early. A null
    // expiry is a lifetime/promotional entitlement, which is active, not expired.
    const stillEntitled = !revoked && (expirationMs == null || expirationMs > Date.now());

    const row: SubscriptionWrite = {
      user_id: userId,
      plan: stillEntitled ? 'plus' : 'free',
      entitlement_id: entitlementId,
      store: str(event.store),
      product_id: str(event.product_id),
      period_type: str(event.period_type),
      expires_at: expirationMs == null ? null : new Date(expirationMs).toISOString(),
      will_renew: stillEntitled && !NON_RENEWING_TYPES.has(type),
      last_event_ms: eventMs,
      last_event_type: type,
    };

    const applied = await supabase.applySubscription(row);
    request.log.info(
      { id, type, plan: row.plan, applied },
      applied
        ? 'revenuecat webhook: subscription updated'
        : 'revenuecat webhook: superseded by a newer event, not applied',
    );

    // `applied: false` here means a newer event already won, which is a correct
    // outcome - a retry would change nothing, so this is still a 200.
    return { status: 'ok', applied };
  });
}
