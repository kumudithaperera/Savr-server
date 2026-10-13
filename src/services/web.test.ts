import { describe, expect, it } from 'vitest';

import { createWebScraper } from './web.js';

const PAGE_URL = 'https://example.com/recipes/pasta';

/** Fake fetch returning the given HTML for any request. */
function htmlFetch(html: string): typeof fetch {
  return (async () =>
    ({ ok: true, status: 200, text: async () => html }) as unknown as Response) as typeof fetch;
}

function jsonLdPage(recipe: Record<string, unknown>, extraHead = ''): string {
  return `<!doctype html><html><head>${extraHead}<script type="application/ld+json">${JSON.stringify(
    { '@context': 'https://schema.org', '@type': 'Recipe', ...recipe },
  )}</script></head><body></body></html>`;
}

describe('createWebScraper image extraction', () => {
  it('picks the first URL from an array-valued JSON-LD image', async () => {
    const html = jsonLdPage({
      name: 'Pasta',
      image: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
    });
    const scraper = createWebScraper(htmlFetch(html));
    const result = await scraper.scrape(PAGE_URL);
    expect(result.imageUrl).toBe('https://cdn.example.com/a.jpg');
  });

  it('resolves a relative og:image against the page URL', async () => {
    const html = jsonLdPage(
      { name: 'Pasta' },
      '<meta property="og:image" content="/uploads/photo.jpg">',
    );
    const scraper = createWebScraper(htmlFetch(html));
    const result = await scraper.scrape(PAGE_URL);
    expect(result.imageUrl).toBe('https://example.com/uploads/photo.jpg');
  });

  it('matches meta tags regardless of attribute order', async () => {
    const html = jsonLdPage(
      { name: 'Pasta' },
      '<meta content="https://cdn.example.com/reversed.jpg" property="og:image">',
    );
    const scraper = createWebScraper(htmlFetch(html));
    const result = await scraper.scrape(PAGE_URL);
    expect(result.imageUrl).toBe('https://cdn.example.com/reversed.jpg');
  });

  it('falls back to twitter:image when og:image is absent', async () => {
    const html = jsonLdPage(
      { name: 'Pasta' },
      '<meta name="twitter:image" content="https://cdn.example.com/twitter.jpg">',
    );
    const scraper = createWebScraper(htmlFetch(html));
    const result = await scraper.scrape(PAGE_URL);
    expect(result.imageUrl).toBe('https://cdn.example.com/twitter.jpg');
  });

  it('resolves og:image on the no-JSON-LD fallback path too', async () => {
    const html =
      '<!doctype html><html><head><title>Pasta</title>' +
      '<meta property="og:image" content="//cdn.example.com/fallback.jpg"></head>' +
      '<body>Some pasta recipe text long enough to pass.</body></html>';
    const scraper = createWebScraper(htmlFetch(html));
    const result = await scraper.scrape(PAGE_URL);
    expect(result.imageUrl).toBe('https://cdn.example.com/fallback.jpg');
  });
});

describe('structured JSON-LD parse (no AI call)', () => {
  const complete = {
    name: 'Crispy Chickpea &amp; Spinach Curry',
    recipeCategory: 'Main Course',
    recipeYield: ['4', '4 servings'],
    totalTime: 'PT45M',
    recipeIngredient: ['1 can chickpeas', '200 g spinach', '1 tbsp curry paste'],
    recipeInstructions: [
      { '@type': 'HowToStep', text: 'Fry the <b>paste</b>.' },
      { '@type': 'HowToSection', itemListElement: [{ '@type': 'HowToStep', text: 'Add the rest &#8211; simmer.' }] },
    ],
    nutrition: { calories: '410 kcal', proteinContent: '16 g', carbohydrateContent: '38,5 g', fatContent: '18g' },
  };

  it('uses a complete recipe as-is, macros stated by the site', async () => {
    const result = await createWebScraper(htmlFetch(jsonLdPage(complete))).scrape(PAGE_URL);
    expect(result.structured).toEqual({
      isRecipe: true,
      title: 'Crispy Chickpea & Spinach Curry',
      servings: 4,
      ingredients: ['1 can chickpeas', '200 g spinach', '1 tbsp curry paste'],
      steps: ['Fry the paste.', 'Add the rest – simmer.'],
      macros: { calories: 410, protein: 16, carbs: 38.5, fat: 18 },
      macrosStatedInCaption: true,
      suggestedCategory: 'meals',
    });
    expect(result.totalMinutes).toBe(45);
  });

  it('falls back to the LLM when nutrition or real steps are missing', async () => {
    const noNutrition = { ...complete, nutrition: { calories: '410 kcal' } };
    expect((await createWebScraper(htmlFetch(jsonLdPage(noNutrition))).scrape(PAGE_URL)).structured).toBeUndefined();
    const paragraph = { ...complete, recipeInstructions: 'Fry the paste, then add everything and simmer.' };
    expect((await createWebScraper(htmlFetch(jsonLdPage(paragraph))).scrape(PAGE_URL)).structured).toBeUndefined();
  });

  it('maps the site category, never the title', async () => {
    const dessert = { ...complete, name: 'Fish cakes', recipeCategory: 'Dessert' };
    expect((await createWebScraper(htmlFetch(jsonLdPage(dessert))).scrape(PAGE_URL)).structured?.suggestedCategory).toBe('desserts');
    const titleOnly = { ...complete, name: 'Chocolate cake', recipeCategory: undefined };
    expect((await createWebScraper(htmlFetch(jsonLdPage(titleOnly))).scrape(PAGE_URL)).structured?.suggestedCategory).toBe('meals');
  });
});
