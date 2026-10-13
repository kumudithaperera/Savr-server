import { upstreamError } from './errors.js';

/** Base wait before the first retry; each later retry doubles it. */
export const GEMINI_RETRY_DELAY_MS = 1500;

/** Total attempts, counting the first call. */
export const GEMINI_MAX_ATTEMPTS = 3;

/**
 * A 429 whose RetryInfo asks for longer than this is a spent daily quota, not
 * a per-minute burst - waiting a few seconds won't help, so it isn't retried.
 */
export const GEMINI_MAX_RETRY_AFTER_MS = 10_000;

/** Statuses worth retrying: per-minute rate limit (429) and "high demand" (503). */
const RETRYABLE = new Set([429, 503]);

/**
 * Reads the `retryDelay` ("37s") Gemini puts in a 429's RetryInfo detail.
 * Returns undefined when the body carries none.
 */
export function parseRetryDelayMs(body: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return match ? Number(match[1]) * 1000 : undefined;
}

/**
 * POSTs to Gemini's generateContent, retrying a 429 or 503 up to
 * GEMINI_MAX_ATTEMPTS times with jittered exponential backoff.
 *
 * Gemini's free-tier RPM is per project, so a burst of users trips it
 * together; it refills within the minute, so a short wait turns a failed
 * import (and a wasted, already-billed Apify scrape) into added latency
 * (MORSE-78). A 429 that asks to wait longer than GEMINI_MAX_RETRY_AFTER_MS is
 * a spent daily quota and returns at once. Network failures and every other
 * status pass straight through without retrying.
 */
export async function generateContentWithRetry(
  endpoint: string,
  body: string,
  fetchImpl: typeof fetch,
  retryDelayMs: number = GEMINI_RETRY_DELAY_MS,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch (err) {
      throw upstreamError(`Could not reach Gemini: ${(err as Error).message}`);
    }

    if (!RETRYABLE.has(response.status) || attempt >= GEMINI_MAX_ATTEMPTS) {
      return response;
    }

    // Jitter spreads a burst of callers out so they don't all retry in step.
    let delayMs = retryDelayMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.5);

    if (response.status === 429) {
      // The body has to be read to see RetryInfo; hand back an equivalent
      // Response so a caller that gives up can still read it.
      const text = await response.text().catch(() => '');
      const retryAfterMs = parseRetryDelayMs(text);
      if (retryAfterMs !== undefined && retryAfterMs > GEMINI_MAX_RETRY_AFTER_MS) {
        return new Response(text, { status: response.status });
      }
      if (retryAfterMs !== undefined) delayMs = Math.max(delayMs, retryAfterMs);
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

/**
 * `generationConfig` fields that switch off Gemini 2.5 Flash's "thinking".
 * Thinking is on by default for 2.5 Flash and its tokens are billed as output,
 * which for a short JSON verdict or a tag list is most of the bill and most of
 * the latency - and none of the quality. Only the 2.5 Flash family accepts a
 * zero budget (Pro rejects it), so any other model is left as configured.
 */
export function thinkingOff(model: string): { thinkingConfig?: { thinkingBudget: number } } {
  return /^gemini-2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {};
}
