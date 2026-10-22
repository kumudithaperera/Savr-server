import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createIntegrityChecker,
  createPlayIntegrityClient,
  judgeVerdict,
  loadServiceAccountKey,
  MAX_TOKEN_AGE_MS,
  requestHashOf,
  type IntegrityPayload,
  type PlayIntegrityClient,
} from './integrity.js';

const PACKAGE = 'com.savr.myapp';
const NOW = 1_800_000_000_000;
const HASH = requestHashOf('/extract', 'device-1');

/** A verdict Google would give the Play build on a healthy phone. */
function genuinePayload(overrides: Partial<IntegrityPayload> = {}): IntegrityPayload {
  return {
    requestDetails: { requestPackageName: PACKAGE, requestHash: HASH, timestampMillis: String(NOW - 1_000) },
    appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: PACKAGE },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
    ...overrides,
  };
}

const judge = (payload: IntegrityPayload) =>
  judgeVerdict(payload, { packageName: PACKAGE, requestHash: HASH, now: NOW });

describe('requestHashOf', () => {
  it('differs per route and per device id', () => {
    expect(requestHashOf('/extract', 'a')).not.toBe(requestHashOf('/improve', 'a'));
    expect(requestHashOf('/extract', 'a')).not.toBe(requestHashOf('/extract', 'b'));
    expect(requestHashOf('/extract', 'a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the value pinned in the app test (lib/integrity/tokens.test.ts)', () => {
    expect(requestHashOf('/extract', 'device-1')).toBe('da297d3b32c4d67398f59b7031d4457624b366ffb20b2b8f8fa98ab28d3e4a80');
  });
});

describe('judgeVerdict', () => {
  it('accepts the Play build on a genuine device', () => {
    expect(judge(genuinePayload())).toEqual({ kind: 'genuine' });
  });

  it('accepts basic integrity alone', () => {
    const payload = genuinePayload({ deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] } });
    expect(judge(payload).kind).toBe('genuine');
  });

  it('rejects a token for another package', () => {
    const payload = genuinePayload({
      requestDetails: { ...genuinePayload().requestDetails, requestPackageName: 'com.evil.app' },
    });
    expect(judge(payload).kind).toBe('rejected');
  });

  it('rejects a token minted for another device id or route', () => {
    for (const requestHash of [requestHashOf('/extract', 'device-2'), requestHashOf('/improve', 'device-1')]) {
      const payload = genuinePayload({ requestDetails: { ...genuinePayload().requestDetails, requestHash } });
      expect(judge(payload).kind).toBe('rejected');
    }
  });

  it('rejects a stale token and one from the future', () => {
    for (const ts of [NOW - MAX_TOKEN_AGE_MS - 1, NOW + 5 * 60_000]) {
      const payload = genuinePayload({
        requestDetails: { ...genuinePayload().requestDetails, timestampMillis: String(ts) },
      });
      expect(judge(payload).kind).toBe('rejected');
    }
  });

  it('rejects a sideloaded or repackaged build', () => {
    const payload = genuinePayload({ appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } });
    expect(judge(payload).kind).toBe('rejected');
  });

  it('lets an unevaluated app through as unverified, not rejected', () => {
    const payload = genuinePayload({ appIntegrity: { appRecognitionVerdict: 'UNEVALUATED' } });
    expect(judge(payload).kind).toBe('unverified');
  });

  it('lets a device without integrity (custom ROM) through as unverified', () => {
    const payload = genuinePayload({ deviceIntegrity: { deviceRecognitionVerdict: [] } });
    expect(judge(payload).kind).toBe('unverified');
    expect(judge(genuinePayload({ deviceIntegrity: undefined })).kind).toBe('unverified');
  });
});

describe('createIntegrityChecker', () => {
  const client = (decode: PlayIntegrityClient['decode']) =>
    createIntegrityChecker({ client: { decode }, packageName: PACKAGE, now: () => NOW });

  it('treats a missing token as unverified without calling Google', async () => {
    const decode = vi.fn();
    expect((await client(decode).check(undefined, '/extract', 'device-1')).kind).toBe('unverified');
    expect(decode).not.toHaveBeenCalled();
  });

  it('fails open when Google is unavailable', async () => {
    const checker = client(async () => {
      throw new Error('timeout');
    });
    expect(await checker.check('tok', '/extract', 'device-1')).toEqual({ kind: 'error', reason: 'timeout' });
  });

  it('rejects a token Google could not decode', async () => {
    expect((await client(async () => null).check('tok', '/extract', 'device-1')).kind).toBe('rejected');
  });

  it('judges a decoded token against the request it came with', async () => {
    const checker = client(async () => genuinePayload());
    expect((await checker.check('tok', '/extract', 'device-1')).kind).toBe('genuine');
    expect((await checker.check('tok', '/extract', 'someone-else')).kind).toBe('rejected');
  });
});

describe('createPlayIntegrityClient', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    client_email: 'morsel-integrity@test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };

  const json = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  /** Login always succeeds; the decode call answers with `decode`. */
  function fakeGoogle(decode: () => Response | Promise<Response>) {
    return vi.fn(async (url: string | URL | Request) =>
      String(url).includes('oauth2') ? json(200, { access_token: 'access', expires_in: 3600 }) : decode(),
    ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  }

  it('logs in as the service account and returns the payload', async () => {
    const fetchImpl = fakeGoogle(() => json(200, { tokenPayloadExternal: genuinePayload() }));
    const client = createPlayIntegrityClient({ key, packageName: PACKAGE, fetchImpl });
    expect(await client.decode('tok')).toEqual(genuinePayload());

    const [loginUrl, loginInit] = fetchImpl.mock.calls[0];
    expect(String(loginUrl)).toBe('https://oauth2.googleapis.com/token');
    expect(String((loginInit as RequestInit).body)).toContain('assertion=');
    const [decodeUrl, decodeInit] = fetchImpl.mock.calls[1];
    expect(String(decodeUrl)).toBe(`https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`);
    expect((decodeInit as RequestInit).headers).toMatchObject({ authorization: 'Bearer access' });
    expect(JSON.parse(String((decodeInit as RequestInit).body))).toEqual({ integrity_token: 'tok' });
  });

  it('reuses the access token across decodes', async () => {
    const fetchImpl = fakeGoogle(() => json(200, { tokenPayloadExternal: genuinePayload() }));
    const client = createPlayIntegrityClient({ key, packageName: PACKAGE, fetchImpl });
    await Promise.all([client.decode('a'), client.decode('b')]);
    await client.decode('c');
    const logins = fetchImpl.mock.calls.filter(([url]) => String(url).includes('oauth2'));
    expect(logins).toHaveLength(1);
  });

  it('returns null when Google rejects the token itself (400)', async () => {
    const client = createPlayIntegrityClient({ key, packageName: PACKAGE, fetchImpl: fakeGoogle(() => json(400, {})) });
    expect(await client.decode('garbage')).toBeNull();
  });

  it('throws - so the caller fails open - on our own errors and outages', async () => {
    for (const status of [403, 429, 503]) {
      const client = createPlayIntegrityClient({
        key,
        packageName: PACKAGE,
        fetchImpl: fakeGoogle(() => json(status, {})),
      });
      await expect(client.decode('tok')).rejects.toThrow(String(status));
    }
    const offline = createPlayIntegrityClient({
      key,
      packageName: PACKAGE,
      fetchImpl: fakeGoogle(() => Promise.reject(new TypeError('fetch failed'))),
    });
    await expect(offline.decode('tok')).rejects.toThrow('could not reach Google');
  });

  it('throws when the service-account login is refused', async () => {
    const fetchImpl = vi.fn(async () => json(401, { error: 'invalid_grant' })) as unknown as typeof fetch;
    const client = createPlayIntegrityClient({ key, packageName: PACKAGE, fetchImpl });
    await expect(client.decode('tok')).rejects.toThrow('login failed');
  });
});

describe('loadServiceAccountKey', () => {
  const dir = mkdtempSync(join(tmpdir(), 'integrity-'));

  it('is off when no path is configured', () => {
    expect(loadServiceAccountKey('')).toBeNull();
  });

  it('reads a service-account key', () => {
    const path = join(dir, 'key.json');
    writeFileSync(path, JSON.stringify({ type: 'service_account', client_email: 'a@b', private_key: 'pem' }));
    expect(loadServiceAccountKey(path)).toMatchObject({ client_email: 'a@b', private_key: 'pem' });
  });

  it('throws on a missing file or a file that is not a key, rather than switching off', () => {
    expect(() => loadServiceAccountKey(join(dir, 'missing.json'))).toThrow();
    const path = join(dir, 'other.json');
    writeFileSync(path, JSON.stringify({ type: 'authorized_user' }));
    expect(() => loadServiceAccountKey(path)).toThrow('not a Google service-account key');
  });
});
