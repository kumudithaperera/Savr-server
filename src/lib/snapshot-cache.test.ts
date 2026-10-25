import { afterEach, describe, expect, it, vi } from 'vitest';

import { cachedSnapshot, invalidateSnapshots } from './snapshot-cache.js';
import { createStore } from './store.js';

const store = () => createStore({ upstashUrl: '', upstashToken: '' });

describe('cachedSnapshot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves a fresh snapshot without asking again', async () => {
    const shared = store();
    const refresh = vi.fn(async () => ['a']);

    expect(await cachedSnapshot({ store: shared, key: 'list', refresh })).toEqual(['a']);
    expect(await cachedSnapshot({ store: shared, key: 'list', refresh })).toEqual(['a']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('rebuilds a stale snapshot once while other callers get the old copy', async () => {
    const shared = store();
    let value = ['old'];
    const refresh = vi.fn(async () => value);

    // `freshMs: 0` makes every read stale, so the concurrency is deterministic.
    await cachedSnapshot({ store: shared, key: 'list', refresh, freshMs: 0 });
    // The rebuild lock outlives a 0 ms read window; pretend it has expired.
    await shared.del('list:rebuild');
    value = ['new'];

    const answers = await Promise.all([
      cachedSnapshot({ store: shared, key: 'list', refresh, freshMs: 0 }),
      cachedSnapshot({ store: shared, key: 'list', refresh, freshMs: 0 }),
    ]);
    expect(answers.flat().sort()).toEqual(['new', 'old']);
    expect(refresh).toHaveBeenCalledTimes(2);

    // The rebuilt copy is what the next caller sees, with no third query.
    expect(await cachedSnapshot({ store: shared, key: 'list', refresh, freshMs: 0 })).toEqual(['new']);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps serving the old copy when a rebuild fails', async () => {
    const shared = store();
    let fail = false;
    const refresh = vi.fn(async () => {
      if (fail) throw new Error('supabase down');
      return ['old'];
    });

    await cachedSnapshot({ store: shared, key: 'list', refresh, freshMs: 0 });
    // The rebuild lock outlives the read window; pretend it has expired.
    await shared.del('list:rebuild');
    fail = true;

    expect(await cachedSnapshot({ store: shared, key: 'list', refresh, freshMs: 0, warn: () => {} })).toEqual([
      'old',
    ]);
  });

  it('drops a snapshot when it is invalidated', async () => {
    const shared = store();
    let value = ['old'];
    const refresh = vi.fn(async () => value);

    await cachedSnapshot({ store: shared, key: 'list', refresh });
    value = ['new'];
    await invalidateSnapshots(shared, ['list']);

    expect(await cachedSnapshot({ store: shared, key: 'list', refresh })).toEqual(['new']);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
