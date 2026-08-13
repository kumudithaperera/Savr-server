/**
 * Recipe completeness validation for determining when video fallback is needed.
 *
 * The primary text-based extraction may produce incomplete results when:
 * - The recipe exists only in the video (no caption)
 * - The caption mentions the dish but doesn't list ingredients/steps
 * - Quantities are spoken but not written
 * - Key information is in on-screen text overlays
 *
 * This module provides functions to assess extraction quality and decide
 * whether to trigger the more expensive video-understanding fallback.
 */

import type { FallbackReason, ParsedRecipe, ScrapedPost } from './types.js';

/** Thresholds for completeness assessment. */
export interface CompletenessThresholds {
  /** Minimum ingredients to consider a recipe complete. */
  minIngredients: number;
  /** Minimum ratio of ingredients with quantities (e.g., "2 cups flour" vs "flour"). */
  minQuantityRatio: number;
  /** Minimum steps to consider a recipe complete. */
  minSteps: number;
  /** Minimum caption length (prose only) to attempt primary extraction. */
  minCaptionLength: number;
}

/** Default thresholds tuned for recipe extraction. */
export const DEFAULT_THRESHOLDS: CompletenessThresholds = {
  minIngredients: 2,
  minQuantityRatio: 0.3,
  minSteps: 1,
  minCaptionLength: 80,
};

/** Result of a completeness assessment. */
export interface CompletenessResult {
  /** Whether the extraction is considered complete enough to use. */
  isComplete: boolean;
  /** Confidence score 0-1 based on completeness factors. */
  confidence: number;
  /** Primary reason for incompleteness, if applicable. */
  reason?: FallbackReason;
  /** Detailed breakdown of completeness factors. */
  details: {
    hasTitle: boolean;
    ingredientCount: number;
    ingredientsWithQuantities: number;
    stepCount: number;
    captionLength: number;
    parserSaysRecipe: boolean;
  };
}

/** Regex patterns for detecting quantities in ingredient lines. */
const QUANTITY_PATTERNS = [
  /^\d/,
  /^\s*\d/,
  /^½|^⅓|^¼|^⅔|^¾/,
  /\b\d+\s*(cup|tbsp|tsp|oz|g|kg|ml|l|lb|pound|ounce|gram|teaspoon|tablespoon|pinch|dash|handful)/i,
  /\b(a|one|two|three|four|five|six|seven|eight|nine|ten)\s+(cup|tbsp|tsp|small|medium|large|handful|pinch)/i,
];

/**
 * Checks whether an ingredient line contains a quantity.
 * Examples with quantities: "2 cups flour", "1/2 tsp salt", "3 eggs"
 * Examples without: "flour", "salt to taste", "eggs"
 */
export function hasQuantity(ingredient: string): boolean {
  const normalized = ingredient.trim().toLowerCase();
  return QUANTITY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Strips hashtags, mentions, links, and emoji from caption text,
 * leaving only prose that might contain recipe content.
 */
function captionProse(caption: string): string {
  return caption
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#@][\p{L}\p{N}_.]+/gu, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Assesses whether a parsed recipe result is complete enough to use,
 * or if video fallback should be triggered.
 */
export function assessCompleteness(
  scraped: ScrapedPost,
  parsed: ParsedRecipe,
  thresholds: CompletenessThresholds = DEFAULT_THRESHOLDS,
): CompletenessResult {
  const captionLength = captionProse(scraped.caption).length;
  const ingredientCount = parsed.ingredients.length;
  const stepCount = parsed.steps.length;
  const hasTitle = Boolean(parsed.title?.trim());
  const parserSaysRecipe = parsed.isRecipe !== false;

  const ingredientsWithQuantities = parsed.ingredients.filter(hasQuantity).length;
  const quantityRatio = ingredientCount > 0 ? ingredientsWithQuantities / ingredientCount : 0;

  const details = {
    hasTitle,
    ingredientCount,
    ingredientsWithQuantities,
    stepCount,
    captionLength,
    parserSaysRecipe,
  };

  // Parser explicitly said this isn't a recipe
  if (!parserSaysRecipe) {
    return {
      isComplete: false,
      confidence: 0.1,
      reason: 'not_a_recipe',
      details,
    };
  }

  // No ingredients at all
  if (ingredientCount === 0) {
    return {
      isComplete: false,
      confidence: 0.1,
      reason: 'no_ingredients',
      details,
    };
  }

  // Very few ingredients (likely incomplete)
  if (ingredientCount < thresholds.minIngredients) {
    return {
      isComplete: false,
      confidence: 0.2,
      reason: 'few_ingredients',
      details,
    };
  }

  // No steps at all
  if (stepCount < thresholds.minSteps) {
    return {
      isComplete: false,
      confidence: 0.3,
      reason: 'no_steps',
      details,
    };
  }

  // Most ingredients lack quantities
  if (quantityRatio < thresholds.minQuantityRatio) {
    return {
      isComplete: false,
      confidence: 0.4,
      reason: 'missing_quantities',
      details,
    };
  }

  // Calculate confidence based on completeness factors
  let confidence = 0.5;
  confidence += hasTitle ? 0.1 : 0;
  confidence += Math.min(ingredientCount / 8, 0.15);
  confidence += Math.min(stepCount / 5, 0.1);
  confidence += quantityRatio * 0.1;
  confidence += Math.min(captionLength / 500, 0.05);
  confidence = Math.min(confidence, 1);

  return {
    isComplete: true,
    confidence,
    details,
  };
}

/**
 * Determines whether video fallback should be triggered based on
 * extraction result and available video URL.
 */
export function shouldTriggerFallback(
  scraped: ScrapedPost,
  parsed: ParsedRecipe,
  thresholds: CompletenessThresholds = DEFAULT_THRESHOLDS,
): { shouldFallback: boolean; reason?: FallbackReason } {
  // No video URL available, can't fall back
  if (!scraped.videoUrl) {
    return { shouldFallback: false };
  }

  // No caption at all - definitely need video
  if (!scraped.caption.trim()) {
    return { shouldFallback: true, reason: 'no_caption' };
  }

  const completeness = assessCompleteness(scraped, parsed, thresholds);

  if (!completeness.isComplete) {
    return { shouldFallback: true, reason: completeness.reason };
  }

  // Low confidence even when "complete" might benefit from video
  if (completeness.confidence < 0.6) {
    return { shouldFallback: true, reason: 'low_confidence' };
  }

  return { shouldFallback: false };
}
