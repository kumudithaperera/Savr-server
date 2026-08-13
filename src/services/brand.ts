/**
 * Cheap brand detection for ingredient names, used to decide whether the
 * nutrition cross-check should consult Open Food Facts - and which brand to
 * prefer there - instead of going straight to USDA's generic foods.
 *
 * Recipe text has no reliable grammar, so this is a heuristic. A token counts
 * as a brand when it reads like a proper noun and isn't a word we know as a
 * generic food or descriptor:
 *
 *  - a bare possessive-s (`Kellogg's`, `Hershey's`) and ALL-CAPS tokens are
 *    treated as brands unconditionally;
 *  - otherwise only a capitalized word that isn't a common capitalized food
 *    noun or style word trips the detector. "Chicken breast" and "Italian
 *    sausages" stay generic; "Barilla spaghetti" and "Heinz baked beans" are
 *    brands.
 *
 * Getting it wrong is safe rather than broken: a false "brand" just asks OFF
 * for a product that won't match and then falls back to USDA's generic value,
 * and a false "generic" stays on USDA, which is the intended default anyway.
 * A lower-case brand ("1 box barilla spaghetti") is not detected - that would
 * need a brand dictionary nobody keeps - and quietly stays on USDA too.
 */

/** Food nouns users commonly capitalize mid-ingredient but that are never brands. */
const GENERIC_FOOD_WORDS = new Set([
  // meat, fish, eggs, plant protein
  'chicken', 'turkey', 'beef', 'pork', 'lamb', 'veal', 'bison', 'duck', 'goose', 'venison',
  'bacon', 'ham', 'sausage', 'sausages', 'chorizo', 'salami', 'pepperoni', 'prosciutto',
  'pancetta', 'bologna', 'hotdog', 'hotdogs', 'steak', 'steaks', 'ribs', 'wings', 'thighs',
  'drumsticks', 'breast', 'breasts', 'fillet', 'fillets', 'tenderloin', 'loin', 'roast',
  'shoulder', 'mince', 'skirt', 'flank', 'salmon', 'tuna', 'cod', 'halibut', 'trout', 'bass',
  'tilapia', 'snapper', 'grouper', 'shrimp', 'prawns', 'scallops', 'mussels', 'clams',
  'oysters', 'crab', 'lobster', 'calamari', 'fish', 'anchovies', 'sardines', 'eggs', 'egg',
  'tofu', 'tempeh', 'seitan', 'cheese', 'cheeses', 'mozzarella', 'cheddar', 'parmesan',
  'parmigiano', 'pecorino', 'asiago', 'fontina', 'gruyere', 'gouda', 'swiss', 'brie',
  'camembert', 'ricotta', 'feta', 'haloumi', 'halloumi', 'paneer', 'cottage', 'mascarpone',
  'provolone',
  // dairy and fats
  'milk', 'buttermilk', 'yogurt', 'yoghurt', 'kefir', 'cream', 'butter', 'ghee',
  'margarine', 'shortening', 'lard', 'oil', 'oils', 'olive',
  // produce
  'onion', 'onions', 'garlic', 'leek', 'leeks', 'shallot', 'shallots', 'scallions',
  'chives', 'celery', 'carrot', 'carrots', 'radish', 'radishes', 'turnip', 'turnips',
  'rutabaga', 'parsnip', 'parsnips', 'beet', 'beets', 'potato', 'potatoes', 'yam', 'yams',
  'taro', 'tomato', 'tomatoes', 'cucumber', 'cucumbers', 'pickle', 'pickles', 'pepper',
  'peppers', 'chili', 'chillies', 'jalapeno', 'habanero', 'poblano', 'corn', 'peas',
  'beans', 'broccoli', 'cauliflower', 'cabbage', 'kale', 'spinach', 'lettuce', 'arugula',
  'rocket', 'romaine', 'endive', 'escarole', 'bok', 'choy', 'chard', 'zucchini', 'courgette',
  'squash', 'pumpkin', 'butternut', 'artichoke', 'artichokes', 'asparagus', 'avocado',
  'eggplant', 'eggplants', 'okra', 'mushroom', 'mushrooms', 'truffles', 'olives', 'edamame',
  'lentils', 'chickpeas',
  // fruit
  'apple', 'apples', 'pear', 'pears', 'peach', 'peaches', 'nectarine', 'apricot',
  'apricots', 'plum', 'plums', 'cherry', 'cherries', 'berry', 'berries', 'strawberry',
  'strawberries', 'blueberry', 'blueberries', 'raspberry', 'raspberries', 'blackberry',
  'blackberries', 'cranberry', 'cranberries', 'grape', 'grapes', 'raisin', 'raisins',
  'sultana', 'sultanas', 'currant', 'currants', 'banana', 'bananas', 'plantain', 'mango',
  'mangoes', 'pineapple', 'papaya', 'guava', 'kiwi', 'orange', 'oranges', 'clementine',
  'mandarin', 'tangerine', 'grapefruit', 'lemon', 'lemons', 'lime', 'limes', 'watermelon',
  'melon', 'cantaloupe', 'honeydew', 'fig', 'figs', 'date', 'dates', 'prune', 'prunes',
  'coconut',
  // grains, starch, baked
  'flour', 'semolina', 'cornmeal', 'masa', 'polenta', 'grits', 'cornstarch', 'starch',
  'tapioca', 'arrowroot', 'rice', 'pasta', 'spaghetti', 'linguine', 'fettuccine', 'penne',
  'rigatoni', 'macaroni', 'orzo', 'couscous', 'noodles', 'ramen', 'udon', 'soba',
  'vermicelli', 'bread', 'breads', 'breadcrumbs', 'panko', 'croutons', 'bagel', 'bagels',
  'baguette', 'tortilla', 'tortillas', 'naan', 'pita', 'toast', 'croissant', 'roll',
  'rolls', 'bun', 'buns', 'muffin', 'muffins', 'pancake', 'pancakes', 'waffle', 'waffles',
  'crepe', 'crepes', 'cereal', 'oats', 'oatmeal', 'granola', 'muesli', 'quinoa', 'barley',
  'bulgur', 'farro', 'wheat', 'rye', 'spelt',
  // sugar / sweeteners / condiments
  'sugar', 'honey', 'molasses', 'syrup', 'maple', 'agave', 'jam', 'jelly', 'preserves',
  'marmalade', 'compote', 'chutney', 'ketchup', 'mustard', 'mayo', 'mayonnaise', 'relish',
  'sriracha', 'teriyaki', 'hoisin', 'bbq', 'barbecue', 'sauce', 'sauces', 'vinaigrette',
  'dressing', 'dressings', 'marinade', 'tahini', 'hummus', 'guacamole', 'salsa', 'pesto',
  'marinara',
  // seasonings
  'salt', 'cinnamon', 'nutmeg', 'ginger', 'turmeric', 'cumin', 'coriander', 'cardamom',
  'cloves', 'paprika', 'cayenne', 'oregano', 'basil', 'parsley', 'cilantro', 'dill',
  'thyme', 'rosemary', 'sage', 'mint', 'tarragon', 'marjoram', 'bay', 'powder', 'flakes',
  'seeds', 'sesame', 'sunflower', 'chia', 'flax', 'poppy', 'pepitas', 'vanilla', 'extract',
  'essence', 'baking', 'cocoa', 'chocolate', 'chips', 'mix', 'blend', 'crumble',
  'seasoning', 'spice', 'spices',
  // liquids / pantry
  'stock', 'broth', 'bouillon', 'cube', 'cubes', 'water', 'coffee', 'wine', 'beer', 'cider',
  'sherry', 'marshmallow', 'marshmallows', 'gelatin', 'yeast', 'corn', 'tomato',
]);

/**
 * Capitalized words that describe a food (region, prep, size, color) rather
 * than name a brand. Both lowercase and title-cased occurrences are denied.
 */
const NON_BRAND_DESCRIPTOR = new Set([
  // regions / national styles
  'african', 'american', 'argentinian', 'asian', 'australian', 'british', 'canadian',
  'caribbean', 'chinese', 'east', 'eastern', 'european', 'french', 'german', 'greek',
  'hawaiian', 'indian', 'indonesian', 'irish', 'israeli', 'italian', 'japanese', 'korean',
  'latin', 'mediterranean', 'mexican', 'middle', 'moroccan', 'north', 'northern',
  'norwegian', 'pakistani', 'portuguese', 'russian', 'southern', 'southwest',
  'southwestern', 'spanish', 'swedish', 'thai', 'turkish', 'vietnamese', 'west', 'western',
  'new', 'old',
  // prep, size, color, type
  'all', 'ancient', 'baby', 'baked', 'balsamic', 'big', 'black', 'blue', 'boneless',
  'braised', 'breaded', 'brioche', 'broiled', 'brown', 'canned', 'champagne', 'chunky',
  'cold', 'cooked', 'creamy', 'crumbled', 'crushed', 'cubed', 'dark', 'diced', 'dried',
  'extra', 'fat', 'fine', 'flaked', 'fresh', 'fried', 'frozen', 'golden', 'green', 'ground',
  'half', 'hard', 'heavy', 'high', 'hot', 'jumbo', 'large', 'lean', 'light', 'long', 'low',
  'marinated', 'medium', 'mild', 'minced', 'natural', 'non', 'organic', 'plain', 'pocket',
  'prepared', 'pure', 'quick', 'raw', 'red', 'reduced', 'regular', 'ripe', 'roasted',
  'rough', 'ruby', 'salted', 'seasoned', 'shredded', 'skinless', 'sliced', 'slow', 'small',
  'smoked', 'soft', 'sour', 'spicy', 'sprouted', 'strong', 'sweet', 'thick', 'thin',
  'toasted', 'trimmed', 'unbleached', 'unbaked', 'unsalted', 'unsweetened', 'white',
  'whole', 'wild', 'yellow', 'young',
  // common capitalized varieties that aren't brands
  'arborio', 'basmati', 'carolina', 'jasmine', 'roma', 'romano', 'short',
]);

const OWN_S = /^[A-Za-z]{2,}['’]s$/;
const PROPER_NOUN = /^[A-Z][a-z]{2,}$/;
const ALL_CAPS = /^[A-Z]{3,}$/;

/**
 * Returns the distinct lower-cased brand tokens detected in an ingredient food
 * name, or an empty array when the name reads as a generic food. Callers use a
 * non-empty result as "this names a branded product - consult Open Food Facts".
 */
export function brandTokens(query: string): string[] {
  const clean = query.replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const brands: string[] = [];
  for (const raw of clean.split(' ')) {
    const token = raw.replace(/[.,!)]+$/, '');
    if (token.length < 2 || /[0-9]/.test(token)) continue;

    // A known generic food/descriptor is never a brand, whatever its casing -
    // "KETCHUP" and "ketchup" are the same ketchup. Check this before the
    // case-sensitive signals so a recipe written in CAPS doesn't ship the whole
    // pantry off to Open Food Facts.
    const lower = token.toLowerCase();
    if (GENERIC_FOOD_WORDS.has(lower) || NON_BRAND_DESCRIPTOR.has(lower)) continue;

    // "Kellogg's", "Hershey's" - brands carry the -'s form almost always
    // (the apostrophe is the entire signal; either casing).
    if (OWN_S.test(token)) {
      brands.push(token.replace(/['’]s$/, '').toLowerCase());
      continue;
    }

    // "HERSHEY'S", "KNOOR", "OREO" - shouting tends to be brand marketing.
    const base = token.replace(/['’]/g, '');
    if (ALL_CAPS.test(base)) {
      brands.push(base.toLowerCase());
      continue;
    }

    // A capitalized proper noun that isn't a known generic food/descriptor.
    if (PROPER_NOUN.test(token)) {
      brands.push(lower);
    }
  }

  return [...new Set(brands)];
}