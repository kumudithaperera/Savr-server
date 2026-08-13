/**
 * Recipe result merger for combining primary extraction with video fallback.
 *
 * When both primary (caption) and video analysis produce results, this module
 * merges them intelligently:
 * - Uses video data for missing information
 * - Prefers explicit quantities from either source
 * - Resolves conflicts using confidence heuristics
 * - Preserves the strongest evidence from each source
 */

import type { Macros, ParsedRecipe } from './types.js';

/** Confidence weights for different sources. */
const SOURCE_WEIGHTS = {
  video: 0.7,
  primary: 0.5,
};

/**
 * Normalizes an ingredient string for comparison.
 * Strips quantities, units, and common modifiers to find matching base ingredients.
 */
function normalizeIngredient(ingredient: string): string {
  return ingredient
    .toLowerCase()
    .replace(/^\s*[\d½⅓¼⅔¾\/]+\s*/, '')
    .replace(/\b(cups?|tbsp|tsp|oz|g|kg|ml|l|lb|pounds?|ounces?|grams?|teaspoons?|tablespoons?|cloves?)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts the primary ingredient word(s) for fuzzy matching.
 * "500g chicken breast" -> "chicken", "3 cloves garlic" -> "garlic"
 */
function extractPrimaryIngredient(ingredient: string): string {
  const normalized = normalizeIngredient(ingredient);
  const words = normalized.split(' ').filter((w) => w.length > 2);
  return words[0] ?? normalized;
}

/**
 * Checks if an ingredient line has an explicit quantity.
 */
function hasExplicitQuantity(ingredient: string): boolean {
  const patterns = [
    /^\s*\d/,
    /^\s*[½⅓¼⅔¾]/,
    /\b\d+\s*(cup|tbsp|tsp|oz|g|kg|ml|l|lb)/i,
  ];
  return patterns.some((p) => p.test(ingredient));
}

/**
 * Merges two lists of ingredients, preferring versions with explicit quantities.
 * Combines unique ingredients from both sources.
 */
function mergeIngredients(primary: string[], video: string[]): string[] {
  const result: Map<string, string> = new Map();
  const primaryKeys: Map<string, string> = new Map();

  // Add primary ingredients first, tracking both full and primary keys
  for (const ing of primary) {
    const key = normalizeIngredient(ing);
    const primaryKey = extractPrimaryIngredient(ing);
    if (key) {
      result.set(key, ing);
      primaryKeys.set(primaryKey, key);
    }
  }

  // Merge video ingredients, preferring explicit quantities
  for (const ing of video) {
    const key = normalizeIngredient(ing);
    const primaryKey = extractPrimaryIngredient(ing);
    if (!key) continue;

    // Try exact match first, then primary ingredient match
    let matchKey = result.has(key) ? key : primaryKeys.get(primaryKey);

    if (!matchKey) {
      // No match - add as new ingredient
      result.set(key, ing);
      primaryKeys.set(primaryKey, key);
    } else {
      // Found a match - prefer version with explicit quantity
      const existing = result.get(matchKey);
      if (existing && hasExplicitQuantity(ing) && !hasExplicitQuantity(existing)) {
        result.delete(matchKey);
        result.set(key, ing);
        primaryKeys.set(primaryKey, key);
      }
    }
  }

  return Array.from(result.values());
}

/**
 * Normalizes a step string for comparison.
 */
function normalizeStep(step: string): string {
  return step
    .toLowerCase()
    .replace(/\d+\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)/gi, '')
    .replace(/\d+\s*(°[CF]|degrees?)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks if a step contains explicit timing or temperature.
 */
function hasExplicitDetails(step: string): boolean {
  const patterns = [
    /\d+\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)/i,
    /\d+\s*(°[CF]|degrees?)/i,
    /\b(preheat|bake|cook|simmer|boil)\s+.*\d/i,
  ];
  return patterns.some((p) => p.test(step));
}

/**
 * Merges two lists of steps.
 * Prefers steps with explicit timings/temperatures.
 * If lists differ significantly in length, prefer the more detailed one.
 */
function mergeSteps(primary: string[], video: string[]): string[] {
  if (primary.length === 0) return video;
  if (video.length === 0) return primary;

  // If one list is significantly more detailed, prefer it
  const primaryDetails = primary.filter(hasExplicitDetails).length;
  const videoDetails = video.filter(hasExplicitDetails).length;

  if (video.length > primary.length * 1.5 && videoDetails >= primaryDetails) {
    return video;
  }
  if (primary.length > video.length * 1.5 && primaryDetails >= videoDetails) {
    return primary;
  }

  // If similar length, prefer the one with more details
  if (videoDetails > primaryDetails) {
    return video;
  }
  if (primaryDetails > videoDetails) {
    return primary;
  }

  // Default to video (more likely to have complete steps from watching)
  return video.length >= primary.length ? video : primary;
}

/**
 * Merges macros, preferring caption-stated values over estimates.
 */
function mergeMacros(
  primary: Macros,
  video: Macros,
  primaryStated: boolean,
  videoStated: boolean,
): { macros: Macros; statedInCaption: boolean } {
  // Caption-stated macros are most reliable
  if (primaryStated && !videoStated) {
    return { macros: primary, statedInCaption: true };
  }
  if (videoStated && !primaryStated) {
    return { macros: video, statedInCaption: true };
  }
  if (primaryStated && videoStated) {
    // Both stated, average them
    return {
      macros: {
        calories: Math.round((primary.calories + video.calories) / 2),
        carbs: Math.round((primary.carbs + video.carbs) / 2),
        protein: Math.round((primary.protein + video.protein) / 2),
        fat: Math.round((primary.fat + video.fat) / 2),
      },
      statedInCaption: true,
    };
  }

  // Both estimated - prefer video as it analyzed more content
  return { macros: video, statedInCaption: false };
}

export interface MergeOptions {
  /** Whether to prefer video results when conflicting. Default: true */
  preferVideo?: boolean;
  /** Minimum confidence threshold for using primary result. Default: 0.5 */
  primaryConfidenceThreshold?: number;
}

/**
 * Result of merging two recipe extractions.
 */
export interface MergedRecipe extends ParsedRecipe {
  /** Confidence score of the merged result (0-1). */
  mergedConfidence: number;
  /** Which fields came primarily from video analysis. */
  videoContributions: Array<'title' | 'ingredients' | 'steps' | 'macros' | 'servings'>;
}

/**
 * Merges a primary (caption-based) extraction with a video fallback extraction.
 * Produces a combined result that preserves the best information from each.
 */
export function mergeRecipes(
  primary: ParsedRecipe | null,
  video: ParsedRecipe,
  _options: MergeOptions = {},
): MergedRecipe {
  const videoContributions: MergedRecipe['videoContributions'] = [];

  // If primary is null or not a recipe, use video entirely
  if (!primary || primary.isRecipe === false) {
    return {
      ...video,
      mergedConfidence: SOURCE_WEIGHTS.video,
      videoContributions: ['title', 'ingredients', 'steps', 'macros', 'servings'],
    };
  }

  // If video is not a recipe, use primary
  if (video.isRecipe === false) {
    return {
      ...primary,
      mergedConfidence: SOURCE_WEIGHTS.primary,
      videoContributions: [],
    };
  }

  // Merge title - prefer video if primary is empty or generic
  let title = primary.title?.trim() || video.title;
  if (!primary.title || primary.title.length < 3) {
    title = video.title;
    videoContributions.push('title');
  }

  // Merge ingredients
  const ingredients = mergeIngredients(primary.ingredients, video.ingredients);
  if (ingredients.length > primary.ingredients.length) {
    videoContributions.push('ingredients');
  }

  // Merge steps
  const steps = mergeSteps(primary.steps, video.steps);
  if (steps !== primary.steps) {
    videoContributions.push('steps');
  }

  // Merge servings - prefer explicit value
  let servings = primary.servings;
  if (!servings && video.servings) {
    servings = video.servings;
    videoContributions.push('servings');
  }

  // Merge macros
  const { macros, statedInCaption } = mergeMacros(
    primary.macros,
    video.macros,
    primary.macrosStatedInCaption,
    video.macrosStatedInCaption,
  );
  if (statedInCaption !== primary.macrosStatedInCaption || macros !== primary.macros) {
    videoContributions.push('macros');
  }

  // Category - prefer video if it analyzed more content
  const category = video.suggestedCategory || primary.suggestedCategory;

  // Calculate merged confidence
  const videoContributionRatio = videoContributions.length / 5;
  const mergedConfidence =
    SOURCE_WEIGHTS.primary * (1 - videoContributionRatio) +
    SOURCE_WEIGHTS.video * videoContributionRatio;

  return {
    isRecipe: true,
    title,
    servings,
    ingredients,
    steps,
    macros,
    macrosStatedInCaption: statedInCaption,
    suggestedCategory: category,
    mergedConfidence,
    videoContributions,
  };
}
