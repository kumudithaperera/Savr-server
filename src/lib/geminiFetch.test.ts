import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GEMINI_MAX_ATTEMPTS, generateContentWithRetry, parseRetryDelayMs } from './geminiFetch.js';

function response(status: number, body = ''): Response {
  return new Response(body, { status });
}

/** Returns the next mocked response per call. */
function makeFetch(responses: Response[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('no more mocked Gemini responses');
    return next;
  }) as unknown as typeof fetch;
}

/** A 429 body shaped like Gemini's, with a RetryInfo detail. */
function quotaBody(retryDelay: string): string {
  return JSON.stringify({
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }],
    },
  });
}

describe('parseRetryDelayMs', () => {
  it('reads the RetryInfo delay in milliseconds', () => {
    expect(parseRetryDelayMs(quotaBody('37s'))).toBe(37_000);
    expect(parseRetryDelayMs(quotaBody('1.5s'))).toBe(1_500);
  });

  it('returns undefined when the body has none', () => {
    expect(parseRetryDelayMs('high demand')).toBeUndefined();
  });
});

describe('generateContentWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a 429 burst and returns the eventual success', async () => {
    const fetchImpl = makeFetch([response(429), response(429), response(200, 'ok')]);

    const pending = generateContentWithRetry('https://gemini', '{}', fetchImpl);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops after GEMINI_MAX_ATTEMPTS and hands back the last response', async () => {
    const fetchImpl = makeFetch(Array.from({ length: GEMINI_MAX_ATTEMPTS }, () => response(429)));

    const pending = generateContentWithRetry('https://gemini', '{}', fetchImpl);
    await vi.runAllTimersAsync();

    expect((await pending).status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(GEMINI_MAX_ATTEMPTS);
  });

  it('waits at least as long as a short RetryInfo delay asks', async () => {
    const fetchImpl = makeFetch([response(429, quotaBody('8s')), response(200)]);

    const pending = generateContentWithRetry('https://gemini', '{}', fetchImpl, 10);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await pending).status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a spent daily quota, and keeps its body readable', async () => {
    const body = quotaBody('46800s');
    const fetchImpl = makeFetch([response(429, body)]);

    const result = await generateContentWithRetry('https://gemini', '{}', fetchImpl);

    expect(result.status).toBe(429);
    expect(await result.text()).toBe(body);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry other errors', async () => {
    const fetchImpl = makeFetch([response(500)]);

    const result = await generateContentWithRetry('https://gemini', '{}', fetchImpl);

    expect(result.status).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
