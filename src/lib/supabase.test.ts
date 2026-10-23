import { describe, expect, it, vi } from 'vitest';

import { createStore } from './store.js';
import { createSupabase, SYNC_IMAGE_BUCKET } from './supabase.js';

/**
 * Account deletion has to take the user's synced photos with it: Storage
 * doesn't cascade from auth.users, so a deleted account would otherwise leave
 * its photos behind under an id nobody can sign in as.
 */

const BASE = 'https://project.supabase.co';
const USER = '11111111-2222-3333-4444-555555555555';

type Route = (url: string, init: RequestInit) => Response | undefined;

function fakeFetch(...routes: Route[]) {
  return vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    return new Response('unexpected', { status: 500 });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const whoAmI: Route = (url) => (url.endsWith('/auth/v1/user') ? json({ id: USER }) : undefined);
const adminDelete: Route = (url, init) =>
  url.includes('/auth/v1/admin/users/') && init.method === 'DELETE' ? json({}) : undefined;

function supabaseWith(fetch: ReturnType<typeof fakeFetch>) {
  return createSupabase(
    { url: BASE, anonKey: 'anon', serviceRoleKey: 'service' },
    createStore({ upstashUrl: '', upstashToken: '' }, () => {}),
    { fetch: fetch as unknown as typeof globalThis.fetch, warn: () => {} },
  );
}

describe('deleteUserForToken: synced photos', () => {
  it("removes every object in the user's folder before deleting the user", async () => {
    let listed = 0;
    const listRoute: Route = (url) => {
      if (!url.endsWith(`/storage/v1/object/list/${SYNC_IMAGE_BUCKET}`)) return undefined;
      listed++;
      return json(listed === 1 ? [{ name: 'a.jpg' }, { name: 'b.jpg' }] : []);
    };
    const removeRoute: Route = (url, init) =>
      url.endsWith(`/storage/v1/object/${SYNC_IMAGE_BUCKET}`) && init.method === 'DELETE'
        ? json([])
        : undefined;
    const fetch = fakeFetch(whoAmI, listRoute, removeRoute, adminDelete);

    expect(await supabaseWith(fetch).deleteUserForToken('jwt')).toBe('deleted');

    const calls = fetch.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);
    const removeIndex = calls.findIndex((call) => call.startsWith(`DELETE ${BASE}/storage`));
    const userIndex = calls.findIndex((call) => call.includes('/admin/users/'));
    expect(removeIndex).toBeGreaterThan(-1);
    expect(removeIndex).toBeLessThan(userIndex);

    const removeBody = JSON.parse(String(fetch.mock.calls[removeIndex][1]?.body));
    expect(removeBody).toEqual({ prefixes: [`${USER}/a.jpg`, `${USER}/b.jpg`] });
  });

  it('treats a missing bucket as nothing to remove', async () => {
    const missingBucket: Route = (url) =>
      url.includes('/storage/v1/object/list/') ? json({ error: 'Bucket not found' }, 400) : undefined;
    const fetch = fakeFetch(whoAmI, missingBucket, adminDelete);
    expect(await supabaseWith(fetch).deleteUserForToken('jwt')).toBe('deleted');
  });

  it('keeps the account when the photos could not be removed', async () => {
    const storageDown: Route = (url) =>
      url.includes('/storage/v1/object/list/') ? json({}, 503) : undefined;
    const fetch = fakeFetch(whoAmI, storageDown, adminDelete);
    expect(await supabaseWith(fetch).deleteUserForToken('jwt')).toBe('failed');
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/admin/users/'))).toBe(false);
  });
});
