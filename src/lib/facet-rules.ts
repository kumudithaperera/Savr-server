import { DIET_TAGS, type DietTag, type RecipeFacets } from './recipe-facets.js';
import type { Macros } from './types.js';

/**
 * Recipe tags without a model call of their own.
 *
 * `high_protein` and `low_carb` are arithmetic on the per-serving macros.
 * `vegetarian` and `vegan` come from the extraction or moderation call that
 * was being made anyway (the tags ride along in its JSON), and otherwise from
 * ingredient word lists. The word lists also veto a model that missed the
 * bacon. A blog's JSON-LD `totalTime` is the author's own number, so it beats
 * a model's estimate; with neither, the recipe has no time and simply doesn't
 * match the time filter.
 */

/** The diet tags a model may decide; the macro tags are `macroTags`. */
export const MODEL_DIET_TAGS = ['vegetarian', 'vegan'] as const;

/** The tag rules, shared by the extraction and moderation prompts. */
export const FACET_GUIDE = `dietTags - include a tag only when it is clearly true for the recipe exactly as written; when unsure, leave it out:
- vegetarian: no meat, poultry, fish or seafood (eggs and dairy are fine)
- vegan: no animal products at all (no meat, fish, eggs, dairy, honey)

totalMinutes - realistic total time from start to plate in minutes, including marinating, resting or chilling the recipe requires. Estimate from the steps when no time is stated.`;

/** Gemini structured-output properties for the tags (also used by the parsers). */
export const FACET_SCHEMA_PROPERTIES = {
  dietTags: { type: 'array', items: { type: 'string', enum: [...MODEL_DIET_TAGS] } },
  totalMinutes: { type: 'integer' },
} as const;

/** Keeps only valid values; a model's JSON is still untrusted input. */
export function sanitizeFacets(raw: unknown): RecipeFacets {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tags = Array.isArray(value.dietTags)
    ? value.dietTags.filter((t): t is DietTag => (DIET_TAGS as readonly string[]).includes(t as string))
    : [];
  const minutes =
    typeof value.totalMinutes === 'number' && Number.isFinite(value.totalMinutes) && value.totalMinutes > 0
      ? Math.min(Math.round(value.totalMinutes), 1440)
      : null;
  return { dietTags: [...new Set(tags)], totalMinutes: minutes };
}

/**
 * The tags a model returned alongside a parsed recipe, or null when it
 * returned none (an older prompt, or a model that skipped the optional
 * fields). An empty `dietTags` array is an answer ("neither"); a missing one
 * is not.
 */
export function facetsFromParsed(parsed: unknown): RecipeFacets | null {
  const value = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  return Array.isArray(value.dietTags) ? sanitizeFacets(value) : null;
}

/**
 * Per-serving macro tags. All-zero macros mean "unknown", which earns no tag
 * rather than every low-* tag.
 */
export function macroTags(macros: Macros): DietTag[] {
  const { calories, protein, carbs } = macros;
  if (!(calories > 0)) return [];
  const tags: DietTag[] = [];
  if (protein >= 25 || protein * 4 >= calories * 0.3) tags.push('high_protein');
  if (carbs <= 20) tags.push('low_carb');
  return tags;
}

// Ingredient words, matched as whole words in any case. English and Spanish
// (the app's languages) plus the commonest French, Italian, German and
// Portuguese ones, since Discover indexes blogs in any language.
const MEAT_WORDS = [
  // en
  'meat', 'meats', 'meatballs?', 'chicken', 'beef', 'pork', 'lamb', 'mutton', 'veal', 'venison', 'bacon', 'ham',
  'prosciutto', 'pancetta', 'guanciale', 'sausages?', 'chorizo', 'salami', 'pepperoni', 'turkey', 'duck', 'goose',
  'steaks?', 'brisket', 'lard', 'gelatine?', 'fish', 'salmon', 'tuna', 'cod', 'tilapia', 'trout',
  'sardines?', 'anchov(?:y|ies)', 'mackerel', 'halibut', 'haddock', 'shrimps?', 'prawns?', 'crabs?', 'lobsters?',
  'scallops?', 'clams?', 'mussels?', 'oysters?', 'squid', 'calamari', 'octopus', 'worcestershire',
  // es
  'carnes?', 'pollo', 'ternera', 'cerdo', 'cordero', 'tocino', 'beicon', 'jam[oó]n', 'salchichas?',
  'pavo', 'pato', 'bistec', 'alb[oó]ndigas?', 'manteca de cerdo', 'panceta', 'pescados?', 'salm[oó]n', 'at[uú]n',
  'bacalao', 'truchas?', 'sardinas?', 'anchoas?', 'camar[oó]n(?:es)?', 'gambas?', 'langostinos?', 'cangrejos?',
  'langostas?', 'vieiras?', 'almejas?', 'mejill[oó]n(?:es)?', 'ostras?', 'calamar(?:es)?', 'pulpo', 'gelatina',
  // fr / it / de / pt
  'poulet', 'b(?:oe|œ)uf', 'porc', 'jambon', 'lardons', 'poisson', 'saumon', 'thon', 'crevettes?', 'manzo',
  'maiale', 'pesce', 'tonno', 'gamberi', 'h[äa]hnchen', 'huhn', 'rindfleisch', 'schweinefleisch', 'speck',
  'fisch', 'lachs', 'frango', 'porco', 'presunto', 'peixe', 'atum', 'camar[ãa]o',
];
const ANIMAL_PRODUCT_WORDS = [
  // en
  'eggs?', 'yolks?', 'egg whites?', 'milk', 'butter', 'buttermilk', 'cheeses?', 'parmesan', 'parmigiano',
  'mozzarella', 'cheddar', 'feta', 'ricotta', 'mascarpone', 'paneer', 'cream', 'yogh?urt', 'ghee', 'honey',
  'whey', 'mayo', 'mayonnaise', 'custard',
  // es
  'huevos?', 'yemas?', 'claras?', 'leche', 'mantequilla', 'quesos?', 'nata', 'crema', 'yogur', 'miel', 'mayonesa',
  // fr / it / de / pt
  'oeufs?', 'œufs?', 'lait', 'beurre', 'fromage', 'cr[èe]me', 'uova', 'latte', 'burro', 'formaggio', 'eier?',
  'milch', 'k[äa]se', 'sahne', 'ovos?', 'leite', 'manteiga', 'queijo',
];
// Plant versions of animal words, removed before matching.
const PLANT_PHRASES = [
  '(?:coconut|almond|oat|soy|soya|rice|cashew|hemp|plant[- ]based|vegan|dairy[- ]free|non[- ]dairy) (?:milk|cream|butter|cheese|yogh?urt|mayo|mayonnaise)',
  '(?:peanut|nut|almond|cashew|cocoa|apple|seed|sunflower) butter', 'butternut', 'butter beans?', 'eggplants?',
  'cream of tartar', 'egg[- ]free', 'meat[- ]free', 'vegan \\p{L}+', 'leche de (?:coco|almendras?|avena|soja)',
  'crema de (?:cacahuete|man[ií]|coco)', 'mantequilla de (?:cacahuete|man[ií])', 'lait de coco',
];

const wordList = (words: string[]) => new RegExp(`(?<!\\p{L})(?:${words.join('|')})(?!\\p{L})`, 'iu');
const MEAT = wordList(MEAT_WORDS);
const ANIMAL = wordList(ANIMAL_PRODUCT_WORDS);
const PLANT = new RegExp(`(?<!\\p{L})(?:${PLANT_PHRASES.join('|')})(?!\\p{L})`, 'giu');

/**
 * What the ingredient list alone says. `meat`/`animal` are reliable vetoes;
 * `known` is whether the list is in a script the word lists can read at all,
 * so a recipe in Thai or Japanese is never called vegetarian just because no
 * listed word matched.
 */
function readIngredients(ingredients: readonly string[]): { meat: boolean; animal: boolean; known: boolean } {
  const text = ingredients.join('\n').replace(PLANT, ' ');
  const meat = MEAT.test(text);
  // Mostly Latin letters: a unit like "g" doesn't make a Japanese list readable.
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return { meat, animal: meat || ANIMAL.test(text), known: letters > 0 && latin >= letters * 0.8 };
}

/** The diet tags the ingredient list supports with no model answer at all. */
export function ingredientTags(ingredients: readonly string[]): DietTag[] {
  if (ingredients.length < 2) return [];
  const read = readIngredients(ingredients);
  if (!read.known || read.meat) return [];
  return read.animal ? ['vegetarian'] : ['vegetarian', 'vegan'];
}

/**
 * The final tags for a recipe. Never needs a model: `model` is whatever tags
 * an extraction or moderation call already returned (or a cached copy of
 * them), and without it the word lists decide. Either way the word lists veto
 * a vegetarian/vegan claim the ingredients contradict, vegan implies
 * vegetarian, the macro tags are recomputed from this recipe's own macros,
 * and a stated time beats an estimated one.
 */
export function deriveFacets(
  recipe: { ingredients: readonly string[]; macros: Macros },
  model: RecipeFacets | null,
  statedMinutes?: number | null,
): RecipeFacets {
  const read = readIngredients(recipe.ingredients);
  const claimed = model
    ? model.dietTags.filter((tag) => (MODEL_DIET_TAGS as readonly string[]).includes(tag))
    : ingredientTags(recipe.ingredients);
  const vegan = claimed.includes('vegan') && !read.animal;
  const vegetarian = (vegan || claimed.includes('vegetarian')) && !read.meat;
  const dietTags: DietTag[] = [
    ...(vegetarian ? (['vegetarian'] as const) : []),
    ...(vegan ? (['vegan'] as const) : []),
    ...macroTags(recipe.macros),
  ];
  return {
    dietTags,
    totalMinutes: statedMinutes && statedMinutes > 0 ? Math.min(statedMinutes, 1440) : (model?.totalMinutes ?? null),
  };
}

/**
 * Minutes in an ISO 8601 duration as schema.org writes them (`PT1H30M`,
 * `P0DT45M`, `PT90M`). Null for anything else, or for zero.
 */
export function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
    value.trim(),
  );
  if (!match) return null;
  const [, d, h, m, s] = match.map((part) => (part ? Number(part) : 0));
  const minutes = Math.round(d * 1440 + h * 60 + m + s / 60);
  return minutes > 0 ? Math.min(minutes, 1440) : null;
}
