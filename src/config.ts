import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export interface Config {
  apifyToken: string;
  apifyInstagramActor: string;
  apifyTiktokActor: string;
  /**
   * Whether to ask the TikTok actor for native subtitles (captions) only, with
   * no AI speech-to-text. Native subtitles are billed at the flat per-video rate;
   * AI transcription of subtitle-less videos is billed per audio-minute. Keeping
   * this on avoids that cost wildcard in early access. Flip via env to enable a
   * transcribe-capable actor later.
   */
  apifyTiktokNativeSubtitlesOnly: boolean;
  geminiApiKey: string;
  geminiModel: string;
  /**
   * Pexels key for recipe photo backfill (`/image-search`). Optional: empty just
   * disables backfill, and recipes save without a photo. Lives here rather than
   * in the app because `EXPO_PUBLIC_*` vars are inlined into the JS bundle and
   * extractable from the APK.
   */
  pexelsApiKey: string;
  /**
   * USDA FoodData Central key for the nutrition cross-check (`/nutrition`).
   * Optional: empty falls back to USDA's shared `DEMO_KEY`, which is rate-limited
   * across every caller using it, so set a real one in production. Server-side
   * for the same reason as `pexelsApiKey`.
   */
  usdaApiKey: string;
  port: number;
  /**
   * Shared secret the app sends as `x-morsel-app-key`. When set, the backend
   * rejects `/extract` and `/improve` calls that don't present it — a lightweight
   * guardrail against random callers running up Apify/Gemini spend. Empty disables
   * the check (fine for local dev); set it in any deployed environment.
   */
  appSharedSecret: string;
  /**
   * Upstash Redis REST credentials backing the rate limit, the per-device quota
   * and the extraction cache. Empty falls back to an in-memory store, which is
   * fine locally but resets on every cold start — set both in production.
   */
  upstashUrl: string;
  upstashToken: string;
  /**
   * AI extractions one install may make per calendar month. Mirrors
   * `FREE_AI_EXTRACTION_LIMIT` in the app (`Morsel/lib/pricing/data.ts`); only
   * Instagram/TikTok links count, web & blog imports are unlimited.
   *
   * This is the **free** cap. An install gets `plusDeviceExtractionLimit`
   * instead when it holds a redeemed Plus code *or* the signed-in caller has an
   * active RevenueCat subscription - both resolved in `lib/entitlement.ts` from
   * records this server wrote, never from a client-supplied plan claim, which is
   * forgeable.
   */
  monthlyDeviceExtractionLimit: number;
  /**
   * The same allowance for an install with an active Plus grant. Mirrors
   * `PLUS_AI_EXTRACTION_LIMIT` in the app (`Morsel/lib/pricing/data.ts`).
   */
  plusDeviceExtractionLimit: number;
  /**
   * Codes that redeem Morsel Plus, comma-separated. There is no database here,
   * so the issued list lives in the environment and redemption *state* lives in
   * the store - adding or revoking a code is an env edit plus a redeploy.
   *
   * Empty disables redemption. Issue high-entropy codes only: the store fails
   * open, so a short guessable code is a real risk even with the per-install
   * attempt limiter in `routes/redeem.ts`.
   */
  plusRedeemCodes: string[];
  /**
   * How long a redeemed grant lasts, in days. 0 (the default) means it never
   * expires. Applied at redemption time, so changing it does not affect grants
   * that were already claimed.
   */
  plusGrantDays: number;
  /**
   * Service-wide AI extractions per day. On the free Apify/Gemini tiers this is
   * not a bill guard (neither can overspend) but an **availability** guard: it
   * rations a fixed monthly allowance so we can't burn it in the first week and
   * leave everyone without extraction. See server/README.md for the sizing math.
   */
  globalDailyExtractionLimit: number;
  /** Per-IP fixed-window rate limit on the protected routes. */
  ipRateLimitMax: number;
  ipRateLimitWindowMs: number;
  /**
   * How long a successful extraction is reused for the same post. Keyed on the
   * post's canonical id, so every way a link gets shared hits one entry.
   *
   * Long by design: recipe text never goes stale and storage is not a
   * constraint (256 MB holds ~128k recipes). The one thing that does decay is
   * the photo - Instagram/TikTok image URLs are time-signed and eventually
   * 404 - but the app falls back to a Pexels image when a download fails.
   */
  extractCacheTtlDays: number;
  /**
   * Supabase project URL. Empty disables account-based entitlements entirely:
   * the server still serves everyone, still honours redeem codes, and simply
   * never sees a subscription - which is the correct local-dev default.
   */
  supabaseUrl: string;
  /**
   * Public anon key. Safe to hold (the app ships it too) *only* because RLS is
   * enabled on every table - see `supabase/001_subscriptions.sql`. Used to read
   * an entitlement while presenting the caller's own JWT, so Postgres does the
   * verifying and the scoping.
   */
  supabaseAnonKey: string;
  /**
   * Service role key. **Bypasses RLS.** Server-only: never prefix it
   * `EXPO_PUBLIC_`, never put it in `eas.json`, never read it from app code -
   * `EXPO_PUBLIC_*` vars are inlined into the JS bundle and extractable from the
   * shipped AAB. Only the RevenueCat webhook path uses it.
   */
  supabaseServiceRoleKey: string;
  /**
   * Shared secret RevenueCat sends in the `Authorization` header of its webhook.
   * Unlike `appSharedSecret`, an empty value here **rejects everything** rather
   * than disabling the check: this endpoint decides who has paid, so failing
   * open would make it a public "grant me Plus" button.
   */
  revenueCatWebhookSecret: string;
  /**
   * The entitlement identifier that means Plus, spelled exactly as it is in the
   * RevenueCat dashboard. Mirrors `ENTITLEMENTS.plus` in the app
   * (`Morsel/lib/purchases/config.ts`); a mismatch means webhooks arrive, get
   * logged, and grant nobody anything.
   */
  revenueCatEntitlementId: string;
}

/** Reads a positive integer env var, falling back when unset or malformed. */
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Same, but allows 0 (used by `PLUS_GRANT_DAYS`, where 0 means "never expires"). */
function nonNegativeFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Reads a comma-separated list, normalized the same way the redeem route
 * normalizes what a user types - otherwise a code pasted with a stray dash or
 * in lower case would never match its env entry.
 */
function codeListFromEnv(name: string): string[] {
  const raw = process.env[name] ?? '';
  const codes = raw
    .split(',')
    .map((code) => normalizeRedeemCode(code))
    .filter((code) => code.length > 0);
  return [...new Set(codes)];
}

/**
 * Canonical form of a redeem code: upper case, with everything that isn't a
 * letter or digit stripped. Users retype codes with spaces and hyphens, and the
 * comparison has to be against one stable form on both sides.
 */
export function normalizeRedeemCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function loadConfig(): Config {
  return {
    apifyToken: required('APIFY_TOKEN'),
    apifyInstagramActor: process.env.APIFY_INSTAGRAM_ACTOR ?? 'apify~instagram-scraper',
    apifyTiktokActor: process.env.APIFY_TIKTOK_ACTOR ?? 'clockworks~free-tiktok-scraper',
    apifyTiktokNativeSubtitlesOnly: process.env.APIFY_TIKTOK_NATIVE_SUBTITLES_ONLY !== 'false',
    geminiApiKey: required('GEMINI_API_KEY'),
    geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    pexelsApiKey: process.env.PEXELS_API_KEY ?? '',
    usdaApiKey: process.env.USDA_API_KEY ?? '',
    port: Number(process.env.PORT ?? 3000),
    appSharedSecret: process.env.APP_SHARED_SECRET ?? '',
    upstashUrl: process.env.UPSTASH_REDIS_REST_URL ?? '',
    upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN ?? '',
    monthlyDeviceExtractionLimit: numberFromEnv('MONTHLY_DEVICE_EXTRACTION_LIMIT', 30),
    plusDeviceExtractionLimit: numberFromEnv('PLUS_DEVICE_EXTRACTION_LIMIT', 200),
    plusRedeemCodes: codeListFromEnv('PLUS_REDEEM_CODES'),
    plusGrantDays: nonNegativeFromEnv('PLUS_GRANT_DAYS', 0),
    globalDailyExtractionLimit: numberFromEnv('GLOBAL_DAILY_EXTRACTION_LIMIT', 50),
    ipRateLimitMax: numberFromEnv('IP_RATE_LIMIT_MAX', 30),
    ipRateLimitWindowMs: numberFromEnv('IP_RATE_LIMIT_WINDOW_MS', 60_000),
    extractCacheTtlDays: numberFromEnv('EXTRACT_CACHE_TTL_DAYS', 365),
    supabaseUrl: process.env.SUPABASE_URL ?? '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    revenueCatWebhookSecret: process.env.REVENUECAT_WEBHOOK_SECRET ?? '',
    revenueCatEntitlementId: process.env.REVENUECAT_ENTITLEMENT_ID ?? 'Morsel Plus',
  };
}
