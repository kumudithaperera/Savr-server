/**
 * Open Food Facts (OFF) lookup - the primary source for *branded* ingredients
 * in the nutrition cross-check, with USDA FoodData Central as the generic
 * fallback.
 *
 * OFF trades USDA's curated generic rows for real crowd-sourced product labels:
 * a packaged food ("Barilla spaghetti", "Tesco baked beans") has label values
 * straight off the packet, which is exactly the accuracy a free-text brand name
 * wants. It is deliberately NOT a replacement for USDA - generic ingredients
 * never touch OFF (see `createBrandFirstNutritionLookup()` in nutrition.ts),
 * and a search that can't confirm the brand falls back to the USDA generic
 * value the app has always used.
 *
 * The OFF data is a live JSON API (no key), with one etiquette rule for read
 * calls: every request identifies the app with a `User-Agent` in OFF's required
 * `AppName/Version (ContactEmail)` form (see the API's Authentication
 * section). The contact email is injected per environment so OFF's operators
 * can reach us about misbehaving traffic instead of banning an IP; it lives in
 * `deps.contactEmail`, never the bundle. Three things otherwise shape it:
 *
 *  - A "branded" query carries the brand name in the ingredient text, and we
 *    pass those tokens in. Candidates whose `brands` field confirms one of
 *    them are ranked first, and the search returns null rather than a
 *    mismatched product, so an ingredient OFF can't confidently place becomes
 *    a USDA lookup instead of a wrong answer.
 *  - OFF reports sodium (and salt) in *grams*, where the app's `FoodMicros`
 *    uses milligrams, and doesn't reliably carry vitamins or other minerals, so
 *    those micros come back zero and the breakdown UI omits them.
 *
 * Data is ODbL-licensed: the "Open Food Facts" credit the app shows next to
 * USDA is what satisfies its attribution requirement.
 */

import { upstreamError } from '../lib/errors.js';
import { brandTokens } from './brand.js';
import type { NutritionLookup } from './nutrition.js';
import type { FoodMicros, FoodNutrition } from './nutrition.js';

const OFF_SEARCH = 'https://search.openfoodfacts.org/search';
const OFF_APP_NAME = 'Morsel';
const OFF_APP_VERSION = '1.0';
/** How many candidates to fetch. Hits are ranked by OFF, and we re-rank by completeness. */
const OFF_PAGE_SIZE = 8;

export interface OffLookupDeps {
  /**
   * Off-app contact address, sent in the `User-Agent` as OFF's Authentication
   * section requires (`AppName/Version (ContactEmail)`). Read calls need no
   * credential, but a missing email violates the etiquette and risks an IP ban.
   * Empty here, for local dev only, falls back to a descriptive non-email id
   * and logs a warning.
   */
  contactEmail?: string;
  /** Injectable so the service can be unit-tested without network. */
  fetchImpl?: typeof fetch;
}

export interface OffLookup {
  /** Best-matching product's per-100 g nutrition, or null when nothing usable matched. */
  search(query: string, options?: OffSearchOptions): Promise<FoodNutrition | null>;
}

/** Options narrowing an OFF search to a specific product the query named. */
export interface OffSearchOptions {
  /** Brand tokens detected in the ingredient text; candidates must carry one. */
  brandTokens?: string[];
}

interface OffHit {
  product?: OffProduct;
  product_name?: string;
  completeness?: number;
  nutriments?: OffNutriments;
}

interface OffProduct {
  product_name?: string;
  /** OFF brands the product is filed under; an array per hit in search-a-licious. */
  brands?: string | string[];
  completeness?: number;
  nutriments?: OffNutriments;
}

/** OFF nutriments are `{ "<field>_100g": number, ... }`; values are per 100 g. */
type OffNutriments = Record<string, number | string | undefined>;

function readAmount(n: OffNutriments | undefined, field: string): number {
  const value = n?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** OFF's own 0-1 data-quality score; prefer the most complete match. */
function completenessOf(product: OffProduct): number {
  return typeof product.completeness === 'number' ? product.completeness : 0;
}

/** kcal per 100 g: OFF tags it `energy-kcal_100g`, falling back to kJ ÷ 4.184. */
function caloriesOf(product: OffProduct): number {
  const kcal = readAmount(product.nutriments, 'energy-kcal_100g');
  return kcal > 0 ? kcal : readAmount(product.nutriments, 'energy_100g') / 4.184;
}

/**
 * Sodium in OFF is stored in grams (often under `sodium_100g`, otherwise derived
 * from salt: NaCl is 40% sodium by weight). Convert to the app's milligrams.
 */
function sodiumMgOf(product: OffProduct): number {
  const sodium = readAmount(product.nutriments, 'sodium_100g');
  const salt = readAmount(product.nutriments, 'salt_100g');
  return (sodium > 0 ? sodium : salt * 0.4) * 1000;
}

function toNutrition(product: OffProduct): FoodNutrition {
  const n = product.nutriments ?? {};
  const macros = {
    caloriesPer100g: Math.round(caloriesOf(product)),
    proteinPer100g: readAmount(n, 'proteins_100g'),
    carbsPer100g: readAmount(n, 'carbohydrates_100g'),
    fatPer100g: readAmount(n, 'fat_100g'),
  };

  // Only what OFF actually carries; everything else stays zero so the app's
  // micronutrient breakdown simply doesn't list it.
  const micros: FoodMicros = {
    fiberG: readAmount(n, 'fiber_100g'),
    sugarsG: readAmount(n, 'sugars_100g'),
    sodiumMg: sodiumMgOf(product),
    potassiumMg: 0,
    calciumMg: 0,
    ironMg: 0,
    magnesiumMg: 0,
    zincMg: 0,
    saturatedFatG: readAmount(n, 'saturated-fat_100g'),
    monounsaturatedFatG: 0,
    polyunsaturatedFatG: 0,
    cholesterolMg: 0,
    vitaminCMg: 0,
    vitaminARaeUg: 0,
    vitaminDUg: 0,
  };

  return { macros, micros };
}

/**
 * Fixes up a free-text food name for OFF's search. Much of it is permissive, but
 * collapsing whitespace keeps multi-word ingredient lines tidy and slashes are
 * swapped for spaces so an ingredient like "oil/butter mix" can't 400 the query.
 */
function sanitizeQuery(query: string): string {
  return query.replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * True when the product's brand matches one of the tokens the caller detected
 * in the ingredient text. `brands` in a search-a-licious hit is an array
 * (`["Barilla", "BARILLA NORGE AS"]`), so tokens are matched individually and
 * folding case - this keeps "Barilla" hitting "barilla" and vice versa.
 */
function matchesBrand(product: OffProduct, brandTokens: readonly string[]): boolean {
  const brands = (Array.isArray(product.brands) ? product.brands : [product.brands])
    .join(' ')
    .toLowerCase();
  return brandTokens.some((brand) => brands.split(/\s+/).includes(brand.toLowerCase()));
}

/**
 * Builds the OFF lookup. When `options.brandTokens` is given, the caller has
 * decided this ingredient names a specific product, so:
 *
 *  - candidates are narrowed to products whose brand confirms one of the
 *    tokens, then ranked by completeness;
 *  - if no candidate carries the brand, the search returns null instead of
 *    some other brand's lookalike, so the combined lookup falls through to a
 *    USDA generic - the "if OFF can't identify it, use USDA" fail-safe.
 *
 * With no brand tokens this degrades to a plain ranked search, but in practice
 * the combined lookup never routes a generic ingredient here at all.
 */
export function createOpenFoodFactsLookup(deps: OffLookupDeps = {}): OffLookup {
  const userAgent = deps.contactEmail
    ? `${OFF_APP_NAME}/${OFF_APP_VERSION} (${deps.contactEmail})`
    : `${OFF_APP_NAME}/${OFF_APP_VERSION} (no-contact-email)`;
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    async search(query: string, options?: OffSearchOptions): Promise<FoodNutrition | null> {
      const clean = sanitizeQuery(query);
      if (!clean) return null;

      const url =
        `${OFF_SEARCH}?q=${encodeURIComponent(clean)}` +
        `&page_size=${OFF_PAGE_SIZE}` +
        `&fields=${encodeURIComponent('product_name,brands,nutriments,completeness,code')}`;

      let response: Response;
      try {
        response = await fetchImpl(url, { headers: { 'User-Agent': userAgent } });
      } catch {
        throw upstreamError('Could not reach Open Food Facts. Please try again.');
      }
      if (!response.ok) return null;

      const body = (await response.json()) as { hits?: OffHit[] };
      const products = (body.hits ?? []).map((hit) => hit.product ?? hit);
      if (products.length === 0) return null;

      const branded = options?.brandTokens?.length
        ? products.filter((p) => matchesBrand(p, options!.brandTokens!))
        : products;
      if (branded.length === 0) return null;

      // Prefer the most complete product that actually reports calories: OFF's
      // first hit can be a sparse entry (<0.4 completion) where the runner-up
      // carries a full label. Only fat/protein-reported foods without calories
      // are excluded the same way USDA's "pick the food with calories" does.
      const usable = branded
        .filter((p) => caloriesOf(p) > 0)
        .sort((a, b) => completenessOf(b) - completenessOf(a))[0];

      return usable ? toNutrition(usable) : null;
    },
  };
}