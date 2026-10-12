import type { FastifyInstance } from 'fastify';

import { bearerToken } from '../lib/entitlement.js';
import { HttpError } from '../lib/errors.js';
import type { Supabase } from '../lib/supabase.js';

/**
 * In-app account deletion (App Store Guideline 5.1.1(v), Play's account
 * deletion policy).
 *
 * Deleting a Supabase user needs the service role key, which must never ship in
 * the app - so the app asks here with its own session token, and the server
 * deletes whichever user that token resolves to. The subscription row cascades.
 *
 * A store subscription is not cancelled by this: Apple and Google own billing,
 * and the app tells the user to cancel there before deleting.
 */
export function registerAccountRoute(app: FastifyInstance, deps: { supabase: Supabase }): void {
  app.delete('/account', async (request) => {
    const token = bearerToken(request);
    if (!token) throw new HttpError(401, 'unauthorized', 'Sign in to delete your account.');

    const outcome = await deps.supabase.deleteUserForToken(token);
    if (outcome === 'unauthorized') {
      throw new HttpError(401, 'unauthorized', 'Your session has expired. Sign in again.');
    }
    if (outcome === 'failed') {
      throw new HttpError(503, 'delete_failed', "We couldn't delete your account. Please try again.");
    }
    request.log.info('account: deleted');
    return { deleted: true };
  });
}
