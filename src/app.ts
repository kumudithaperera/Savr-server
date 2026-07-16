import Fastify, { type FastifyInstance } from 'fastify';

import type { InstagramScraper } from './services/apify.js';
import type { RecipeParser } from './services/gemini.js';
import type { RecipeImprover } from './services/improve.js';
import type { TikTokScraper } from './services/tiktok.js';
import type { WebScraper } from './services/web.js';
import { HttpError } from './lib/errors.js';
import { createRequestGuard } from './lib/guardrail.js';
import { registerExtractRoute } from './routes/extract.js';
import { registerImproveRoute } from './routes/improve.js';

export interface AppDeps {
  instagramScraper: InstagramScraper;
  tiktokScraper: TikTokScraper;
  webScraper: WebScraper;
  parser: RecipeParser;
  improver: RecipeImprover;
  /** Shared secret guarding the expensive routes; empty disables the check (dev). */
  appSharedSecret: string;
}

/**
 * Builds the Fastify app with routes and a central error handler.
 * Dependencies are injected so the app can be tested with fakes.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  // Shared-secret + per-IP rate limit on the expensive routes (see guardrail.ts).
  app.addHook('onRequest', createRequestGuard(deps.appSharedSecret));

  app.get('/health', async () => ({ status: 'ok' }));

  registerExtractRoute(app, deps);
  registerImproveRoute(app, deps);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message });
    }
    app.log.error(error);
    return reply.status(500).send({ code: 'internal_error', message: 'Something went wrong.' });
  });

  return app;
}
