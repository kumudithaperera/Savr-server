import { createHash } from 'node:crypto';

/**
 * Keys for the caches that stand in front of AI calls. Every key is a hash of
 * exactly what the model would have been shown, so a hit can only ever return
 * the answer that same input already got. Each key carries a version: bump it
 * when the prompt or the answer's meaning changes, and old answers stop
 * matching instead of being served under new rules.
 */

export const AI_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Trimmed, lower-cased, whitespace collapsed: cosmetic edits don't miss the cache. */
function normalizeLine(line: string): string {
  return line.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Identity of a recipe's body (ingredients + steps). Two copies of the same
 * recipe hash the same even after the app's own whitespace/case handling.
 */
export function recipeBodyHash(recipe: { ingredients: readonly string[]; steps: readonly string[] }): string {
  return sha256(
    JSON.stringify([recipe.ingredients.map(normalizeLine).filter(Boolean), recipe.steps.map(normalizeLine).filter(Boolean)]),
  );
}

export function ingredientsHash(recipe: { ingredients: readonly string[] }): string {
  return sha256(JSON.stringify(recipe.ingredients.map(normalizeLine).filter(Boolean)));
}

export const facetsCacheKey = (recipe: { ingredients: readonly string[]; steps: readonly string[] }) =>
  `facets:v1:${recipeBodyHash(recipe)}`;

export const moderationCacheKey = (kind: string, text: string, imageData?: string) =>
  `mod:v1:${kind}:${sha256(`${text}\u0000${imageData ? sha256(imageData) : ''}`)}`;

export const improveCacheKey = (mode: string, payload: unknown) =>
  `improve:v1:${mode}:${sha256(JSON.stringify(payload))}`;

export const negativeExtractKey = (canonical: string) => `neg:extract:v1:${sha256(canonical)}`;

export const foodProfileCacheKey = (key: string) => `food:v1:${sha256(key)}`;
