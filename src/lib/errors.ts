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
export const unprocessable = (message: string) => new HttpError(422, 'parse_failed', message);
export const upstreamError = (message: string) => new HttpError(502, 'upstream_error', message);
/** This install has used its monthly AI-extraction allowance. */
export const quotaExceeded = (message: string) => new HttpError(429, 'quota_exceeded', message);
/** The whole service hit its daily spend ceiling; nobody gets AI extractions today. */
export const atCapacity = (message: string) => new HttpError(503, 'at_capacity', message);
