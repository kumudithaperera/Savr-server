import { afterEach, describe, expect, it, vi } from 'vitest';

import { createStore } from './store.js';

const upstash = { upstashUrl: 'https://example.upstash.io', upstashToken: 'token' };

describe('Upstash store during an outage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function downStore() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    return createStore(upstash, () => {});
  }

  it('keeps counting in-process instead of returning zero', async () => {
    const store = downStore();
    expect(await store.incrWithTtl('rl:ip:1.2.3.4:1', 60)).toBe(1);
    expect(await store.incrWithTtl('rl:ip:1.2.3.4:1', 60)).toBe(2);
    expect(await store.incrWithTtl('rl:ip:1.2.3.4:1', 60)).toBe(3);
  });

  it('lets a key be claimed only once per instance', async () => {
    const store = downStore();
    expect(await store.setJsonIfAbsent('redeem:CODE', { device: 'a' })).toBe(true);
    expect(await store.setJsonIfAbsent('redeem:CODE', { device: 'b' })).toBe(false);
  });

  it('still treats reads as a miss', async () => {
    const store = downStore();
    expect(await store.getJson('cache:x')).toBeNull();
  });
});
