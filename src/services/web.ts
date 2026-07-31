import { unprocessable, upstreamError } from '../lib/errors.js';
import type { ScrapedPost } from '../lib/types.js';

export interface WebScraper {
  scrape(url: string): Promise<ScrapedPost>;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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
 * Creates a web/blog recipe scraper. Prefers schema.org/Recipe JSON-LD; falls
 * back to the page title, description, and visible text. The result is fed to
 * the same Gemini parser used for captions. `fetchImpl` is injectable.
 */
export function createWebScraper(fetchImpl: typeof fetch = fetch): WebScraper {
  return {
    async scrape(url: string): Promise<ScrapedPost> {
      let response: Response;
      try {
        response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT } });
      } catch (err) {
        throw upstreamError(`Could not fetch the page: ${(err as Error).message}`);
      }
      if (!response.ok) {
        throw upstreamError(`The page returned HTTP ${response.status}.`);
      }

      const html = await response.text();
      const recipe = extractJsonLdRecipe(html);

      if (recipe) {
        const rawImage =
          firstImageUrl(recipe.image) ??
          extractMeta(html, 'og:image') ??
          extractMeta(html, 'twitter:image');
        return {
          caption: recipeNodeToText(recipe),
          imageUrl: resolveImageUrl(rawImage, url),
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
