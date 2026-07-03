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
