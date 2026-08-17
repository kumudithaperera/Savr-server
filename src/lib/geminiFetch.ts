import { upstreamError } from './errors.js';

export const GEMINI_RETRY_DELAY_MS = 1500;

/**
 * POSTs to Gemini's generateContent, retrying once on a 503. Gemini's own
 * error body calls this "high demand... usually temporary" - worth one retry
 * before the caller surfaces the error. Network failures and every other
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

    if (response.status !== 503 || attempt >= 2) {
      return response;
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}
