import { describe, expect, it } from 'vitest';

import { createWebScraper } from './web.js';

const PAGE_URL = 'https://example.com/recipes/pasta';

/** Every host resolves to a public address, so the SSRF guard never hits DNS. */
const publicDns = async () => ['93.184.216.34'];
const makeScraper = (fetchImpl: typeof fetch) => createWebScraper(fetchImpl, publicDns);

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
    const scraper = makeScraper(htmlFetch(html));
    const result = await scraper.scrape(PAGE_URL);
    expect(result.imageUrl).toBe('https://cdn.example.com/a.jpg');
  });

  it('resolves a relative og:image against the page URL', async () => {
    const html = jsonLdPage(
      { name: 'Pasta' },
      '<meta property="og:image" content="/uploads/photo.jpg">',
    );
    const scraper = makeScraper(htmlFetch(html));
    const result = await scraper.scrape(PAGE_URL);
    expect(result.imageUrl).toBe('https://example.com/uploads/photo.jpg');
  });

  it('matches meta tags regardless of attribute order', async () => {
    const html = jsonLdPage(
      { name: 'Pasta' },
      '<meta content="https://cdn.example.com/reversed.jpg" property="og:image">',
    );
    const scraper = makeScraper(htmlFetch(html));
    const result = await scraper.scrape(PAGE_URL);
    expect(result.imageUrl).toBe('https://cdn.example.com/reversed.jpg');
  });

  it('falls back to twitter:image when og:image is absent', async () => {
    const html = jsonLdPage(
      { name: 'Pasta' },
      '<meta name="twitter:image" content="https://cdn.example.com/twitter.jpg">',
    );
    const scraper = makeScraper(htmlFetch(html));
    const result = await scraper.scrape(PAGE_URL);
    expect(result.imageUrl).toBe('https://cdn.example.com/twitter.jpg');
  });

  it('resolves og:image on the no-JSON-LD fallback path too', async () => {
    const html =
      '<!doctype html><html><head><title>Pasta</title>' +
      '<meta property="og:image" content="//cdn.example.com/fallback.jpg"></head>' +
      '<body>Some pasta recipe text long enough to pass.</body></html>';
    const scraper = makeScraper(htmlFetch(html));
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
    const result = await makeScraper(htmlFetch(jsonLdPage(complete))).scrape(PAGE_URL);
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
    expect((await makeScraper(htmlFetch(jsonLdPage(noNutrition))).scrape(PAGE_URL)).structured).toBeUndefined();
    const paragraph = { ...complete, recipeInstructions: 'Fry the paste, then add everything and simmer.' };
    expect((await makeScraper(htmlFetch(jsonLdPage(paragraph))).scrape(PAGE_URL)).structured).toBeUndefined();
  });

  it('maps the site category, never the title', async () => {
    const dessert = { ...complete, name: 'Fish cakes', recipeCategory: 'Dessert' };
    expect((await makeScraper(htmlFetch(jsonLdPage(dessert))).scrape(PAGE_URL)).structured?.suggestedCategory).toBe('desserts');
    const titleOnly = { ...complete, name: 'Chocolate cake', recipeCategory: undefined };
    expect((await makeScraper(htmlFetch(jsonLdPage(titleOnly))).scrape(PAGE_URL)).structured?.suggestedCategory).toBe('meals');
  });
});

describe('SSRF guard', () => {
  /** Fake fetch that records each URL and answers from a route table. */
  function routedFetch(routes: Record<string, { status: number; location?: string; html?: string }>) {
    const calls: string[] = [];
    const impl = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const route = routes[url] ?? { status: 404 };
      return {
        ok: route.status >= 200 && route.status < 300,
        status: route.status,
        headers: new Headers(route.location ? { location: route.location } : {}),
        text: async () => route.html ?? '',
      } as unknown as Response;
    }) as typeof fetch;
    return { impl, calls };
  }

  const page = jsonLdPage({ name: 'Pasta' });

  it.each([
    'http://169.254.169.254/latest/meta-data/x',
    'http://127.0.0.1/admin/x',
    'http://localhost/x',
    'http://10.1.2.3/x',
    'http://[::1]/x',
    'http://[::ffff:127.0.0.1]/x',
    'https://example.com:6379/x',
    'http://user:pw@example.com/x',
  ])('refuses %s without fetching it', async (url) => {
    const { impl, calls } = routedFetch({});
    await expect(createWebScraper(impl, publicDns).scrape(url)).rejects.toMatchObject({
      code: 'unsupported_link',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const { impl, calls } = routedFetch({});
    const scraper = createWebScraper(impl, async () => ['93.184.216.34', '10.0.0.5']);
    await expect(scraper.scrape('https://sneaky.example/recipe')).rejects.toMatchObject({
      code: 'unsupported_link',
    });
    expect(calls).toEqual([]);
  });

  it('follows a public redirect', async () => {
    const { impl, calls } = routedFetch({
      'https://example.com/r': { status: 301, location: '/recipes/pasta' },
      'https://example.com/recipes/pasta': { status: 200, html: page },
    });
    await makeScraper(impl).scrape('https://example.com/r');
    expect(calls).toEqual(['https://example.com/r', 'https://example.com/recipes/pasta']);
  });

  it('refuses a redirect into a private address', async () => {
    const { impl, calls } = routedFetch({
      'https://example.com/r': { status: 302, location: 'http://169.254.169.254/latest/' },
    });
    await expect(makeScraper(impl).scrape('https://example.com/r')).rejects.toMatchObject({
      code: 'unsupported_link',
    });
    expect(calls).toEqual(['https://example.com/r']);
  });

  it('gives up on a redirect loop', async () => {
    const { impl } = routedFetch({
      'https://example.com/a': { status: 302, location: '/b' },
      'https://example.com/b': { status: 302, location: '/a' },
    });
    await expect(makeScraper(impl).scrape('https://example.com/a')).rejects.toMatchObject({
      code: 'upstream_error',
    });
  });
});
