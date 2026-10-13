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
  /** Direct video URL when available, for video-understanding fallback. */
  videoUrl?: string;
  /**
   * A blog's JSON-LD recipe when it is complete enough to use without any AI
   * call (`services/web.ts` `structuredRecipe`). Set only by the web scraper.
   */
  structured?: ParsedRecipe;
  /** The author's stated total time (JSON-LD `totalTime`), in minutes. */
  totalMinutes?: number;
}

/** Why the video fallback was triggered. */
export type FallbackReason =
  | 'no_caption'
  | 'insufficient_caption'
  | 'no_ingredients'
  | 'few_ingredients'
  | 'missing_quantities'
  | 'no_steps'
  | 'not_a_recipe'
  | 'low_confidence';

/** Confidence metadata for an extraction result. */
export interface ExtractionConfidence {
  /** Overall confidence score 0-1. */
  score: number;
  /** Source of this extraction (primary text parser or video fallback). */
  source: 'primary' | 'video_fallback' | 'merged';
  /** Whether video fallback was triggered. */
  fallbackTriggered: boolean;
  /** Reason fallback was triggered, if applicable. */
  fallbackReason?: FallbackReason;
}

/** Structured result returned by the LLM parsing step. */
export interface ParsedRecipe {
  /**
   * Whether the source text actually contained a recipe. The parser is told to
   * set this false and return empty fields rather than improvise, so a caption
   * that merely *names* a dish can't become an invented recipe that then gets
   * cached for a year and served to everyone. Optional so a response from an
   * older parser still normalizes.
   */
  isRecipe?: boolean;
  title: string;
  servings?: number;
  ingredients: string[];
  steps: string[];
  macros: Macros;
  macrosStatedInCaption: boolean;
  suggestedCategory: Category;
  /**
   * Discover tags, returned by the same call so indexing needs no separate
   * request. Optional and untrusted: `facetsFromParsed` keeps only valid
   * values, and anything missing is left to the rules (`deriveFacets`).
   */
  dietTags?: string[];
  totalMinutes?: number;
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

/** Direction of a taste adjustment: dial an ingredient up or down. */
export type AdjustDirection = 'less' | 'more';

/** How strongly to adjust the target ingredient/dimension. */
export type AdjustAmount = 'a little' | 'moderately' | 'a lot';

/** What the user asked the AI to dial up or down (the `adjust` improve mode). */
export interface AdjustmentInput {
  /** The ingredient or flavor dimension to change, e.g. "salt" or "chili flakes". */
  target: string;
  direction: AdjustDirection;
  amount: AdjustAmount;
}

/**
 * A recipe rebalanced toward a taste adjustment, produced by the `adjust`
 * improve mode. Unlike `ImprovedRecipe` it has no title/servings - the app
 * rewrites the recipe in place and keeps the original's.
 */
export interface AdjustmentResult {
  ingredients: string[];
  steps: string[];
  macros: Macros;
  /** One-line note describing what changed vs the original. */
  summary: string;
}
