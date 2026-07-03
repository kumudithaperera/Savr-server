import Fastify, { type FastifyInstance } from 'fastify';

import type { InstagramScraper } from './services/apify.js';
import type { RecipeParser } from './services/gemini.js';
import type { WebScraper } from './services/web.js';
import { HttpError } from './lib/errors.js';
import { registerExtractRoute } from './routes/extract.js';

export interface AppDeps {
  instagramScraper: InstagramScraper;
  webScraper: WebScraper;
  parser: RecipeParser;
}

/**
 * Builds the Fastify app with routes and a central error handler.
 * Dependencies are injected so the app can be tested with fakes.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  registerExtractRoute(app, deps);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message });
    }
    app.log.error(error);
    return reply.status(500).send({ code: 'internal_error', message: 'Something went wrong.' });
  });

  return app;
}
