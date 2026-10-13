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
