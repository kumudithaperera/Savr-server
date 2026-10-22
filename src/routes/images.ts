import type { FastifyInstance } from 'fastify';

import type { PhotoSearch } from '../services/images.js';
import { requireQuery } from '../lib/query.js';

interface ImageSearchDeps {
  photoSearch: PhotoSearch;
}

interface ImageSearchBody {
  query?: unknown;
}

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
    const query = requireQuery(request.body?.query);

    return { url: await deps.photoSearch.search(query) };
  });
}
