/**
 * Storage for Discover (`routes/discover.ts`): `recipe_index`, the searchable
 * copy of the extraction cache. Supabase / memory / unconfigured, the same
 * split as `community-db.ts`; the memory version mirrors the SQL triggers in
 * `supabase/005_discover.sql`.
 */

import { randomUUID } from 'node:crypto';

import { REPORT_HIDE_THRESHOLD } from './community-db.js';
import { createPostgrest, type PostgrestConfig } from './postgrest.js';
import {
  filterParams,
  matchesFilters,
  type FacetColumns,
  type RecipeFacets,
  type RecipeFilters,
} from './recipe-facets.js';
import type { ExtractedRecipe, SourcePlatform } from './types.js';

export interface IndexRow extends FacetColumns {
  canonical_key: string;
  id: string;
  source_url: string;
  source_platform: SourcePlatform;
  creator: string | null;
  image_url: string | null;
  servings: number | null;
  ingredients: string[];
  recipe: ExtractedRecipe;
  classified_at: string | null;
  save_count: number;
  report_count: number;
  hidden: boolean;
  created_at: string;
  updated_at: string;
}

/** What the indexer writes; ids, counters and moderation state are the db's. */
export type IndexUpsert = Omit<
  IndexRow,
  'id' | 'save_count' | 'report_count' | 'hidden' | 'created_at' | 'updated_at' | 'classified_at'
>;

/** Columns a list needs - never the full recipe, so steps can't leak via search. */
const LIST_COLUMNS =
  'id,canonical_key,source_url,source_platform,creator,title,image_url,category,servings,' +
  'calories,protein,carbs,fat,diet_tags,total_minutes,difficulty,save_count,created_at';

export type DiscoverSort = 'popular' | 'new';

export interface DiscoverQuery {
  filters: RecipeFilters;
  sort: DiscoverSort;
  offset: number;
  limit: number;
}

/** A list row: the full row minus the heavy/private fields. */
export type IndexListRow = Omit<
  IndexRow,
  'recipe' | 'ingredients' | 'search_text' | 'classified_at' | 'report_count' | 'hidden' | 'updated_at'
>;

export interface DiscoverDb {
  readonly configured: boolean;
  /**
   * Inserts or refreshes the recipe for a canonical key. Never touches facets,
   * counters or `hidden`: a re-extraction must not un-hide a pulled entry.
   */
  upsert(row: IndexUpsert): Promise<void>;
  search(query: DiscoverQuery): Promise<IndexListRow[]>;
  /** Visible or not - the route decides. */
  getById(id: string): Promise<IndexRow | null>;
  getByKey(canonicalKey: string): Promise<IndexRow | null>;
  setFacets(canonicalKey: string, facets: RecipeFacets): Promise<void>;
  setImage(canonicalKey: string, imageUrl: string | null): Promise<void>;
  /** Oldest unclassified rows first, for the classify sweep. */
  unclassified(limit: number): Promise<IndexRow[]>;
  /** Idempotent per device. */
  recordSave(id: string, saverHash: string): Promise<void>;
  insertReport(row: {
    target_id: string;
    reporter_hash: string;
    reason: string;
    note: string | null;
  }): Promise<'recorded' | 'duplicate'>;
}

// --- Supabase ---------------------------------------------------------------

export function createSupabaseDiscoverDb(config: PostgrestConfig, deps: { fetch?: typeof fetch } = {}): DiscoverDb {
  const db = createPostgrest(config, deps.fetch, 'discover db');
  const enc = encodeURIComponent;

  async function one(filter: string): Promise<IndexRow | null> {
    const rows = await db.request<IndexRow[]>(`recipe_index?select=*&${filter}&limit=1`);
    return rows[0] ?? null;
  }

  async function patch(canonicalKey: string, body: Record<string, unknown>): Promise<void> {
    await db.request(`recipe_index?canonical_key=eq.${enc(canonicalKey)}`, {
      method: 'PATCH',
      headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }),
    });
  }

  return {
    configured: db.configured,

    async upsert(row) {
      await db.request('recipe_index?on_conflict=canonical_key', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          ...row,
          // Facets are owned by the classify pass. Leaving them out of the
          // payload is what keeps an upsert from wiping them.
          diet_tags: undefined,
          total_minutes: undefined,
          difficulty: undefined,
          updated_at: new Date().toISOString(),
        }),
      });
    },

    async search(query) {
      const order = query.sort === 'popular' ? 'save_count.desc,created_at.desc' : 'created_at.desc';
      const params = ['hidden=is.false', ...filterParams(query.filters)];
      return db.request<IndexListRow[]>(
        `recipe_index?select=${LIST_COLUMNS}&${params.join('&')}&order=${order}` +
          `&offset=${query.offset}&limit=${query.limit}`,
      );
    },

    getById: (id) => one(`id=eq.${enc(id)}`),
    getByKey: (key) => one(`canonical_key=eq.${enc(key)}`),

    async setFacets(canonicalKey, facets) {
      await patch(canonicalKey, {
        diet_tags: facets.dietTags,
        total_minutes: facets.totalMinutes,
        difficulty: facets.difficulty,
        classified_at: new Date().toISOString(),
      });
    },

    async setImage(canonicalKey, imageUrl) {
      await patch(canonicalKey, { image_url: imageUrl });
    },

    async unclassified(limit) {
      return db.request<IndexRow[]>(
        `recipe_index?select=*&classified_at=is.null&hidden=is.false&order=created_at.asc&limit=${limit}`,
      );
    },

    async recordSave(id, saverHash) {
      await db.request('recipe_saves?on_conflict=target_type,target_id,saver_hash', {
        method: 'POST',
        headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify({ target_type: 'index', target_id: id, saver_hash: saverHash }),
      });
    },

    insertReport: (row) => db.insertReport({ ...row, target_type: 'recipe_index' }),
  };
}

// --- Memory -----------------------------------------------------------------

export function createMemoryDiscoverDb(): DiscoverDb & {
  admin: { rows(): IndexRow[]; hide(id: string): void };
} {
  const rows = new Map<string, IndexRow>(); // by canonical key
  const saves = new Set<string>(); // `${id}|${saver}`
  const reports = new Set<string>(); // `${id}|${reporter}`
  let last = 0;
  const now = () => {
    last = Math.max(Date.now(), last + 1);
    return new Date(last).toISOString();
  };
  const byId = (id: string) => [...rows.values()].find((row) => row.id === id);
  const copy = (row: IndexRow): IndexRow => structuredClone(row);

  return {
    configured: true,

    async upsert(row) {
      const existing = rows.get(row.canonical_key);
      const at = now();
      rows.set(row.canonical_key, {
        ...row,
        id: existing?.id ?? randomUUID(),
        diet_tags: existing?.diet_tags ?? [],
        total_minutes: existing?.total_minutes ?? null,
        difficulty: existing?.difficulty ?? null,
        classified_at: existing?.classified_at ?? null,
        save_count: existing?.save_count ?? 0,
        report_count: existing?.report_count ?? 0,
        hidden: existing?.hidden ?? false,
        created_at: existing?.created_at ?? at,
        updated_at: at,
      });
    },

    async search(query) {
      const matching = [...rows.values()].filter((row) => !row.hidden && matchesFilters(row, query.filters));
      matching.sort((a, b) => {
        if (query.sort === 'popular' && b.save_count !== a.save_count) return b.save_count - a.save_count;
        return b.created_at.localeCompare(a.created_at);
      });
      return matching.slice(query.offset, query.offset + query.limit).map((row) => {
        const { recipe: _r, ingredients: _i, search_text: _s, classified_at: _c, report_count: _rc, hidden: _h, updated_at: _u, ...list } =
          copy(row);
        return list;
      });
    },

    async getById(id) {
      const row = byId(id);
      return row ? copy(row) : null;
    },

    async getByKey(key) {
      const row = rows.get(key);
      return row ? copy(row) : null;
    },

    async setFacets(canonicalKey, facets) {
      const row = rows.get(canonicalKey);
      if (!row) return;
      row.diet_tags = facets.dietTags;
      row.total_minutes = facets.totalMinutes;
      row.difficulty = facets.difficulty;
      row.classified_at = now();
    },

    async setImage(canonicalKey, imageUrl) {
      const row = rows.get(canonicalKey);
      if (row) row.image_url = imageUrl;
    },

    async unclassified(limit) {
      return [...rows.values()]
        .filter((row) => row.classified_at === null && !row.hidden)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit)
        .map(copy);
    },

    async recordSave(id, saverHash) {
      saves.add(`${id}|${saverHash}`);
      const row = byId(id);
      if (row) row.save_count = [...saves].filter((key) => key.startsWith(`${id}|`)).length;
    },

    async insertReport(report) {
      const key = `${report.target_id}|${report.reporter_hash}`;
      if (reports.has(key)) return 'duplicate';
      reports.add(key);
      const row = byId(report.target_id);
      if (row) {
        row.report_count = [...reports].filter((r) => r.startsWith(`${report.target_id}|`)).length;
        row.hidden = row.hidden || row.report_count >= REPORT_HIDE_THRESHOLD;
      }
      return 'recorded';
    },

    admin: {
      rows: () => [...rows.values()].map(copy),
      hide(id) {
        const row = byId(id);
        if (row) row.hidden = true;
      },
    },
  };
}

export function createUnconfiguredDiscoverDb(): DiscoverDb {
  const refuse = async (): Promise<never> => {
    throw new Error('discover db is not configured');
  };
  return {
    configured: false,
    upsert: refuse,
    search: refuse,
    getById: refuse,
    getByKey: refuse,
    setFacets: refuse,
    setImage: refuse,
    unclassified: refuse,
    recordSave: refuse,
    insertReport: refuse,
  };
}
