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
   * This is the **free** cap and currently applies to everyone: the server has
   * no notion of entitlements, so a Plus subscriber would be cut off here at 30
   * despite the plan advertising 200. That is fine only while Plus stays hidden
   * for the free-only launch. Before enabling paid tiers, verify the caller's
   * entitlement server-side with `REVENUECAT_SECRET_API_KEY` and pick the cap
   * from that - never from a client-supplied plan claim, which is forgeable.
   */
  monthlyDeviceExtractionLimit: number;
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
}

/** Reads a positive integer env var, falling back when unset or malformed. */
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
    globalDailyExtractionLimit: numberFromEnv('GLOBAL_DAILY_EXTRACTION_LIMIT', 50),
    ipRateLimitMax: numberFromEnv('IP_RATE_LIMIT_MAX', 30),
    ipRateLimitWindowMs: numberFromEnv('IP_RATE_LIMIT_WINDOW_MS', 60_000),
    extractCacheTtlDays: numberFromEnv('EXTRACT_CACHE_TTL_DAYS', 365),
  };
}
