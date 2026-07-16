/**
 * Shared domain types for the extraction backend.
 * These mirror the app-side types in `Morsel/lib/recipes/types.ts`.
 * Keep the two in sync when the recipe shape changes.
 */

export const CATEGORIES = ['meals', 'drinks', 'snacks', 'desserts'] as const;
export type Category = (typeof CATEGORIES)[number];

export type MacroSource = 'caption' | 'estimated';

export type SourcePlatform = 'instagram' | 'tiktok' | 'web';

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

/**
 * The subset of a recipe the app sends to `POST /improve`. Only the fields the
 * LLM needs to reason about — no local-only fields (id, images, timestamps).
 */
export interface RecipeInput {
  title: string;
  servings?: number;
  ingredients: string[];
  steps: string[];
  macros?: Macros;
}

/** One suggested replacement for an ingredient line. */
export interface SubstitutionOption {
  /** The replacement ingredient line, with a sensible quantity. */
  replacement: string;
  /** Short reason for the swap (dietary, allergen, pantry, etc.). */
  reason: string;
}

/** Substitution suggestions for a single original ingredient line. */
export interface Substitution {
  /** Echoes the original ingredient line verbatim so the app can match it. */
  ingredient: string;
  options: SubstitutionOption[];
}

/** Result of the `substitutes` improve mode. */
export interface SubstitutionResult {
  substitutions: Substitution[];
}

/**
 * A fully rewritten recipe produced by the `healthier` improve mode. The app
 * saves this as a new recipe (tagged as an AI variant), preserving the original.
 */
export interface ImprovedRecipe {
  title: string;
  servings?: number;
  ingredients: string[];
  steps: string[];
  macros: Macros;
  /** One-line note describing what changed vs the original. */
  summary: string;
}
