/**
 * One-off: copy the existing extraction cache (Upstash) into Discover's
 * `recipe_index` (Supabase), so Discover launches with every recipe extracted
 * so far rather than only the ones extracted after the feature shipped.
 *
 *   npm run backfill:discover -- --dry-run        # count only, write nothing
 *   npm run backfill:discover                     # index, no AI tagging
 *   npm run backfill:discover -- --classify 500   # then tag up to 500 rows
 *   npm run backfill:discover -- --cursor 1234    # resume a SCAN
 *
 * Idempotent: re-running upserts the same rows (tags and counters are kept).
 * Only current-version (`v2`) entries are indexed: cache keys are hashes, so
 * each entry's canonical key is recomputed from its stored `sourceUrl` and
 * kept only when it hashes back to the key it was read from. That skips
 * orphaned v1 entries and TikTok alias duplicates in one check.
 *
 * Needs: UPSTASH_REDIS_REST_URL/_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * and GEMINI_API_KEY for --classify.
 */
import 'dotenv/config';

import { createSupabaseDiscoverDb } from '../lib/discover-db.js';
import { createDiscoverIndexer } from '../lib/discover-indexer.js';
import { createStore } from '../lib/store.js';
import type { ExtractedRecipe } from '../lib/types.js';
import { canonicalCacheKey } from '../lib/url.js';
import { validateExtractedRecipe } from '../lib/validate.js';
import { cacheKey } from '../routes/extract.js';
import { createGeminiClassifier } from '../services/classify.js';
import { createSupabaseImageRehoster } from '../services/rehost.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : '';
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const dryRun = arg('dry-run') !== undefined;
const classifyLimit = Number(arg('classify') ?? 0) || 0;
let cursor = arg('cursor') || '0';

const upstashUrl = env('UPSTASH_REDIS_REST_URL').replace(/\/$/, '');
const upstashToken = env('UPSTASH_REDIS_REST_TOKEN');
const serviceRole = { url: env('SUPABASE_URL'), serviceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY') };

async function redis<T>(body: unknown, path = ''): Promise<T> {
  const response = await fetch(`${upstashUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${upstashToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`upstash ${response.status}`);
  return (await response.json()) as T;
}

const db = createSupabaseDiscoverDb(serviceRole);
const store = createStore({ upstashUrl, upstashToken });
const indexer = createDiscoverIndexer({
  db,
  store,
  // No classifier here: tagging is a separate, throttled pass (--classify).
  rehoster: createSupabaseImageRehoster({ ...serviceRole, bucket: process.env.COMMUNITY_IMAGE_BUCKET ?? 'community-images' }),
  dailyClassifyLimit: 0,
});
const log = { info: console.log, warn: console.warn };

const counts = { scanned: 0, stale: 0, invalid: 0, indexed: 0, skipped: 0 };

do {
  const { result } = await redis<{ result: [string, string[]] }>(['SCAN', cursor, 'MATCH', 'cache:extract:*', 'COUNT', 200]);
  const [next, keys] = result;
  cursor = next;
  if (keys.length > 0) {
    const values = await redis<{ result: string | null }[]>(keys.map((key) => ['GET', key]), '/pipeline');
    for (let i = 0; i < keys.length; i++) {
      counts.scanned++;
      const raw = values[i]?.result;
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      const valid = validateExtractedRecipe(parsed);
      if (!valid.success) {
        counts.invalid++;
        continue;
      }
      const recipe = parsed as ExtractedRecipe;
      const canonical = canonicalCacheKey(recipe.sourceUrl, recipe.sourcePlatform);
      if (cacheKey(canonical) !== keys[i]) {
        counts.stale++;
        continue;
      }
      if (dryRun) {
        counts.indexed++;
        continue;
      }
      if (await indexer.index(canonical, recipe, undefined, log)) counts.indexed++;
      else counts.skipped++;
    }
  }
  console.log(`cursor ${cursor} -`, JSON.stringify(counts));
} while (cursor !== '0');

if (classifyLimit > 0 && !dryRun) {
  // Re-create with a real budget for the tagging pass.
  const tagger = createDiscoverIndexer({
    db,
    store,
    classifier: createGeminiClassifier({
      geminiApiKey: env('GEMINI_API_KEY'),
      geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    }),
    rehoster: createSupabaseImageRehoster({ ...serviceRole, bucket: 'unused' }),
    dailyClassifyLimit: Number.MAX_SAFE_INTEGER,
  });
  let tagged = 0;
  while (tagged < classifyLimit) {
    const batch = await tagger.sweep(Math.min(20, classifyLimit - tagged), log);
    if (batch === 0) break;
    tagged += batch;
    console.log(`tagged ${tagged}`);
    // Stay well under Gemini's per-minute limit (see MORSE-78).
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

console.log('done', JSON.stringify(counts));
