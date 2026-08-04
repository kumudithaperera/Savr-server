/** Error that maps cleanly onto an HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const upstreamError = (message: string) => new HttpError(502, 'upstream_error', message);

/**
 * Why an extraction was refused. The app shows `message` verbatim, but the code
 * lets it tailor the affordance (e.g. suggest a blog link for `unsupported_link`)
 * and, later, swap in a translated string - server copy can't go through the
 * client's i18n catalog, so the code is the stable join key.
 */
export type ExtractionFailure =
  /** The link itself can't be extracted: wrong platform, or not a single post. */
  | 'unsupported_link'
  /** The post exists but its recipe isn't in the caption (video-only, hashtags). */
  | 'caption_only'
  /** There is text, but it isn't a recipe. */
  | 'not_a_recipe'
  /** Anything else that failed during parsing. */
  | 'parse_failed';

export const unprocessable = (message: string, code: ExtractionFailure = 'parse_failed') =>
  new HttpError(422, code, message);

/**
 * The link can't be extracted at all. Distinct from `unprocessable` because
 * nothing was fetched - these are rejected before any Apify/Gemini spend.
 */
export const unsupportedLink = (message: string) =>
  new HttpError(422, 'unsupported_link', message);
/** This install has used its monthly AI-extraction allowance. */
export const quotaExceeded = (message: string) => new HttpError(429, 'quota_exceeded', message);
/** The whole service hit its daily spend ceiling; nobody gets AI extractions today. */
export const atCapacity = (message: string) => new HttpError(503, 'at_capacity', message);
