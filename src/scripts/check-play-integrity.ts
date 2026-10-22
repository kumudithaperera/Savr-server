// Checks that a Google service account can call the Play Integrity API for Morsel.
// Usage: npm run integrity:check -- <path-to-service-account.json> [packageName]
//
// Sends a deliberately fake integrity token. A 400 "invalid token" answer means the
// account, the API and the Play Console link all work; anything else says what's missing.
// Never prints the private key.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [keyPath, packageName = 'com.savr.myapp'] = process.argv.slice(2);
if (!keyPath) {
  console.error('Usage: npm run integrity:check -- <service-account.json> [packageName]');
  process.exit(1);
}

const key = JSON.parse(readFileSync(keyPath, 'utf8')) as Record<string, string>;
if (key.type !== 'service_account' || !key.private_key || !key.client_email) {
  console.error('That file is not a service-account key (expected type "service_account").');
  process.exit(1);
}
console.log(`Service account: ${key.client_email}`);
console.log(`Cloud project:   ${key.project_id}`);
console.log(`Package:         ${packageName}\n`);

const b64url = (v: unknown): string => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
  iss: key.client_email,
  scope: 'https://www.googleapis.com/auth/playintegrity',
  aud: 'https://oauth2.googleapis.com/token',
  iat: now,
  exp: now + 600,
})}`;
const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');

// 1. Log in as the service account.
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsigned}.${signature}`,
  }),
});
const tokenBody = (await tokenRes.json()) as Record<string, string>;
if (!tokenRes.ok) {
  console.log(`✗ Step 1 (log in): ${tokenRes.status} ${tokenBody.error}: ${tokenBody.error_description}`);
  console.log('  The key was rejected - it may be deleted/disabled in Google Cloud. Create a new key.');
  process.exit(1);
}
console.log('✓ Step 1 (log in as service account) worked');

// 2. Ask Play Integrity to decode a fake token.
const res = await fetch(
  `https://playintegrity.googleapis.com/v1/${packageName}:decodeIntegrityToken`,
  {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenBody.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ integrity_token: 'fake-token-for-setup-check' }),
  },
);
const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
const message = body.error?.message ?? JSON.stringify(body);

if (res.status === 400) {
  console.log('✓ Step 2 (Play Integrity API) worked - Google rejected the fake token, as expected.');
  console.log('\nSetup is ready. Real tokens from a Play-installed app will decode.');
} else if (res.status === 403 && /has not been used|disabled|SERVICE_DISABLED/i.test(message)) {
  console.log(`✗ Step 2: the Play Integrity API is not enabled in Cloud project "${key.project_id}".`);
  console.log('  Fix: Google Cloud console -> APIs & Services -> Library -> "Google Play Integrity API" -> Enable.');
} else if (res.status === 403 || res.status === 404) {
  console.log(`✗ Step 2: ${res.status} - ${message}`);
  console.log(`  Likely cause: Cloud project "${key.project_id}" is not linked to ${packageName}`);
  console.log('  in Play Console (Release -> App integrity), or the app is not on Play yet.');
} else {
  console.log(`? Step 2: unexpected ${res.status} - ${message}`);
}
