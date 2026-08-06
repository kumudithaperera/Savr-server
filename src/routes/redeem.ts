import type { FastifyInstance } from 'fastify';

import { normalizeRedeemCode } from '../config.js';
import { resolveEntitlement } from '../lib/entitlement.js';
import { badRequest, codeAlreadyUsed, invalidCode, rateLimited } from '../lib/errors.js';
import {
  codeClaimKey,
  deviceIdOf,
  grantKey,
  type CodeClaim,
  type PlusGrant,
} from '../lib/grants.js';
import type { Store } from '../lib/store.js';
import type { Supabase } from '../lib/supabase.js';

/**
 * Registers `POST /redeem` and `GET /entitlement` - the free-grant path for
 * Morsel Plus, used to hand Plus to specific people without a purchase.
 *
 * Both sit behind the shared-secret guard (see `lib/guardrail.ts`); `/redeem`
 * additionally limits *failed* attempts, because the global 30-req/minute IP
 * limit is far too loose to stop someone walking the code space. Codes must be
 * issued high-entropy - the store fails open, so the limiter is a speed bump,
 * not the only thing standing between a guess and a grant.
 */

/** Wrong codes tolerated per install and per IP before redemption locks out. */
const MAX_FAILED_ATTEMPTS = 5;
const FAILURE_WINDOW_SECONDS = 60 * 60;

const failureByDeviceKey = (deviceId: string): string => `redeem:fail:dev:${deviceId}`;
const failureByIpKey = (ip: string): string => `redeem:fail:ip:${ip}`;

export interface RedeemOptions {
  /** Codes we issued, already normalized. Empty disables redemption. */
  plusRedeemCodes: string[];
  /** Grant lifetime in days; 0 means it never expires. */
  plusGrantDays: number;
}

interface RedeemDeps {
  store: Store;
  redeem: RedeemOptions;
  /** Subscription lookup for `/entitlement`; unconfigured = codes only. */
  supabase: Supabase;
}

export function registerRedeemRoute(app: FastifyInstance, deps: RedeemDeps): void {
  const { store, redeem, supabase } = deps;
  const issued = new Set(redeem.plusRedeemCodes);

  /**
   * Whether this caller has burned through its wrong-code allowance. Read-only:
   * a check must not itself count as an attempt, or a locked-out caller could
   * never age out of the window.
   */
  async function isLockedOut(deviceId: string, ip: string): Promise<boolean> {
    const [byDevice, byIp] = await Promise.all([
      store.getJson<number>(failureByDeviceKey(deviceId)),
      store.getJson<number>(failureByIpKey(ip)),
    ]);
    return (byDevice ?? 0) >= MAX_FAILED_ATTEMPTS || (byIp ?? 0) >= MAX_FAILED_ATTEMPTS;
  }

  async function recordFailure(deviceId: string, ip: string): Promise<void> {
    await Promise.all([
      store.incrWithTtl(failureByDeviceKey(deviceId), FAILURE_WINDOW_SECONDS),
      store.incrWithTtl(failureByIpKey(ip), FAILURE_WINDOW_SECONDS),
    ]);
  }

  app.post<{ Body: { code?: unknown } }>('/redeem', async (request) => {
    const deviceId = deviceIdOf(request);
    const ip = request.ip;
    const code = normalizeRedeemCode(request.body?.code);

    if (!code) {
      throw badRequest('Enter the code you were given.');
    }

    if (await isLockedOut(deviceId, ip)) {
      throw rateLimited('Too many incorrect codes. Please try again in an hour.');
    }

    // An unset code list and a wrong code are answered identically on purpose -
    // see `invalidCode` in lib/errors.ts.
    if (!issued.has(code)) {
      await recordFailure(deviceId, ip);
      request.log.warn({ deviceId }, 'redeem: unknown code');
      throw invalidCode("That code isn't valid. Check it and try again.");
    }

    const now = Date.now();
    const expiresAt = redeem.plusGrantDays > 0
      ? now + redeem.plusGrantDays * 24 * 60 * 60 * 1000
      : null;
    const claim: CodeClaim = { deviceId, redeemedAt: now, expiresAt };

    // Atomic claim: whoever wins the SET NX owns the code.
    const won = await store.setJsonIfAbsent(codeClaimKey(code), claim, ttlFor(expiresAt, now));

    let grantedExpiry = expiresAt;
    if (!won) {
      const existing = await store.getJson<CodeClaim>(codeClaimKey(code));
      if (existing && existing.deviceId !== deviceId) {
        request.log.warn({ deviceId }, 'redeem: code already claimed by another install');
        throw codeAlreadyUsed('That code has already been used on another device.');
      }
      // Same install redeeming again (a reinstall, or a double tap). Honour the
      // original expiry rather than issuing a fresh window, so re-entering a
      // code can't be used to extend a time-limited grant indefinitely. A null
      // `existing` means the store couldn't be read - grant on the original
      // terms rather than stranding someone behind an outage.
      grantedExpiry = existing?.expiresAt ?? expiresAt;
    }

    const grant: PlusGrant = { code, grantedAt: now, expiresAt: grantedExpiry };
    await store.setJson(grantKey(deviceId), grant, ttlFor(grantedExpiry, now));

    request.log.info({ deviceId, expiresAt: grantedExpiry }, 'redeem: plus granted');
    return { plus: true, expiresAt: grantedExpiry };
  });

  // Re-checked by the app on every launch, so removing a code from the env and
  // deleting its grant key actually takes Plus away. The app keeps its stored
  // grant when this call fails, so an offline launch doesn't revoke anything.
  //
  // Answers for *both* ways of holding Plus - a redeemed code and a paid
  // subscription - by going through the same resolver the extraction cap uses,
  // so the app is never told something the server won't then enforce.
  app.get('/entitlement', async (request) => {
    const entitlement = await resolveEntitlement({ store, supabase }, request);
    return {
      plus: entitlement.plus,
      expiresAt: entitlement.expiresAt,
      source: entitlement.source,
    };
  });
}

/**
 * Key TTL for a grant: none when it never expires, otherwise long enough to
 * outlive the grant itself so a claim can't quietly evaporate and free the code
 * up again.
 */
function ttlFor(expiresAt: number | null, now: number): number | undefined {
  if (expiresAt == null) return undefined;
  const seconds = Math.ceil((expiresAt - now) / 1000);
  return Math.max(seconds, 60) + 24 * 60 * 60;
}
