import { badRequest } from './errors.js';

/**
 * Longest free-text lookup we'll forward upstream (`/image-search` dish names,
 * `/nutrition` ingredient lines). Real ones are a few words; anything longer is
 * noise or abuse.
 */
export const MAX_QUERY_LENGTH = 200;

/** Reads `body.query` as a trimmed, non-empty, bounded string or throws a 400. */
export function requireQuery(raw: unknown): string {
  const query = typeof raw === 'string' ? raw.trim() : '';
  if (!query) throw badRequest('A query is required.');
  if (query.length > MAX_QUERY_LENGTH) throw badRequest('That query is too long.');
  return query;
}
