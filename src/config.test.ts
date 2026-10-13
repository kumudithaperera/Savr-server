import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from './config.js';

describe('loadConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('trims whitespace pasted around secrets and URLs', () => {
    vi.stubEnv('APIFY_TOKEN', 'apify');
    vi.stubEnv('GEMINI_API_KEY', 'gemini');
    vi.stubEnv('APP_SHARED_SECRET', '  sekret\n');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://upstash.example \n');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '\ttoken ');
    vi.stubEnv('PEXELS_API_KEY', 'pexels\n');
    vi.stubEnv('USDA_API_KEY', ' usda');

    const config = loadConfig();

    expect(config.appSharedSecret).toBe('sekret');
    expect(config.upstashUrl).toBe('https://upstash.example');
    expect(config.upstashToken).toBe('token');
    expect(config.pexelsApiKey).toBe('pexels');
    expect(config.usdaApiKey).toBe('usda');
  });
});
