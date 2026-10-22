/**
 * Play Integrity attestation for the routes that spend money (MORSE-41).
 *
 * `x-morsel-device-id` and `x-morsel-app-key` are both client-supplied, so a
 * script can send any value it likes. A Play Integrity token is different: it is
 * signed by Google, and says "this is the Play-installed Morsel, on a real
 * Android device, asking about this exact request". The app requests one per
 * metered call and sends it as `x-morsel-integrity-token`; the server asks
 * Google to decode it (the `decodeIntegrityToken` API, logged in as a
 * dedicated, permissionless service account) and judges the verdict here.
 *
 * Policy - the outcome decides, not just "valid or not":
 *  - `genuine`: Google vouches for the app and the request.
 *  - `unverified`: no token (iOS, older builds), or Google couldn't judge the
 *    device (no Play Services, custom ROMs, GrapheneOS). Allowed: the per-device
 *    and global quotas stay the volume control either way.
 *  - `error`: we couldn't ask Google (outage, timeout, our own config). Fails
 *    **open** - a Google hiccup must not take extraction down.
 *  - `rejected`: an explicit "not genuine" - a forged or garbled token, a
 *    sideloaded/repackaged app, a token minted for another request or replayed
 *    late. Fails **closed** (403).
 *
 * Dependency-free on purpose (like `store.ts`): the service-account JWT is
 * signed with `node:crypto`, and Google is called with plain `fetch`.
 */

import { createHash, createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const INTEGRITY_TOKEN_HEADER = 'x-morsel-integrity-token';

/** How old a token may be. The app requests one immediately before each call. */
export const MAX_TOKEN_AGE_MS = 5 * 60_000;
/** Tolerated clock skew between the device and this server. */
const MAX_CLOCK_SKEW_MS = 60_000;
/** Google answers in well under a second; never hold a request longer than this. */
const GOOGLE_TIMEOUT_MS = 4_000;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/playintegrity';

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export type IntegrityOutcome =
  | { kind: 'genuine' }
  | { kind: 'unverified'; reason: string }
  | { kind: 'error'; reason: string }
  | { kind: 'rejected'; reason: string };

/** The parts of Google's `tokenPayloadExternal` this server reads. */
export interface IntegrityPayload {
  requestDetails?: {
    requestPackageName?: string;
    requestHash?: string;
    timestampMillis?: string;
  };
  appIntegrity?: {
    appRecognitionVerdict?: string;
    packageName?: string;
  };
  deviceIntegrity?: {
    deviceRecognitionVerdict?: string[];
  };
}

/**
 * Binds a token to one request: the route and the install it claims to be.
 * The app computes the same value (`lib/integrity/request-hash.ts`) and passes
 * it to Play when asking for the token, so Google signs it into the verdict.
 *
 * Including the device id is what makes that header trustworthy on a genuine
 * call: a token minted for one device id fails here if it is replayed with
 * another, so a script can't rotate fresh ids to dodge the per-device quota.
 */
export function requestHashOf(path: string, deviceId: string): string {
  return createHash('sha256').update(`${path}\n${deviceId}`).digest('hex');
}

/** Judges a decoded token against the request it arrived with. Pure. */
export function judgeVerdict(
  payload: IntegrityPayload,
  expected: { packageName: string; requestHash: string; now: number },
): IntegrityOutcome {
  const details = payload.requestDetails ?? {};
  if (details.requestPackageName !== expected.packageName) {
    return { kind: 'rejected', reason: 'token was requested by another package' };
  }
  if (details.requestHash !== expected.requestHash) {
    return { kind: 'rejected', reason: 'token was minted for a different request' };
  }
  const issuedAt = Number(details.timestampMillis);
  if (!Number.isFinite(issuedAt)) {
    return { kind: 'rejected', reason: 'token has no timestamp' };
  }
  if (expected.now - issuedAt > MAX_TOKEN_AGE_MS || issuedAt - expected.now > MAX_CLOCK_SKEW_MS) {
    return { kind: 'rejected', reason: 'token is stale' };
  }

  switch (payload.appIntegrity?.appRecognitionVerdict) {
    case 'PLAY_RECOGNIZED':
      break;
    // A build Play doesn't know: sideloaded, repackaged or re-signed.
    case 'UNRECOGNIZED_VERSION':
      return { kind: 'rejected', reason: 'app is not the Play-distributed build' };
    // Google declined to judge (typically an untrusted device). Not a "no".
    default:
      return { kind: 'unverified', reason: 'app integrity was not evaluated' };
  }

  // An empty device verdict means "doesn't meet even basic integrity": rooted,
  // a custom ROM, an emulator. Honest GrapheneOS users land here too, which is
  // why it is allowed through to the quotas rather than refused.
  const device = payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];
  if (!device.includes('MEETS_DEVICE_INTEGRITY') && !device.includes('MEETS_BASIC_INTEGRITY')) {
    return { kind: 'unverified', reason: 'device integrity not met' };
  }
  return { kind: 'genuine' };
}

/** A thrown failure to *ask* Google, as opposed to Google saying no. */
class IntegrityUnavailable extends Error {}

export interface PlayIntegrityClient {
  /**
   * Decodes a token. Resolves `null` when Google rejects the token itself
   * (malformed, forged); throws `IntegrityUnavailable` when Google can't be
   * asked.
   */
  decode(token: string): Promise<IntegrityPayload | null>;
}

const b64url = (value: unknown): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/**
 * Talks to Google as the service account. The OAuth access token lasts an hour
 * and is reused until a minute before it expires, so a decode is normally one
 * round trip, not two.
 */
export function createPlayIntegrityClient(options: {
  key: ServiceAccountKey;
  packageName: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): PlayIntegrityClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;

  async function fetchAccessToken(): Promise<string> {
    const issued = Math.floor(now() / 1000);
    const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
      iss: options.key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issued,
      exp: issued + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(options.key.private_key, 'base64url');
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!res.ok) throw new IntegrityUnavailable(`service-account login failed (${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new IntegrityUnavailable('service-account login returned no token');
    cached = { token: body.access_token, expiresAt: now() + ((body.expires_in ?? 3600) - 60) * 1000 };
    return body.access_token;
  }

  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > now()) return cached.token;
    // Concurrent requests share one login rather than each signing their own.
    pending ??= fetchAccessToken().finally(() => {
      pending = null;
    });
    return pending;
  }

  return {
    async decode(token) {
      let res: Response;
      try {
        res = await fetchImpl(
          `https://playintegrity.googleapis.com/v1/${options.packageName}:decodeIntegrityToken`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${await accessToken()}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ integrity_token: token }),
            signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
          },
        );
      } catch (err) {
        if (err instanceof IntegrityUnavailable) throw err;
        throw new IntegrityUnavailable(`could not reach Google: ${(err as Error).message}`);
      }
      // 400 is Google refusing the token itself - the one non-2xx that is about
      // the caller rather than us. Everything else (401/403 = our key or the
      // Play Console link, 429 = quota, 5xx) is ours to fix, so it fails open.
      if (res.status === 400) return null;
      if (res.status === 401) cached = null;
      if (!res.ok) throw new IntegrityUnavailable(`decodeIntegrityToken answered ${res.status}`);
      const body = (await res.json()) as { tokenPayloadExternal?: IntegrityPayload };
      return body.tokenPayloadExternal ?? null;
    },
  };
}

export interface IntegrityChecker {
  check(token: string | undefined, path: string, deviceId: string): Promise<IntegrityOutcome>;
}

/** Turns a client + the policy above into one outcome per request. */
export function createIntegrityChecker(options: {
  client: PlayIntegrityClient;
  packageName: string;
  now?: () => number;
}): IntegrityChecker {
  const now = options.now ?? Date.now;
  return {
    async check(token, path, deviceId) {
      if (!token) return { kind: 'unverified', reason: 'no integrity token' };
      let payload: IntegrityPayload | null;
      try {
        payload = await options.client.decode(token);
      } catch (err) {
        return { kind: 'error', reason: (err as Error).message };
      }
      if (!payload) return { kind: 'rejected', reason: 'Google could not decode the token' };
      return judgeVerdict(payload, {
        packageName: options.packageName,
        requestHash: requestHashOf(path, deviceId),
        now: now(),
      });
    },
  };
}

/**
 * Reads the service-account key Render mounts as a Secret File. Returns null
 * (attestation off) when no path is configured, and throws when one is but the
 * file is missing or isn't a service-account key - a typo there must not
 * quietly leave the check disabled in production.
 */
export function loadServiceAccountKey(path: string): ServiceAccountKey | null {
  if (!path) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServiceAccountKey> & { type?: string };
  if (parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key) {
    throw new Error(`${path} is not a Google service-account key`);
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key, project_id: parsed.project_id };
}
