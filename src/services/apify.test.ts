import { describe, expect, it } from 'vitest';

import { assessCaption, createApifyInstagramScraper } from './apify.js';
import { HttpError } from '../lib/errors.js';

const config = {
  apifyToken: 'test-token',
  apifyInstagramActor: 'apify~instagram-scraper',
};

/** Fake fetch returning a fixed Apify dataset payload. */
function datasetFetch(items: unknown): typeof fetch {
  return (async () =>
    ({ ok: true, status: 200, json: async () => items }) as unknown as Response) as typeof fetch;
}

const RECIPE_CAPTION = [
  'Dal tadka 🍲',
  '1 cup toor dal, 1 tsp haldi, salt to taste.',
  'Pressure cook 3 whistles, then temper with ghee, jeera and hing.',
  '#dal #indianfood',
].join('\n');

describe('assessCaption', () => {
  it('accepts a caption with a real recipe in it', () => {
    expect(assessCaption(RECIPE_CAPTION)).toBe('ok');
  });

  it('flags an empty caption as video-only', () => {
    expect(assessCaption('')).toBe('no-caption');
    expect(assessCaption('   \n  ')).toBe('no-caption');
  });

  it('flags a hashtag-only caption', () => {
    expect(assessCaption('#paneerbuttermasala #indianfood #foodie #recipe #yum')).toBe(
      'no-recipe-text',
    );
  });

  it('flags a teaser caption that only names the dish', () => {
    // The exact shape that used to produce an invented recipe: a dish name, a
    // call to action, and nothing written down.
    expect(assessCaption('The BEST butter chicken 😍 recipe below 👇 @morsel')).toBe(
      'no-recipe-text',
    );
  });

  it('ignores links, mentions and emoji when measuring the prose', () => {
    const promo = 'Full recipe https://example.com/very/long/link/that/pads/the/length @chef 🔥🔥🔥';
    expect(assessCaption(promo)).toBe('no-recipe-text');
  });
});

describe('createApifyInstagramScraper', () => {
  it('returns the caption and cover image for a real recipe post', async () => {
    const scraper = createApifyInstagramScraper(
      config,
      datasetFetch([
        {
          caption: RECIPE_CAPTION,
          displayUrl: 'https://example.com/cover.jpg',
          ownerUsername: 'cook',
          shortCode: 'ABC123',
        },
      ]),
    );

    await expect(scraper.scrape('https://www.instagram.com/reel/ABC123/')).resolves.toEqual({
      caption: RECIPE_CAPTION,
      imageUrl: 'https://example.com/cover.jpg',
      ownerUsername: 'cook',
      shortcode: 'ABC123',
    });
  });

  it('rejects a caption-less Reel with the caption_only code', async () => {
    const scraper = createApifyInstagramScraper(config, datasetFetch([{ shortCode: 'ABC123' }]));
    await expect(scraper.scrape('https://www.instagram.com/reel/ABC123/')).rejects.toMatchObject({
      statusCode: 422,
      code: 'caption_only',
    });
  });

  it('rejects a hashtag-only caption before the parser is ever reached', async () => {
    const scraper = createApifyInstagramScraper(
      config,
      datasetFetch([{ caption: '#paneerbuttermasala #foodie #recipe', shortCode: 'ABC123' }]),
    );
    const err = await scraper
      .scrape('https://www.instagram.com/reel/ABC123/')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('caption_only');
    // The message has to name the real problem, not just "extraction failed".
    expect((err as HttpError).message).toContain('caption');
  });

  it('surfaces an Apify item error', async () => {
    const scraper = createApifyInstagramScraper(
      config,
      datasetFetch([{ error: 'Post not found' }]),
    );
    await expect(scraper.scrape('https://www.instagram.com/reel/ABC123/')).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});
