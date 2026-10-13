/**
 * Minimal PostgREST client (plain `fetch`, service role) shared by the Discover
 * and recipe-feed stores. Same conventions as `community-db.ts`: errors throw,
 * nothing fails open.
 */

export interface PostgrestConfig {
  url: string;
  serviceRoleKey: string;
}

export interface Postgrest {
  readonly configured: boolean;
  request<T>(path: string, init?: RequestInit, okStatuses?: number[]): Promise<T>;
  /** Inserts into the shared `community_reports`; `duplicate` on the unique constraint. */
  insertReport(row: {
    target_type: string;
    target_id: string;
    reporter_hash: string;
    reason: string;
    note: string | null;
  }): Promise<'recorded' | 'duplicate'>;
}

export function createPostgrest(config: PostgrestConfig, fetchImpl: typeof fetch = fetch, label = 'db'): Postgrest {
  const base = config.url.replace(/\/$/, '');
  const configured = Boolean(base && config.serviceRoleKey);

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: config.serviceRoleKey,
    authorization: `Bearer ${config.serviceRoleKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
    ...extra,
  });

  return {
    configured,

    async request<T>(path: string, init: RequestInit = {}, ok: number[] = []): Promise<T> {
      const response = await fetchImpl(`${base}/rest/v1/${path}`, {
        ...init,
        headers: headers((init.headers as Record<string, string>) ?? {}),
      });
      if (!response.ok && !ok.includes(response.status)) {
        throw new Error(`${label}: ${init.method ?? 'GET'} ${path.split('?')[0]} -> ${response.status}`);
      }
      if (response.status === 204 || ok.includes(response.status)) return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    },

    async insertReport(row) {
      const response = await fetchImpl(`${base}/rest/v1/community_reports`, {
        method: 'POST',
        headers: headers({ prefer: 'return=minimal' }),
        body: JSON.stringify(row),
      });
      if (response.status === 409) return 'duplicate';
      if (!response.ok) throw new Error(`${label}: POST community_reports -> ${response.status}`);
      return 'recorded';
    },
  };
}

/** PostgREST `in.(...)` list. Values are hex hashes or uuids, but quote anyway. */
export function inList(values: string[]): string {
  return `(${values.map((v) => `"${v.replace(/["\\]/g, '')}"`).join(',')})`;
}
