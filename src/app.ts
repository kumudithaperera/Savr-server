import Fastify, { type FastifyInstance } from 'fastify';

import type { InstagramScraper } from './services/apify.js';
import type { RecipeParser } from './services/gemini.js';
import type { PhotoSearch } from './services/images.js';
import type { RecipeImprover } from './services/improve.js';
import type { NutritionLookup } from './services/nutrition.js';
import type { TikTokScraper } from './services/tiktok.js';
import type { WebScraper } from './services/web.js';
import { HttpError } from './lib/errors.js';
import { createRequestGuard, DEFAULT_RATE_LIMIT, type RateLimitOptions } from './lib/guardrail.js';
import { createStore, type Store } from './lib/store.js';
import { createSupabase, type Supabase } from './lib/supabase.js';
import { registerExtractRoute, statsKey, type ExtractLimits } from './routes/extract.js';
import { registerImageSearchRoute } from './routes/images.js';
import { registerImproveRoute } from './routes/improve.js';
import { registerNutritionRoute } from './routes/nutrition.js';
import { registerRedeemRoute, type RedeemOptions } from './routes/redeem.js';
import { registerRevenueCatWebhook } from './routes/webhooks.js';

/** Limits with the same defaults as `config.ts`, so tests need not supply them. */
const DEFAULT_LIMITS: ExtractLimits = {
  monthlyDeviceExtractionLimit: 30,
  plusDeviceExtractionLimit: 200,
  globalDailyExtractionLimit: 50,
  extractCacheTtlDays: 365,
};

/** Same, for the `/improve` daily ceiling. See `config.ts` for the sizing. */
const DEFAULT_GLOBAL_DAILY_IMPROVE_LIMIT = 150;

/** No codes issued by default, so tests can't accidentally redeem one. */
const DEFAULT_REDEEM: RedeemOptions = { plusRedeemCodes: [], plusGrantDays: 0 };

export interface AppDeps {
  instagramScraper: InstagramScraper;
  tiktokScraper: TikTokScraper;
  webScraper: WebScraper;
  parser: RecipeParser;
  improver: RecipeImprover;
  /** Backs `/image-search`, holding the Pexels key the app used to ship. */
  photoSearch: PhotoSearch;
  /** Backs `/nutrition`, holding the USDA key the app used to ship. */
  nutrition: NutritionLookup;
  /** Shared secret guarding the expensive routes; empty disables the check (dev). */
  appSharedSecret: string;
  /**
   * Counter/cache backend. Omitted in tests, where each app gets its own
   * in-memory store so state can't leak between cases.
   */
  store?: Store;
  limits?: ExtractLimits;
  /**
   * Service-wide AI improvements per day (`/improve`). Separate from the
   * extraction ceiling in `limits` - see `routes/improve.ts` for why the two
   * budgets are not pooled.
   */
  globalDailyImproveLimit?: number;
  /** Issued Plus codes + grant lifetime. Omitted = redemption disabled. */
  redeem?: RedeemOptions;
  rateLimit?: RateLimitOptions;
  /**
   * Subscription state. Omitted in tests and in local dev without a Supabase
   * project: entitlements then come from redeem codes alone, which is exactly
   * how the server behaved before subscriptions existed.
   */
  supabase?: Supabase;
  /** Secret RevenueCat sends in `Authorization`. Empty = the webhook rejects all. */
  revenueCatWebhookSecret?: string;
  /** Entitlement id meaning Plus, as spelled in the RevenueCat dashboard. */
  revenueCatEntitlementId?: string;
}

/**
 * Builds the Fastify app with routes and a central error handler.
 * Dependencies are injected so the app can be tested with fakes.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  // `trustProxy` makes `request.ip` read X-Forwarded-For. Without it every user
  // behind Render's edge shares one rate-limit bucket.
  const app = Fastify({ logger: true, trustProxy: true });

  const store = deps.store ?? createStore({ upstashUrl: '', upstashToken: '' });
  const limits = deps.limits ?? DEFAULT_LIMITS;
  // Unconfigured by default: every method no-ops, so an app built without a
  // Supabase project behaves exactly as it did before subscriptions existed.
  const supabase =
    deps.supabase ??
    createSupabase({ url: '', anonKey: '', serviceRoleKey: '' }, store);

  // Shared-secret + per-IP rate limit on the expensive routes (see guardrail.ts).
  app.addHook(
    'onRequest',
    createRequestGuard(deps.appSharedSecret, store, deps.rateLimit ?? DEFAULT_RATE_LIMIT),
  );

  // `store` reports which backend is active, so a deploy can be verified from
  // outside: store calls fail open, so a misconfigured Upstash otherwise looks
  // exactly like a healthy server that happens to enforce nothing. Absent field
  // = an older build is still running. No credentials are exposed.
  //
  // `cache` is this month's hit rate. On the free Apify tier that number decides
  // how far $5 stretches: every hit is an extraction nobody paid for.
  app.get('/health', async () => {
    const now = new Date();
    const [hits, misses] = await Promise.all([
      store.getJson<number>(statsKey('hit', now)),
      store.getJson<number>(statsKey('miss', now)),
    ]);
    const hit = hits ?? 0;
    const miss = misses ?? 0;
    const total = hit + miss;
    return {
      status: 'ok',
      store: store.kind,
      cache: {
        month: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
        hits: hit,
        misses: miss,
        hitRate: total === 0 ? null : Math.round((hit / total) * 100) / 100,
      },
    };
  });

  registerExtractRoute(app, { ...deps, store, limits, supabase });
  registerImproveRoute(app, {
    ...deps,
    store,
    globalDailyImproveLimit: deps.globalDailyImproveLimit ?? DEFAULT_GLOBAL_DAILY_IMPROVE_LIMIT,
  });
  registerImageSearchRoute(app, deps);
  registerNutritionRoute(app, deps);
  registerRedeemRoute(app, { store, supabase, redeem: deps.redeem ?? DEFAULT_REDEEM });
  registerRevenueCatWebhook(app, {
    supabase,
    webhookSecret: deps.revenueCatWebhookSecret ?? '',
    entitlementId: deps.revenueCatEntitlementId ?? 'Morsel Plus',
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message });
    }
    app.log.error(error);
    return reply.status(500).send({ code: 'internal_error', message: 'Something went wrong.' });
  });

  return app;
}
