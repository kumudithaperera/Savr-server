import { describe, expect, it, vi } from 'vitest';

import { buildApp, type AppDeps } from '../app.js';
import type { Supabase } from '../lib/supabase.js';

function fakeSupabase(outcome: 'deleted' | 'unauthorized' | 'failed'): Supabase {
  return {
    configured: true,
    canWrite: true,
    subscriptionForToken: vi.fn(async () => null),
    recordEvent: vi.fn(async () => 'recorded' as const),
    applySubscription: vi.fn(async () => true),
    deleteUserForToken: vi.fn(async () => outcome),
    userIdForToken: vi.fn(async () => null),
  };
}

function makeDeps(supabase: Supabase): AppDeps {
  return {
    instagramScraper: { scrape: vi.fn() },
    tiktokScraper: { scrape: vi.fn() },
    webScraper: { scrape: vi.fn() },
    parser: { parse: vi.fn() },
    improver: {} as AppDeps['improver'],
    photoSearch: { search: vi.fn(async () => null) },
    nutrition: { search: vi.fn(async () => null) },
    appSharedSecret: '',
    supabase,
  } as AppDeps;
}

describe('DELETE /account', () => {
  it('refuses a caller with no session, without touching Supabase', async () => {
    const supabase = fakeSupabase('deleted');
    const app = buildApp(makeDeps(supabase));
    const res = await app.inject({ method: 'DELETE', url: '/account' });
    expect(res.statusCode).toBe(401);
    expect(supabase.deleteUserForToken).not.toHaveBeenCalled();
  });

  it('deletes the user the token belongs to', async () => {
    const supabase = fakeSupabase('deleted');
    const app = buildApp(makeDeps(supabase));
    const res = await app.inject({
      method: 'DELETE',
      url: '/account',
      headers: { authorization: 'Bearer user-jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(supabase.deleteUserForToken).toHaveBeenCalledWith('user-jwt');
  });

  it('reports an invalid token as 401 and an outage as 503', async () => {
    const expired = buildApp(makeDeps(fakeSupabase('unauthorized')));
    const down = buildApp(makeDeps(fakeSupabase('failed')));
    const headers = { authorization: 'Bearer user-jwt' };
    expect((await expired.inject({ method: 'DELETE', url: '/account', headers })).statusCode).toBe(401);
    expect((await down.inject({ method: 'DELETE', url: '/account', headers })).statusCode).toBe(503);
  });
});
