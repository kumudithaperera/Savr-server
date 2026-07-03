/**
 * Shared domain types for the extraction backend.
 * These mirror the app-side types in `Savr/lib/recipes/types.ts`.
 * Keep the two in sync when the recipe shape changes.
 */

export const CATEGORIES = ['meals', 'drinks', 'snacks', 'desserts'] as const;
export type Category = (typeof CATEGORIES)[number];

export type MacroSource = 'caption' | 'estimated';

export type SourcePlatform = 'instagram' | 'web';

export interface Macros {
  /** kcal per serving */
  calories: number;
  /** grams per serving */
  carbs: number;
  /** grams per serving */
  protein: number;
  /** grams per serving */
  fat: number;
}

/**
 * A recipe as returned by `POST /extract`. The app assigns local-only fields
 * (`id`, `imageLocalUri`, `createdAt`) when it persists the recipe.
 */
export interface ExtractedRecipe {
  sourceUrl: string;
  sourcePlatform: SourcePlatform;
  title: string;
  imageRemoteUrl?: string;
  category: Category;
  servings?: number;
  ingredients: string[];
  steps: string[];
  macros: Macros;
  macrosSource: MacroSource;
}

/** Raw data extracted from a social post by a scraper service. */
export interface ScrapedPost {
  caption: string;
  imageUrl?: string;
  ownerUsername?: string;
  shortcode?: string;
}

/** Structured result returned by the LLM parsing step. */
export interface ParsedRecipe {
  title: string;
  servings?: number;
  ingredients: string[];
  steps: string[];
  macros: Macros;
  macrosStatedInCaption: boolean;
  suggestedCategory: Category;
}
