import {
  CATEGORIES,
  type Category,
  type ExtractedRecipe,
  type Macros,
  type ParsedRecipe,
  type ScrapedPost,
  type SourcePlatform,
} from './types.js';
import { unprocessable } from './errors.js';

function toCategory(value: string | undefined): Category {
  return (CATEGORIES as readonly string[]).includes(value ?? '')
    ? (value as Category)
    : 'meals';
}

/** Clamp a macro value to a sane, non-negative, rounded number. */
function cleanMacro(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

function cleanMacros(macros: Macros | undefined): Macros {
  return {
    calories: cleanMacro(macros?.calories),
    carbs: cleanMacro(macros?.carbs),
    protein: cleanMacro(macros?.protein),
    fat: cleanMacro(macros?.fat),
  };
}

function cleanList(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

/**
 * Merges scraper + parser output into the wire `ExtractedRecipe` returned to
 * the app. Decides the macro source, validates the category, and sanitises
 * numeric/list fields. Throws 422 when there's nothing usable to save.
 */
export function normalizeRecipe(
  sourceUrl: string,
  sourcePlatform: SourcePlatform,
  scraped: ScrapedPost,
  parsed: ParsedRecipe,
): ExtractedRecipe {
  const ingredients = cleanList(parsed.ingredients);
  const steps = cleanList(parsed.steps);
  const title = parsed.title?.trim();

  if (!title || (ingredients.length === 0 && steps.length === 0)) {
    throw unprocessable('This link does not appear to contain a recipe.');
  }

  return {
    sourceUrl,
    sourcePlatform,
    title,
    imageRemoteUrl: scraped.imageUrl,
    category: toCategory(parsed.suggestedCategory),
    servings:
      typeof parsed.servings === 'number' && parsed.servings > 0
        ? Math.round(parsed.servings)
        : undefined,
    ingredients,
    steps,
    macros: cleanMacros(parsed.macros),
    macrosSource: parsed.macrosStatedInCaption ? 'caption' : 'estimated',
  };
}
