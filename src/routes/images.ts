import type { FastifyInstance } from 'fastify';

import type { PhotoSearch } from '../services/images.js';
import { badRequest } from '../lib/errors.js';

interface ImageSearchDeps {
  photoSearch: PhotoSearch;
}

interface ImageSearchBody {
  query?: unknown;
}

/** Longest dish name we'll forward. Recipe titles are short; anything longer is noise. */
const MAX_QUERY_LENGTH = 200;

/**
 * Registers `POST /image-search`. Body: `{ query }`. Returns `{ url }` - the
 * photo URL, or null when there's no match or no key is configured.
 *
 * Exists so the Pexels key lives on the server instead of in the app bundle.
 * The response deliberately carries nothing but the URL: no upstream payload,
 * no key, no error text from Pexels.
 */
export function registerImageSearchRoute(app: FastifyInstance, deps: ImageSearchDeps): void {
  app.post<{ Body: ImageSearchBody }>('/image-search', async (request) => {
    const raw = request.body?.query;
    const query = typeof raw === 'string' ? raw.trim() : '';
    if (!query) {
      throw badRequest('A query is required.');
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw badRequest('That query is too long.');
    }

    return { url: await deps.photoSearch.search(query) };
  });
}
