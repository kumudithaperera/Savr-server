import { monthKey } from './period.js';
import type { Store } from './store.js';

/**
 * Monthly counters for every AI call the server makes, and for every call one
 * of the caches saved. Read by `/health`, so a cost change shows up as numbers
 * rather than as a guess. Recipe tags never cost a call of their own: they
 * come from an extraction or moderation answer (`facetsFromExtraction`,
 * `facetsReused`, `facetsCacheHit`) or from rules (`facetsFromRules`).
 *
 * Calls = requests actually sent to a model. Saves = a request that would have
 * been sent before the caches existed.
 */
export const AI_CALLS = ['geminiText', 'geminiVideo', 'deepseek', 'moderate', 'improve', 'foodProfile'] as const;
export const AI_SAVES = [
  'jsonLdParse',
  'extractNegativeHit',
  'facetsFromExtraction',
  'facetsCacheHit',
  'facetsReused',
  'facetsFromRules',
  'moderateCacheHit',
  'moderateBodySkipped',
  'improveCacheHit',
  'foodProfileCacheHit',
] as const;
export type AiStat = (typeof AI_CALLS)[number] | (typeof AI_SAVES)[number];

const STATS_TTL_SECONDS = 60 * 24 * 60 * 60;

export const aiStatsKey = (stat: AiStat, now: Date) => `stats:ai:${stat}:${monthKey(now)}`;

/** Counts one event. Never throws: a stats write must not fail the request. */
export async function countAi(store: Store, stat: AiStat, by = 1): Promise<void> {
  try {
    for (let i = 0; i < by; i++) await store.incrWithTtl(aiStatsKey(stat, new Date()), STATS_TTL_SECONDS);
  } catch {
    // stats are best-effort
  }
}

export async function readAiStats(
  store: Store,
  now: Date,
): Promise<{ calls: Record<string, number>; saved: Record<string, number> }> {
  const read = async (names: readonly AiStat[]) =>
    Object.fromEntries(
      await Promise.all(
        names.map(async (name) => [name, (await store.getJson<number>(aiStatsKey(name, now))) ?? 0] as const),
      ),
    );
  const [calls, saved] = await Promise.all([read(AI_CALLS), read(AI_SAVES)]);
  return { calls, saved };
}
