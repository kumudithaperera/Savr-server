import type { Store } from './store.js';

/**
 * A shared snapshot of a public list's first page.
 *
 * Discover's two sections are the same for every caller (the only per-caller
 * parts are `isMine` and blocked authors, which the routes layer on afterwards),
 * so rebuilding them from Supabase for each device is avoidable work. The first
 * page of each default sort is stored once in the shared store and served until
 * it is `freshMs` old; after that exactly one request rebuilds it while the
 * others keep serving the old copy.
 *
 * Snapshots are deliberately short-lived - see `SNAPSHOT_FRESH_MS` - because
 * the lists carry counters and posts that should appear without much delay.
 */

/** How long a snapshot is served before it is rebuilt. */
export const SNAPSHOT_FRESH_MS = 5 * 60_000;

/** A snapshot nobody has read for this long is dropped by Redis. */
const SNAPSHOT_TTL_SECONDS = 60 * 60;

/**
 * One rebuild at a time across every instance. Long enough to cover a slow
 * Postgres query, short enough that a crashed rebuild isn't stuck for an hour.
 */
const REBUILD_LOCK_SECONDS = 60;

interface Snapshot<T> {
  value: T;
  fetchedAt: number;
}

export interface SnapshotOptions<T> {
  store: Store;
  /** Key in the shared store. One per list and sort. */
  key: string;
  /** Builds the value. Only called when the snapshot is missing or stale. */
  refresh: () => Promise<T>;
  /** Age at which the snapshot is rebuilt. Defaults to `SNAPSHOT_FRESH_MS`. */
  freshMs?: number;
  warn?: (message: string) => void;
}

async function rebuild<T>(store: Store, key: string, refresh: () => Promise<T>): Promise<T> {
  const value = await refresh();
  await store.setJson(key, { value, fetchedAt: Date.now() } satisfies Snapshot<T>, SNAPSHOT_TTL_SECONDS);
  return value;
}

/**
 * Reads a snapshot, rebuilding it when stale or missing.
 *
 * When a stale snapshot exists, only the request that wins the rebuild lock
 * waits for the new value; everyone else gets the old one immediately. That
 * bounds the database work to one query per window without putting a cliff in
 * front of every device when the window rolls over.
 */
export async function cachedSnapshot<T>({
  store,
  key,
  refresh,
  freshMs = SNAPSHOT_FRESH_MS,
  warn = console.warn,
}: SnapshotOptions<T>): Promise<T> {
  const entry = await store.getJson<Snapshot<T>>(key);
  if (entry && Date.now() - entry.fetchedAt < freshMs) return entry.value;

  const canRebuild = await store.setJsonIfAbsent(`${key}:rebuild`, Date.now(), REBUILD_LOCK_SECONDS);

  if (!entry) {
    // Nothing to serve: the first caller has to wait for a value.
    return rebuild(store, key, refresh);
  }

  if (!canRebuild) return entry.value;

  try {
    return await rebuild(store, key, refresh);
  } catch (err) {
    // Stale beats an error page; the lock expires and the next caller retries.
    warn(`[snapshot] ${key} rebuild failed, serving the previous copy: ${(err as Error).message}`);
    return entry.value;
  }
}

/**
 * Drops snapshots so the next reader rebuilds them - called after a write that
 * would otherwise take up to `freshMs` to show (a new share, an edit, a delete).
 */
export async function invalidateSnapshots(store: Store, keys: string[]): Promise<void> {
  await Promise.all(keys.map((key) => store.del(key)));
}
