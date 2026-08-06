/**
 * Morsel Plus grants earned by redeeming a code.
 *
 * Shared by `routes/redeem.ts`, which writes them, and `routes/extract.ts`,
 * which reads them to pick the caller's monthly extraction cap. The cap is the
 * one Plus benefit that costs real money, so it is decided here from a record
 * the server wrote - never from anything the client sends.
 *
 * Two keys per redemption, because they answer different questions:
 *  - `redeem:code:<CODE>` claims the code, so it can only be used once. Written
 *    with SET NX so two devices racing on the same code can't both win.
 *  - `redeem:dev:<deviceId>` is the grant itself, looked up on every entitlement
 *    check and every metered extraction.
 *
 * Neither key has a TTL for a lifetime grant: a grant that quietly expired
 * because a counter rolled over would look identical to revocation.
 */

import type { FastifyRequest } from 'fastify';

import type { Store } from './store.js';

const DEVICE_ID_HEADER = 'x-morsel-device-id';

/** What a redeemed code records, so a second device can be turned away. */
export interface CodeClaim {
  deviceId: string;
  redeemedAt: number;
  /** Epoch ms, or null for a grant that never expires. */
  expiresAt: number | null;
}

/** The grant an install holds. */
export interface PlusGrant {
  code: string;
  grantedAt: number;
  /** Epoch ms, or null for a grant that never expires. */
  expiresAt: number | null;
}

export const codeClaimKey = (code: string): string => `redeem:code:${code}`;
export const grantKey = (deviceId: string): string => `redeem:dev:${deviceId}`;

/**
 * The calling install, as sent by the app (a hashed ANDROID_ID/IDFV).
 * Unauthenticated and therefore forgeable - it meters honest users and survives
 * a reinstall, which is the realistic abuse case. Requests without one share a
 * single bucket so an omitted header is not a free pass.
 */
export function deviceIdOf(request: FastifyRequest): string {
  const raw = request.headers[DEVICE_ID_HEADER];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value.slice(0, 128) || 'unknown';
}

/** Whether a grant is still in force at `now`. */
export function isGrantActive(grant: PlusGrant | null, now: number): boolean {
  if (!grant) return false;
  return grant.expiresAt == null || grant.expiresAt > now;
}

/**
 * The install's grant, or null when it has none or it has lapsed. Expired
 * grants are reported as absent rather than deleted - the record is the only
 * evidence of what was redeemed, and a read path shouldn't mutate.
 */
export async function readActiveGrant(
  store: Store,
  deviceId: string,
  now: number,
): Promise<PlusGrant | null> {
  const grant = await store.getJson<PlusGrant>(grantKey(deviceId));
  return isGrantActive(grant, now) ? grant : null;
}
