import { CATEGORIES, type Category, type Macros } from './types.js';

/**
 * The filter model shared by Discover (`recipe_index`) and the community recipe
 * feed (`recipe_posts`): category, calories, diet tags and cook time. Every
 * value comes from macros, rules or a model call that was being made anyway
 * (`lib/facet-rules.ts`), never from a tagging request of its own.
 * Both tables carry the same facet columns, so one parser, one PostgREST
 * translation and one in-memory matcher serve both.
 */

/**
 * Older rows can still carry tags from before the lean set (keto,
 * gluten_free, ...); they are ignored on read and never filterable.
 */
export const DIET_TAGS = ['vegetarian', 'vegan', 'high_protein', 'low_carb'] as const;
export type DietTag = (typeof DIET_TAGS)[number];

/** The tags a recipe carries beyond its category and macros. */
export interface RecipeFacets {
  dietTags: DietTag[];
  totalMinutes: number | null;
}

/** The facet columns as stored, shared by both tables. */
export interface FacetColumns {
  title: string;
  category: Category;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  diet_tags: string[];
  total_minutes: number | null;
  /** Title + ingredients, lower-cased; backs the full-text column. */
  search_text: string;
}

export interface RecipeFilters {
  /** Lower-cased search words, each matched as a prefix. Empty = no text filter. */
  terms: string[];
  category: Category | null;
  diet: DietTag[];
  maxCalories: number | null;
  maxMinutes: number | null;
}

function positiveInt(raw: string | undefined, max: number): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : null;
}

/**
 * Search words: letters and digits in any script, at most six words of at most
 * 32 characters each. Everything else is dropped, so nothing the caller types
 * can reach PostgREST's filter grammar or `to_tsquery` operators.
 */
export function searchTerms(raw: string | undefined): string[] {
  if (!raw) return [];
  return (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((word) => word.slice(0, 32))
    .slice(0, 6);
}

/** Parses the shared filter query params. Unknown values are ignored, not errors. */
export function parseFilters(query: Record<string, string | undefined>): RecipeFilters {
  const diet = (query.diet ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag): tag is DietTag => (DIET_TAGS as readonly string[]).includes(tag));
  return {
    terms: searchTerms(query.q),
    category: (CATEGORIES as readonly string[]).includes(query.category ?? '')
      ? (query.category as Category)
      : null,
    diet: [...new Set(diet)],
    maxCalories: positiveInt(query.maxCalories, 9999),
    maxMinutes: positiveInt(query.maxMinutes, 1440),
  };
}

/** PostgREST query params for the filters (already URL-safe: see `searchTerms`). */
export function filterParams(filters: RecipeFilters): string[] {
  const params: string[] = [];
  if (filters.terms.length > 0) {
    const tsquery = filters.terms.map((term) => `${term}:*`).join(' & ');
    params.push(`search_tsv=fts(simple).${encodeURIComponent(tsquery)}`);
  }
  if (filters.category) params.push(`category=eq.${filters.category}`);
  if (filters.diet.length > 0) params.push(`diet_tags=cs.{${filters.diet.join(',')}}`);
  if (filters.maxCalories !== null) params.push(`calories=lte.${filters.maxCalories}`);
  if (filters.maxMinutes !== null) params.push(`total_minutes=lte.${filters.maxMinutes}`);
  return params;
}

/** The same filters in JS, for the memory implementations. Mirrors `filterParams`. */
export function matchesFilters(row: FacetColumns, filters: RecipeFilters): boolean {
  if (filters.terms.length > 0) {
    const words = row.search_text.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!filters.terms.every((term) => words.some((word) => word.startsWith(term)))) return false;
  }
  if (filters.category && row.category !== filters.category) return false;
  if (!filters.diet.every((tag) => row.diet_tags.includes(tag))) return false;
  if (filters.maxCalories !== null && row.calories > filters.maxCalories) return false;
  if (filters.maxMinutes !== null && (row.total_minutes === null || row.total_minutes > filters.maxMinutes)) {
    return false;
  }
  return true;
}

/** Facet columns for a recipe; `facets` null = not tagged yet. */
export function facetColumns(
  recipe: { title: string; category: Category; ingredients: string[]; macros: Macros },
  facets: RecipeFacets | null,
): FacetColumns {
  return {
    title: recipe.title,
    category: recipe.category,
    calories: Math.round(recipe.macros.calories),
    protein: Math.round(recipe.macros.protein),
    carbs: Math.round(recipe.macros.carbs),
    fat: Math.round(recipe.macros.fat),
    diet_tags: facets?.dietTags ?? [],
    total_minutes: facets?.totalMinutes ?? null,
    search_text: [recipe.title, ...recipe.ingredients].join(' ').toLowerCase().slice(0, 4000),
  };
}

const knownTags = (tags: string[]): DietTag[] =>
  tags.filter((tag): tag is DietTag => (DIET_TAGS as readonly string[]).includes(tag));

/** The tags already stored on a row. */
export function storedFacets(row: Pick<FacetColumns, 'diet_tags' | 'total_minutes'>): RecipeFacets {
  return { dietTags: knownTags(row.diet_tags), totalMinutes: row.total_minutes };
}

/** Columns -> the facet fields every DTO carries. */
export function facetDto(row: Omit<FacetColumns, 'search_text'>) {
  return {
    title: row.title,
    category: row.category,
    macros: { calories: row.calories, protein: row.protein, carbs: row.carbs, fat: row.fat },
    dietTags: knownTags(row.diet_tags),
    totalMinutes: row.total_minutes,
  };
}
