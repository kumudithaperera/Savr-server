import { describe, expect, it, vi } from 'vitest';

import { createApifyTikTokScraper, subtitlesToPlainText } from './tiktok.js';
import { HttpError } from '../lib/errors.js';

const config = {
  apifyToken: 'test-token',
  apifyTiktokActor: 'clockworks~free-tiktok-scraper',
  apifyTiktokNativeSubtitlesOnly: true,
};

/** Fake fetch returning the Apify dataset JSON; ignores subsequent subtitle fetches. */
function datasetFetch(items: unknown): typeof fetch {
  return (async () =>
    ({ ok: true, status: 200, json: async () => items }) as unknown as Response) as typeof fetch;
}

const VTT = `WEBVTT

1
00:00:00.000 --> 00:00:02.000
Add two cups of flour

2
00:00:02.000 --> 00:00:04.000
Add two cups of flour

3
00:00:04.000 --> 00:00:06.000
then one egg`;

describe('subtitlesToPlainText', () => {
  it('strips VTT markup and de-duplicates repeated cues', () => {
    expect(subtitlesToPlainText(VTT)).toBe('Add two cups of flour then one egg');
  });
});

describe('createApifyTikTokScraper', () => {
  it('combines caption with an inline transcript', async () => {
    const scraper = createApifyTikTokScraper(
      config,
      datasetFetch([{ text: 'Best pancakes #recipe', transcript: 'mix flour and eggs' }]),
    );
    const post = await scraper.scrape('https://www.tiktok.com/@x/video/1');
    expect(post.caption).toContain('Best pancakes #recipe');
    expect(post.caption).toContain('Video transcript:');
    expect(post.caption).toContain('mix flour and eggs');
  });

  it('fetches and cleans a subtitle link when no inline transcript is present', async () => {
    // First call returns the dataset; second call returns the VTT file.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [
        {
          text: 'Garlic bread',
          videoMeta: { subtitleLinks: [{ language: 'eng-US', downloadLink: 'https://sub/en.vtt' }] },
        },
      ] })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => VTT });

    const scraper = createApifyTikTokScraper(config, fetchImpl as unknown as typeof fetch);
    const post = await scraper.scrape('https://www.tiktok.com/@x/video/2');
    expect(post.caption).toContain('Garlic bread');
    expect(post.caption).toContain('Add two cups of flour then one egg');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('still returns the caption when the subtitle fetch fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [
        {
          text: 'Only a caption here',
          videoMeta: { subtitleLinks: [{ language: 'en', downloadLink: 'https://sub/en.vtt' }] },
        },
      ] })
      .mockResolvedValueOnce({ ok: false, status: 404 });

    const scraper = createApifyTikTokScraper(config, fetchImpl as unknown as typeof fetch);
    const post = await scraper.scrape('https://www.tiktok.com/@x/video/3');
    expect(post.caption).toBe('Only a caption here');
  });

  it('throws 422 when the item has neither caption nor subtitles', async () => {
    const scraper = createApifyTikTokScraper(config, datasetFetch([{ id: '123' }]));
    await expect(scraper.scrape('https://www.tiktok.com/@x/video/4')).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it('throws 422 on an errored Apify item', async () => {
    const scraper = createApifyTikTokScraper(config, datasetFetch([{ error: 'private video' }]));
    await expect(scraper.scrape('https://www.tiktok.com/@x/video/5')).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});
