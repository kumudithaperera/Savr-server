import { unprocessable, upstreamError } from '../lib/errors.js';
import { parseIsoDuration } from '../lib/facet-rules.js';
import { assertPublicUrl, dnsResolver, type HostResolver } from '../lib/public-url.js';
import type { Category, ParsedRecipe, ScrapedPost } from '../lib/types.js';

export interface WebScraper {
  scrape(url: string): Promise<ScrapedPost>;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Redirect hops followed by hand, so each hop's host is re-checked. */
const MAX_REDIRECTS = 5;
/** Recipe pages are well under this; anything bigger is not worth reading. */
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** Recursively finds the first schema.org Recipe node in parsed JSON-LD. */
function findRecipeNode(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const type = obj['@type'];
    const isRecipe = Array.isArray(type)
      ? type.includes('Recipe')
      : type === 'Recipe';
    if (isRecipe) return obj;
    // Recurse into nested containers like @graph.
    for (const value of Object.values(obj)) {
      const found = findRecipeNode(value);
      if (found) return found;
    }
  }
  return null;
}

function extractJsonLdRecipe(html: string): Record<string, unknown> | null {
  const scriptRegex =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const recipe = findRecipeNode(parsed);
      if (recipe) return recipe;
    } catch {
      // skip malformed JSON-LD blocks
    }
  }
  return null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(asString).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === 'string') return obj.url;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.name === 'string') return obj.name;
  }
  return undefined;
}

/**
 * Schema.org `Recipe.image` is commonly a single URL, an `ImageObject`, or an
 * array of either (multiple aspect ratios) - unlike other text fields, joining
 * multiple entries would produce an invalid URL, so this takes the first one.
 */
function firstImageUrl(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstImageUrl(item);
      if (url) return url;
    }
    return undefined;
  }
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.url === 'string') return obj.url;
  }
  return undefined;
}

/** Resolves a possibly relative/protocol-relative image URL against the page URL. */
function resolveImageUrl(raw: string | undefined, pageUrl: string): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, pageUrl).toString();
  } catch {
    return raw;
  }
}

/** Flattens schema.org instructions (strings or HowToStep/HowToSection). */
function flattenInstructions(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenInstructions);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.itemListElement)) return flattenInstructions(obj.itemListElement);
    if (typeof obj.text === 'string') return [obj.text];
    if (typeof obj.name === 'string') return [obj.name];
  }
  return [];
}

/** Builds a readable text blob from a JSON-LD recipe for the LLM parser. */
function recipeNodeToText(recipe: Record<string, unknown>): string {
  const lines: string[] = [];
  const name = asString(recipe.name);
  if (name) lines.push(`Title: ${name}`);
  const description = asString(recipe.description);
  if (description) lines.push(`Description: ${description}`);
  const servings = asString(recipe.recipeYield);
  if (servings) lines.push(`Servings: ${servings}`);

  const ingredients = recipe.recipeIngredient ?? recipe.ingredients;
  if (Array.isArray(ingredients)) {
    lines.push('Ingredients:');
    for (const ing of ingredients) {
      const s = asString(ing);
      if (s) lines.push(`- ${s}`);
    }
  }

  const steps = flattenInstructions(recipe.recipeInstructions);
  if (steps.length) {
    lines.push('Instructions:');
    steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }

  const nutrition = recipe.nutrition;
  if (nutrition && typeof nutrition === 'object') {
    lines.push(`Nutrition: ${JSON.stringify(nutrition)}`);
  }

  return lines.join('\n');
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

/** JSON-LD strings often carry HTML entities and stray tags; the LLM used to clean those. */
function cleanJsonLdText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:!?])/g, '$1')
    .trim();
}

/** "350 calories", "12.5 g", "12g", 12 -> 350, 12.5, 12. Null when absent or unreadable. */
function nutritionNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = /\d+(?:[.,]\d+)?/.exec(value);
  return match ? Number(match[0].replace(',', '.')) : null;
}

const CATEGORY_KEYWORDS: [Category, RegExp][] = [
  ['desserts', /\b(dessert|cake|cookie|brownie|pudding|ice cream|cupcake|muffin|fudge|cheesecake|baking)s?\b/i],
  ['drinks', /\b(drink|beverage|cocktail|mocktail|smoothie|juice|shake|lemonade|latte|tea|coffee)s?\b/i],
  ['snacks', /\b(snack|appetizer|appetiser|starter|finger food|dip)s?\b/i],
];

/**
 * From the site's own `recipeCategory` only - a title like "crab cakes" or
 * "masala chai rice" is too easy to misread with keywords.
 */
function categoryOf(recipe: Record<string, unknown>): Category {
  const declared = asString(recipe.recipeCategory) ?? '';
  for (const [category, pattern] of CATEGORY_KEYWORDS) if (pattern.test(declared)) return category;
  return 'meals';
}

/**
 * A JSON-LD recipe that is complete enough to use as-is, with no AI call:
 * a title, at least two ingredients, step-by-step instructions, and all four
 * macros stated by the site. Anything less returns null and the page goes
 * through the LLM parser as before. Blog links are unmetered, so every page
 * answered here is a model request nobody pays for.
 */
export function structuredRecipe(recipe: Record<string, unknown>): ParsedRecipe | null {
  // "Paneer Butter Masala Recipe" -> "Paneer Butter Masala", as the parser would.
  const title = cleanJsonLdText(asString(recipe.name) ?? '').replace(/\s+recipe$/i, '');
  const rawIngredients = recipe.recipeIngredient ?? recipe.ingredients;
  const ingredients = (Array.isArray(rawIngredients) ? rawIngredients : [])
    .map((item) => cleanJsonLdText(asString(item) ?? ''))
    .filter(Boolean);
  // A single string is usually one paragraph of instructions; only real
  // step lists are trusted without the parser splitting them.
  const steps = Array.isArray(recipe.recipeInstructions)
    ? flattenInstructions(recipe.recipeInstructions).map(cleanJsonLdText).filter(Boolean)
    : [];
  const nutrition = (recipe.nutrition && typeof recipe.nutrition === 'object' ? recipe.nutrition : {}) as Record<
    string,
    unknown
  >;
  const calories = nutritionNumber(nutrition.calories);
  const protein = nutritionNumber(nutrition.proteinContent);
  const carbs = nutritionNumber(nutrition.carbohydrateContent);
  const fat = nutritionNumber(nutrition.fatContent);
  if (!title || ingredients.length < 2 || steps.length < 1) return null;
  if (calories === null || !(calories > 0) || protein === null || carbs === null || fat === null) return null;

  const yieldText = asString(recipe.recipeYield) ?? '';
  const servings = Number.parseInt(/\d+/.exec(yieldText)?.[0] ?? '', 10);
  return {
    isRecipe: true,
    title: title.slice(0, 200),
    servings: Number.isInteger(servings) && servings >= 1 && servings <= 100 ? servings : undefined,
    ingredients,
    steps,
    macros: { calories, protein, carbs, fat },
    macrosStatedInCaption: true,
    suggestedCategory: categoryOf(recipe),
  };
}

/** The author's stated total time, else prep + cook. */
function statedMinutes(recipe: Record<string, unknown>): number | undefined {
  const total = parseIsoDuration(recipe.totalTime);
  if (total) return total;
  const prep = parseIsoDuration(recipe.prepTime) ?? 0;
  const cook = parseIsoDuration(recipe.cookTime) ?? 0;
  return prep + cook > 0 ? prep + cook : undefined;
}

function extractMeta(html: string, property: string): string | undefined {
  // Match the whole <meta> tag first, then pull content out separately, so
  // this works regardless of whether `property`/`name` comes before or after
  // `content` in the tag's attribute order.
  const tagRegex = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, 'i');
  const tag = tagRegex.exec(html)?.[0];
  if (!tag) return undefined;
  return /content=["']([^"']*)["']/i.exec(tag)?.[1];
}

/** Strips a page down to readable text as a last-resort fallback. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

/**
 * Reads at most `limit` bytes of a body as UTF-8. A page that declares or
 * streams more is cut off rather than buffered whole into memory.
 */
async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers?.get('content-length') ?? '0');
  if (declared > limit) throw upstreamError('That page is too large to read.');
  if (!response.body) return (await response.text()).slice(0, limit);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let html = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    html += decoder.decode(value, { stream: true });
    if (received >= limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return html + decoder.decode();
}

/**
 * Fetches a user-supplied page with the SSRF guard applied to the first URL and
 * every redirect target (`redirect: 'manual'`), a timeout, and a size cap.
 */
async function fetchPage(url: string, fetchImpl: typeof fetch, resolve: HostResolver): Promise<string> {
  let target = await assertPublicUrl(url, resolve);
  for (let hop = 0; ; hop++) {
    let response: Response;
    try {
      response = await fetchImpl(target, {
        headers: { 'user-agent': USER_AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw upstreamError(`Could not fetch the page: ${(err as Error).message}`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get('location');
      if (!location) throw upstreamError(`The page returned HTTP ${response.status}.`);
      if (hop >= MAX_REDIRECTS) throw upstreamError('The page redirected too many times.');
      target = await assertPublicUrl(new URL(location, target), resolve);
      continue;
    }
    if (!response.ok) {
      throw upstreamError(`The page returned HTTP ${response.status}.`);
    }
    return readCapped(response, MAX_PAGE_BYTES);
  }
}

/**
 * Creates a web/blog recipe scraper. Prefers schema.org/Recipe JSON-LD; falls
 * back to the page title, description, and visible text. The result is fed to
 * the same Gemini parser used for captions. `fetchImpl` and `resolve` (the DNS
 * lookup behind the SSRF guard) are injectable.
 */
export function createWebScraper(
  fetchImpl: typeof fetch = fetch,
  resolve: HostResolver = dnsResolver,
): WebScraper {
  return {
    async scrape(url: string): Promise<ScrapedPost> {
      const html = await fetchPage(url, fetchImpl, resolve);
      const recipe = extractJsonLdRecipe(html);

      if (recipe) {
        const rawImage =
          firstImageUrl(recipe.image) ??
          extractMeta(html, 'og:image') ??
          extractMeta(html, 'twitter:image');
        return {
          caption: recipeNodeToText(recipe),
          imageUrl: resolveImageUrl(rawImage, url),
          structured: structuredRecipe(recipe) ?? undefined,
          totalMinutes: statedMinutes(recipe),
        };
      }

      // Fallback: title + description + visible text.
      const title =
        extractMeta(html, 'og:title') ?? /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
      const description = extractMeta(html, 'og:description') ?? extractMeta(html, 'description');
      const text = htmlToText(html);
      const caption = [title && `Title: ${title}`, description, text].filter(Boolean).join('\n\n');

      if (!caption.trim()) {
        throw unprocessable('Could not read any recipe content from this page.');
      }

      const rawImage = extractMeta(html, 'og:image') ?? extractMeta(html, 'twitter:image');
      return { caption, imageUrl: resolveImageUrl(rawImage, url) };
    },
  };
}
