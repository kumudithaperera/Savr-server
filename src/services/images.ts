/**
 * Pexels photo search, moved here from the app for the same reason as the USDA
 * lookup (see `nutrition.ts`): an `EXPO_PUBLIC_*` key is inlined into the JS
 * bundle and extractable from the APK, so anyone could lift it and burn the
 * quota. Server-side, the key stays a secret and the route inherits the
 * shared-secret + per-IP guardrail.
 *
 * Best-effort by design: any failure resolves to null so a recipe still saves
 * without a photo, matching how the app has always treated image backfill.
 */

const PEXELS_SEARCH = 'https://api.pexels.com/v1/search';

interface PexelsPhoto {
  src?: { large?: string; medium?: string; original?: string };
}

export interface PhotoSearch {
  /** URL of the best-matching food photo, or null when there isn't one. */
  search(query: string): Promise<string | null>;
}

/**
 * Builds the search. An empty `pexelsApiKey` disables it (every call resolves to
 * null), which is what happens today in production - set the key to turn recipe
 * photo backfill back on.
 */
export function createPexelsPhotoSearch(deps: { pexelsApiKey: string }): PhotoSearch {
  const apiKey = deps.pexelsApiKey.trim();

  return {
    async search(query: string): Promise<string | null> {
      const clean = query.trim();
      if (!apiKey || !clean) return null;

      const url =
        `${PEXELS_SEARCH}?query=${encodeURIComponent(`${clean} food`)}` +
        `&per_page=1&orientation=landscape`;

      try {
        const response = await fetch(url, { headers: { Authorization: apiKey } });
        if (!response.ok) return null;
        const body = (await response.json()) as { photos?: PexelsPhoto[] };
        const src = body.photos?.[0]?.src;
        return src?.large ?? src?.medium ?? src?.original ?? null;
      } catch {
        return null;
      }
    },
  };
}
