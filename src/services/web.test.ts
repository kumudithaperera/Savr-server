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
